/**
 * The reaper — the dev processes nobody owns any more.
 *
 * `listServers` sweeps registrations whose pid is gone; nothing swept the
 * other way round, processes nobody had registered. On 2026-09-26 this 8 GB
 * machine held a static-server six days old, another four days old whose
 * registration had been swept, and an esbuild `--service` four days old with
 * ppid 1, with swap at 6.8–8.2 GB. This is the one place mc signals a process
 * itself, and only one the three rules in `reapPlan` prove orphaned — never a
 * process with a live parent other than pid 1, never a registered server
 * whose worktree still exists (`docs/dev-server-protocol.md` § Safety
 * contract).
 *
 * `reapPlan` is pure: the rules are tested on text, with no process anywhere.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';

import { listServers, registeredPath } from './dev-servers.js';
import { log } from './logger.js';
import { devServersRoot } from './paths.js';
import { pidAlive } from './status-collect.js';

/** mc starts a server detached — ppid 1 from its first second — and it has up to 180 s to register. */
export const DEFAULT_MIN_AGE_SECONDS = 600;
/** esbuild and workerd never outlive their node parent on purpose. */
export const HELPER_MIN_AGE_SECONDS = 120;
const STOP_WAIT_MS = 5_000;

const SERVER = /\bnode\b.*\bscripts\/(testing\/static-server|testing\/measure-server|dev)\.mjs\b/u;
const ESBUILD = /\/@esbuild\/[^/]+\/bin\/esbuild --service/u;
const WORKERD = /\/workerd-[^/]+\/bin\/workerd serve\b/u;

/** `ps` `etime` — `[[dd-]hh:]mm:ss` — in seconds; null for anything else. */
export function etimeSeconds(etime) {
  const match = /^(?:(?:(\d+)-)?(\d+):)?(\d+):(\d+)$/u.exec(String(etime).trim());
  if (!match) return null;
  const [, days = 0, hours = 0, minutes, seconds] = match;
  return ((Number(days) * 24 + Number(hours)) * 60 + Number(minutes)) * 60 + Number(seconds);
}

/** `ps -axo pid=,ppid=,etime=,command=` as `[{ pid, ppid, age_s, command }]`. */
export function parsePs(text) {
  const processes = [];
  for (const line of String(text).split('\n')) {
    const match = /^\s*(\d+)\s+(\d+)\s+(\S+)\s+(.*)$/u.exec(line);
    if (!match) continue;
    const age = etimeSeconds(match[3]);
    if (age === null) continue;
    processes.push({ pid: Number(match[1]), ppid: Number(match[2]), age_s: age, command: match[4] });
  }
  return processes;
}

/**
 * What the three rules prove orphaned, and nothing else.
 *
 * (1) an unregistered static-server, measure-server or `scripts/dev.mjs` with
 *     ppid 1, at least `minAgeSeconds` old; (2) an esbuild service or a
 *     workerd with ppid 1, at least 120 s old — both only ever run under a
 *     node parent that is now gone; (3) a registration whose worktree is gone.
 */
export function reapPlan({ processes, servers, now: _now, exists, minAgeSeconds = DEFAULT_MIN_AGE_SECONDS }) {
  const registered = new Set(servers.map((server) => Number(server.pid)));
  const plan = [];
  for (const proc of processes) {
    if (proc.ppid !== 1) continue;
    const server = SERVER.exec(proc.command);
    if (server && proc.age_s >= minAgeSeconds && !registered.has(proc.pid)) {
      plan.push({ pid: proc.pid, kind: 'server', why: `orphaned ${server[1].replace('testing/', '')}`, age_s: proc.age_s, command: proc.command });
      continue;
    }
    if (proc.age_s < HELPER_MIN_AGE_SECONDS) continue;
    const helper = ESBUILD.test(proc.command) ? 'esbuild' : WORKERD.test(proc.command) ? 'workerd' : null;
    if (helper) plan.push({ pid: proc.pid, kind: helper, why: `orphaned ${helper}`, age_s: proc.age_s, command: proc.command });
  }
  const byPid = new Map(processes.map((proc) => [proc.pid, proc]));
  for (const server of servers) {
    if (!server.worktree_path || exists(server.worktree_path)) continue;
    const proc = byPid.get(Number(server.pid));
    plan.push({
      pid: Number(server.pid) || null,
      instance_id: server.instance_id,
      kind: 'registration',
      why: 'worktree gone',
      age_s: proc?.age_s ?? null,
      command: proc?.command ?? null,
    });
  }
  return plan;
}

/** The first 80 characters, home as `~` — paths and names only, as `logger.js` requires. */
export function commandHead(command, home = homedir()) {
  if (!command) return null;
  return (home ? command.split(home).join('~') : command).slice(0, 80);
}

function psProcesses() {
  const result = spawnSync('ps', ['-axo', 'pid=,ppid=,etime=,command='], { encoding: 'utf8' });
  if (result.status !== 0) throw new Error(`ps exited ${result.status}`);
  return parsePs(result.stdout);
}

/** SIGTERM, up to 5 s for it to go, then SIGKILL. True when it is gone. */
async function terminate(pid, { alive, signal, sleep, waitMs = STOP_WAIT_MS }) {
  if (!alive(pid)) return true;
  try { signal(pid, 'SIGTERM'); } catch { return !alive(pid); }
  for (let waited = 0; waited < waitMs; waited += 100) {
    if (!alive(pid)) return true;
    await sleep(100);
  }
  try { signal(pid, 'SIGKILL'); } catch { /* gone between the test and the kill */ }
  await sleep(100);
  return !alive(pid);
}

/**
 * Build the plan from live `ps` and the registry, and act on it unless
 * `dryRun`. Returns every entry with `done` (what happened to it).
 */
export async function reap({ dryRun = false, minAgeSeconds = DEFAULT_MIN_AGE_SECONDS, deps = {} } = {}) {
  const root = deps.root || devServersRoot();
  const alive = deps.alive || pidAlive;
  const signal = deps.signal || ((pid, sig) => process.kill(pid, sig));
  const sleep = deps.sleep || ((ms) => new Promise((done) => { setTimeout(done, ms); }));
  const unregister = deps.unregister || ((instanceId) => rmSync(registeredPath(instanceId, root), { force: true }));
  const plan = reapPlan({
    processes: (deps.processes || psProcesses)(),
    servers: (deps.servers || (() => listServers({ root, reap: false }).servers))(),
    now: (deps.now || (() => new Date()))(),
    exists: deps.exists || existsSync,
    minAgeSeconds,
  });
  if (dryRun) return plan.map((entry) => ({ ...entry, done: 'would-reap' }));

  const results = [];
  for (const entry of plan) {
    let gone = entry.pid ? await terminate(entry.pid, { alive, signal, sleep }) : true;
    if (entry.kind === 'registration') {
      try { unregister(entry.instance_id); } catch { gone = false; }
    }
    const done = gone ? 'reaped' : 'still-running';
    log('dev-server-reaped', {
      kind: entry.kind,
      pid: entry.pid,
      instance_id: entry.instance_id || null,
      age_s: entry.age_s,
      command_head: commandHead(entry.command),
      ok: gone,
    });
    results.push({ ...entry, done });
  }
  return results;
}

/** `6d`, `4h`, `12m`, `45s` — the largest whole unit. */
export function ageText(seconds) {
  if (seconds === null || seconds === undefined) return 'age unknown';
  if (seconds >= 86_400) return `${Math.floor(seconds / 86_400)}d`;
  if (seconds >= 3_600) return `${Math.floor(seconds / 3_600)}h`;
  if (seconds >= 60) return `${Math.floor(seconds / 60)}m`;
  return `${seconds}s`;
}
