/**
 * `~/.memoro/mc/docker/` — the container runtime the gates need, held the way
 * dev servers are (`dev-servers.js`).
 *
 * On 2026-10-18 memoro's `sql:reference:postgres` exited 69 ('no Docker
 * daemon') in 2.7 s, in two merge rounds, because OrbStack was installed but
 * `Stopped`. Nothing in mc started the runtime or knew who was using it. This
 * module is both halves: `ensure` starts it and waits until `docker info`
 * answers, and whoever asked for it holds a lease until it says it is done.
 *
 * - **One lease file per holder.** `leases/<pid>-<id>.json` names a pid, and a
 *   holder releases by removing its own file — no shared file to lock.
 * - **A dead holder's file is removed by whoever reads it next**, and that
 *   counts as a release: a gate that was killed has stopped using the runtime.
 * - **Every `docker` and `orbctl` call has a timeout.** A wedged VM must not
 *   hold a merge round.
 *
 * While the runtime is down, nothing here runs the `docker` CLI except
 * `ensure`: on OrbStack a `docker` call starts the VM, so asking "is it up?"
 * that way would answer yes by making it so. `runtimeOf` reads `orbctl status`
 * for an OrbStack context, and `currentContext` reads the environment and the
 * Docker config file without running anything.
 *
 * The machine is injectable (`io`), as in `dev-servers.js` and
 * `commands/gate.js`, so every rule here is tested without a runtime.
 */
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { writeJsonAtomic } from './atomic-write.js';
import { runTool } from './child-async.js';
import { log } from './logger.js';
import { mcHome } from './paths.js';
import { pidAlive } from './status-collect.js';

export const DOCKER_SCHEMA = 'mc-docker';
export const DOCKER_VERSION = 1;

/** Any `docker` or `orbctl` call. */
export const CALL_TIMEOUT_MS = 20_000;
/** One `docker info`. */
export const PROBE_TIMEOUT_MS = 10_000;
/** `orbctl start` or `open -a Docker`. */
export const START_TIMEOUT_MS = 60_000;
/** The whole wait for `docker info` to answer. */
export const ENSURE_TIMEOUT_MS = 60_000;
export const ENSURE_POLL_MS = 1_000;
/** How long a runtime mc started stays up with nobody holding it. */
export const IDLE_GRACE_MS = 600_000;

export const ORBSTACK_CONTEXT = 'orbstack';
export const DESKTOP_CONTEXT = 'desktop-linux';

const INFO_ARGS = ['info', '--format', '{{.ServerVersion}}'];

export function dockerRoot(root = mcHome()) { return join(root, 'docker'); }
export function leasesDir(root = mcHome()) { return join(dockerRoot(root), 'leases'); }
export function statePath(root = mcHome()) { return join(dockerRoot(root), 'state.json'); }

const SYSTEM = {
  run: (tool, args, { timeoutMs }) => runTool(tool, args, { timeoutMs }),
  readFile: (path) => readFileSync(path, 'utf8'),
  alive: pidAlive,
  now: () => Date.now(),
  sleep: (ms) => new Promise((done) => { setTimeout(done, ms); }),
  home: homedir(),
  platform: process.platform,
  log,
};

function lastLine(value) {
  const lines = String(value ?? '').split('\n').map((line) => line.trim()).filter(Boolean);
  return lines.at(-1) ?? '';
}

/** What a failed call says about itself: its last stderr line, else its error code. */
function failure(result) {
  return lastLine(result?.stderr) || result?.error?.code || (result?.signal ? `killed by ${result.signal}` : `exit ${result?.status}`);
}

function nowIso(m) {
  return new Date(m.now()).toISOString();
}

/** A selector command entry (memoro's `ci.mjs --list --json` `commands[]`) that needs a runtime. */
export function needsDocker(entry) { return Array.isArray(entry?.needs) && entry.needs.map(String).includes('docker'); }

/** The Docker context the CLI would use, read without running anything. */
export function currentContext({ env = process.env, io = {} } = {}) {
  const m = { ...SYSTEM, ...io };
  if (env.DOCKER_CONTEXT) return env.DOCKER_CONTEXT;
  if (env.DOCKER_HOST) return 'DOCKER_HOST';
  try {
    const config = JSON.parse(m.readFile(join(m.home, '.docker', 'config.json')));
    return typeof config?.currentContext === 'string' && config.currentContext ? config.currentContext : 'default';
  } catch {
    return 'default';
  }
}

/**
 * `{ kind, context, up, reason }`. For OrbStack only `orbctl status` is asked,
 * because a `docker` call would start the VM. Docker Desktop does not start
 * itself on a CLI call, so any other context is probed with `docker info`.
 */
export async function runtimeOf({ env = process.env, io = {} } = {}) {
  const m = { ...SYSTEM, ...io };
  const context = currentContext({ env, io });
  if (context === ORBSTACK_CONTEXT) {
    const result = await m.run('orbctl', ['status'], { timeoutMs: CALL_TIMEOUT_MS });
    const answer = String(result?.stdout ?? '').trim();
    if (result?.status === 0 && answer === 'Running') return { kind: 'orbstack', context, up: true, reason: null };
    if (result?.status === 0 && answer === 'Stopped') return { kind: 'orbstack', context, up: false, reason: null };
    const said = lastLine(result?.stderr) || answer || result?.error?.code || `exit ${result?.status}`;
    return { kind: 'orbstack', context, up: false, reason: `orbctl status: ${said}` };
  }
  const kind = context === DESKTOP_CONTEXT ? 'desktop' : 'other';
  const result = await m.run('docker', INFO_ARGS, { timeoutMs: PROBE_TIMEOUT_MS });
  if (result?.error?.code === 'ENOENT') return { kind: 'none', context, up: false, reason: 'docker is not installed' };
  if (result?.status === 0) return { kind, context, up: true, reason: null };
  return { kind, context, up: false, reason: failure(result) };
}

/** One lease file for `pid`; the holder releases by removing it. */
export function takeLease({ pid, run = null, repo = null, root = mcHome(), io = {} } = {}) {
  const m = { ...SYSTEM, ...io };
  if (!Number.isInteger(pid) || pid <= 0) throw new TypeError(`a docker lease needs a positive integer pid, not ${JSON.stringify(pid)}`);
  const dir = leasesDir(root);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const path = join(dir, `${pid}-${randomUUID().slice(0, 8)}.json`);
  const lease = {
    schema: DOCKER_SCHEMA,
    version: DOCKER_VERSION,
    pid,
    run: run == null ? null : String(run),
    repo: repo == null ? null : String(repo),
    since: nowIso(m),
  };
  writeJsonAtomic(path, lease, { mode: 0o600 });
  return { path, lease };
}

/**
 * The leases whose pid is alive, oldest first. A lease whose pid is dead is
 * removed here and listed in `swept`: its holder has released by dying. A
 * file that will not parse is not this reader's to judge, and is left alone.
 */
export function liveLeases({ root = mcHome(), io = {} } = {}) {
  const m = { ...SYSTEM, ...io };
  const dir = leasesDir(root);
  let names;
  try {
    names = readdirSync(dir).filter((name) => name.endsWith('.json'));
  } catch {
    return { leases: [], swept: [] };
  }
  const leases = [];
  const swept = [];
  for (const name of names) {
    const path = join(dir, name);
    let value;
    try { value = JSON.parse(readFileSync(path, 'utf8')); } catch { continue; }
    if (!Number.isInteger(value?.pid)) continue;
    const { pid } = value;
    const run = value.run ?? null;
    const repo = value.repo ?? null;
    const since = value.since ?? null;
    if (m.alive(pid)) {
      leases.push({ path, pid, run, repo, since });
      continue;
    }
    rmSync(path, { force: true });
    m.log('docker-lease-gone', { pid, run, repo, since });
    swept.push({ pid, run, repo });
  }
  leases.sort((a, b) => String(a.since ?? '').localeCompare(String(b.since ?? '')));
  if (swept.length) writeState({ last_release_at: nowIso(m) }, { root, io });
  return { leases, swept };
}

/** Remove one lease file. True when it existed. */
export function release(path, { root = mcHome(), io = {} } = {}) {
  const m = { ...SYSTEM, ...io };
  if (!path || !existsSync(path)) return false;
  rmSync(path, { force: true });
  writeState({ last_release_at: nowIso(m) }, { root, io });
  m.log('docker-released', { path });
  return true;
}

/** Release every live lease `pid` holds; how many it released. */
export function releasePid(pid, { root = mcHome(), io = {} } = {}) {
  const want = Number(pid);
  let released = 0;
  for (const lease of liveLeases({ root, io }).leases) {
    if (lease.pid === want && release(lease.path, { root, io })) released += 1;
  }
  return released;
}

/** `state.json`, or null when it is missing or will not parse. */
export function readState({ root = mcHome() } = {}) {
  try {
    return JSON.parse(readFileSync(statePath(root), 'utf8'));
  } catch {
    return null;
  }
}

/**
 * Merge `fields` onto `state.json`. The keys later readers rely on: `runtime`,
 * `leases`, `started_by_mc`, `last_release_at`, `inventory`, `idle_stop`.
 * Never throws — a state file that cannot be written is null, not a failed gate.
 */
export function writeState(fields, { root = mcHome(), io = {} } = {}) {
  const m = { ...SYSTEM, ...io };
  try {
    const current = readState({ root });
    const next = {
      ...(current && typeof current === 'object' && !Array.isArray(current) ? current : {}),
      ...fields,
      schema: DOCKER_SCHEMA,
      version: DOCKER_VERSION,
      at: nowIso(m),
    };
    writeJsonAtomic(statePath(root), next, { mode: 0o600 });
    return next;
  } catch {
    return null;
  }
}

/**
 * Start the runtime when it is down, wait until `docker info` answers, and
 * take a lease for `pid`. Resolves `{ ok, started, waited_ms, server, lease,
 * reason }` and takes no lease when it gives up.
 */
export async function ensure({
  pid, run = null, repo = null, timeoutMs = ENSURE_TIMEOUT_MS, root = mcHome(), env = process.env, io = {},
} = {}) {
  const m = { ...SYSTEM, ...io };
  if (!Number.isInteger(pid) || pid <= 0) throw new TypeError(`a docker lease needs a positive integer pid, not ${JSON.stringify(pid)}`);
  const began = m.now();
  let started = false;
  const fail = (reason) => {
    const waited_ms = m.now() - began;
    m.log('docker-ensure-failed', { pid, run, repo, started, waited_ms, reason });
    return { ok: false, started, waited_ms, server: null, lease: null, reason };
  };

  const rt = await runtimeOf({ env, io });
  if (!rt.up) {
    if (rt.kind === 'none') return fail(rt.reason);
    if (rt.kind === 'other') {
      return fail(`context ${rt.context} is not one mc can start — only ${ORBSTACK_CONTEXT} and ${DESKTOP_CONTEXT} are`);
    }
    const start = rt.kind === 'orbstack'
      ? { tool: 'orbctl', args: ['start'], label: 'orbctl start' }
      : (m.platform === 'darwin' ? { tool: 'open', args: ['-a', 'Docker'], label: 'open -a Docker' } : null);
    if (start) {
      const result = await m.run(start.tool, start.args, { timeoutMs: START_TIMEOUT_MS });
      started = true;
      if (result?.status !== 0) return fail(`${start.label} failed: ${failure(result)}`);
    }
  }

  const polling = m.now();
  let info;
  for (;;) {
    info = await m.run('docker', INFO_ARGS, { timeoutMs: PROBE_TIMEOUT_MS });
    if (info?.status === 0) break;
    if (m.now() - polling >= timeoutMs) {
      return fail(`docker info did not answer within ${Math.round(timeoutMs / 1000)} s: ${failure(info)}`);
    }
    await m.sleep(ENSURE_POLL_MS);
  }

  const { path } = takeLease({ pid, run, repo, root, io });
  const waited_ms = m.now() - began;
  writeState({
    runtime: { kind: rt.kind, context: rt.context, up: true, reason: null },
    leases: liveLeases({ root, io }).leases.map(({ path: _path, ...lease }) => lease),
    ...(started ? { started_by_mc: true } : {}),
  }, { root, io });
  m.log('docker-ensured', { pid, run, repo, started, waited_ms });
  return { ok: true, started, waited_ms, server: String(info.stdout ?? '').trim(), lease: path, reason: null };
}
