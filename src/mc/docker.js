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
import { listServers } from './dev-servers.js';
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

const DF_TYPES = new Map([
  ['Images', 'images'], ['Containers', 'containers'], ['Local Volumes', 'volumes'], ['Build Cache', 'build_cache'],
]);

/** The pid in a `Labels` string (`k=v,k=v`) under `mc.holder`, or null. */
function holderOf(labels) {
  const match = /(?:^|,)mc\.holder=(\d+)(?:,|$)/u.exec(String(labels ?? ''));
  return match ? Number(match[1]) : null;
}

/** One `docker … --format '{{json .}}'` call as its lines, or null with the reason in `errors`. */
async function jsonLines(m, args, what, errors) {
  const result = await m.run('docker', args, { timeoutMs: CALL_TIMEOUT_MS });
  if (result?.status !== 0) {
    errors.push(`${what}: ${failure(result)}`);
    return null;
  }
  try {
    return String(result.stdout ?? '').split('\n').map((line) => line.trim()).filter(Boolean).map((line) => JSON.parse(line));
  } catch (error) {
    errors.push(`${what}: ${error.message}`);
    return null;
  }
}

/** `docker system df` rows as `{ images, containers, volumes, build_cache }`. */
function diskUsage(rows) {
  const df = {
    images: { count: 0, size: '0B' }, containers: { count: 0, size: '0B' }, volumes: { count: 0, size: '0B' }, build_cache: { size: '0B' },
  };
  for (const row of rows) {
    const key = DF_TYPES.get(row.Type);
    if (key === 'build_cache') df.build_cache = { size: String(row.Size) };
    else if (key) df[key] = { count: Number(row.TotalCount), size: String(row.Size) };
  }
  return df;
}

/**
 * What the runtime holds: disk by `docker system df`, containers by `docker ps
 * -a`, volumes by `docker volume ls`. Call it only while the runtime is up. A
 * call that fails or times out leaves its part empty and says why in `errors`;
 * the rest still comes back. An object without an `mc.holder` label is listed,
 * never judged.
 */
export async function inventory({ io = {} } = {}) {
  const m = { ...SYSTEM, ...io };
  const errors = [];
  const df = await jsonLines(m, ['system', 'df', '--format', '{{json .}}'], 'docker system df', errors);
  const containers = await jsonLines(m, ['ps', '-a', '--format', '{{json .}}'], 'docker ps -a', errors);
  const volumes = await jsonLines(m, ['volume', 'ls', '--format', '{{json .}}'], 'docker volume ls', errors);
  return {
    df: df ? diskUsage(df) : null,
    containers: (containers ?? []).map((c) => ({
      id: c.ID, name: c.Names, state: c.State, holder: holderOf(c.Labels),
    })),
    volumes: (volumes ?? []).map((v) => ({ name: v.Name, holder: holderOf(v.Labels) })),
    errors,
  };
}

/**
 * Remove what a holder left behind: containers (with their volumes) and volumes
 * labelled `mc.holder=<pid>` whose pid is not alive. Nothing unlabelled is ever
 * passed to `rm`. `dead` names what that is; `removed` names what was removed,
 * and is empty on a dry run.
 */
export async function removeDeadHolders({ dryRun = false, io = {} } = {}) {
  const m = { ...SYSTEM, ...io };
  const inv = await inventory({ io });
  const deadContainers = inv.containers.filter((c) => Number.isInteger(c.holder) && !m.alive(c.holder));
  const deadVolumes = inv.volumes.filter((v) => Number.isInteger(v.holder) && !m.alive(v.holder));
  const removed = { containers: [], volumes: [] };
  const failed = [];
  if (!dryRun) {
    for (const c of deadContainers) {
      const result = await m.run('docker', ['rm', '--force', '--volumes', c.id], { timeoutMs: CALL_TIMEOUT_MS });
      if (result?.status === 0) removed.containers.push(c.name);
      else failed.push({ name: c.name, reason: failure(result) });
    }
    for (const v of deadVolumes) {
      const result = await m.run('docker', ['volume', 'rm', v.name], { timeoutMs: CALL_TIMEOUT_MS });
      if (result?.status === 0) removed.volumes.push(v.name);
      else failed.push({ name: v.name, reason: failure(result) });
    }
  }
  const unlabelled = (items) => items.filter((x) => !Number.isInteger(x.holder));
  return {
    removed,
    dead: { containers: deadContainers.map((c) => c.name), volumes: deadVolumes.map((v) => v.name) },
    failed,
    errors: inv.errors,
    unlabelled: {
      containers: unlabelled(inv.containers).length,
      volumes: unlabelled(inv.volumes).length,
      running: unlabelled(inv.containers).filter((c) => c.state === 'running').length,
    },
    df: inv.df,
  };
}

/**
 * How old an image must be before `mc tidy` prunes it. Martin, 2026-10-19:
 * images older than a few days, in `mc tidy`. Three days, so what this week's
 * deploys and dev servers built stays.
 *
 * The build cache is not pruned. Martin, 2026-10-25: with it pruned, every
 * deploy rebuilt the avatar-motion image from nothing, its 1.45 GB of torch,
 * pip and LivePortrait layers came out with new digests (measured: 075fa9e7
 * against 928242af, all four), and each push to registry.cloudflare.com ran
 * for most of an hour and then timed out.
 */
export const TIDY_KEEP_FILTER = 'until=72h';
/** One prune: Docker walks every layer, which takes longer than a status call. */
export const PRUNE_TIMEOUT_MS = 5 * 60_000;

const PRUNES = [
  { what: 'images', args: ['image', 'prune', '--all', '--force', '--filter', TIDY_KEEP_FILTER] },
];

/** `Total reclaimed space: 1.2GB`. */
function reclaimedOf(text) {
  return /Total reclaimed space:\s*(\S+)/u.exec(String(text ?? ''))?.[1] ?? null;
}

/**
 * `mc tidy`'s Docker half: images unused for three days.
 * Docker itself never prunes an image a container uses, so a running gate or
 * dev server keeps its own.
 *
 * Without `apply` it prunes nothing and reports `docker system df`'s
 * reclaimable sizes — an upper bound, since those ignore the three days. A
 * runtime that is down is never started here, apply or not: on OrbStack the
 * prune would itself start the VM. `start` is `ensure` for a person who asked
 * for Docker by name (`mc tidy --docker --apply`); its lease is released
 * before this resolves. Resolves `{ up, runtime, apply, reclaimable, pruned,
 * reason }` and never throws.
 */
export async function tidyDocker({
  apply = false, start = null, root = mcHome(), env = process.env, io = {},
} = {}) {
  const m = { ...SYSTEM, ...io };
  const rt = await runtimeOf({ env, io });
  const answer = { up: rt.up, runtime: rt, apply, reclaimable: null, pruned: [], reason: null };
  let lease = null;
  if (!rt.up) {
    if (!apply || !start) return { ...answer, reason: `${rt.kind} is not running${rt.reason ? ` — ${rt.reason}` : ''}` };
    const ensured = await ensure({ ...start, root, env, io });
    if (!ensured.ok) return { ...answer, reason: `could not be started — ${ensured.reason}` };
    lease = ensured.lease;
    answer.up = true;
  }
  try {
    if (!apply) {
      const errors = [];
      const rows = await jsonLines(m, ['system', 'df', '--format', '{{json .}}'], 'docker system df', errors);
      if (!rows) return { ...answer, reason: errors.join('; ') };
      const of = (type) => String(rows.find((row) => row.Type === type)?.Reclaimable ?? '0B');
      return { ...answer, reclaimable: { images: of('Images') } };
    }
    for (const { what, args } of PRUNES) {
      const result = await m.run('docker', args, { timeoutMs: PRUNE_TIMEOUT_MS });
      const said = `${result?.stdout ?? ''}${result?.stderr ?? ''}`;
      answer.pruned.push(result?.status === 0
        ? { what, ok: true, reclaimed: reclaimedOf(said), detail: null }
        : { what, ok: false, reclaimed: null, detail: failure(result) });
    }
    m.log('docker-tidy', { pruned: answer.pruned.map(({ what, ok, reclaimed }) => ({ what, ok, reclaimed })) });
    return answer;
  } catch (error) {
    return { ...answer, reason: String(error?.message || error) };
  } finally {
    if (lease) release(lease, { root, io });
  }
}

/**
 * The runner's chore pass (`chores()`, `run.js`): leases whose pid is gone,
 * labelled leftovers of a dead holder, and the idle stop. While the runtime is
 * down only `orbctl status` runs — a `docker` call would start the VM this is
 * trying to keep off. The idle stop stops only an OrbStack `ensure` started,
 * `IDLE_GRACE_MS` after the last release, and never while a lease is alive, a
 * dev server is alive (wrangler's sandboxes run in Docker too) or an
 * unlabelled container is running. Resolves `{ up, swept, removed, stopped,
 * line }`; `line` is null when nothing happened.
 */
export async function sweepDocker({ root = mcHome(), env = process.env, io = {}, servers = () => listServers().servers } = {}) {
  const m = { ...SYSTEM, ...io };
  const { leases, swept } = liveLeases({ root, io });
  const leaseRows = leases.map(({ path: _path, ...lease }) => lease);
  const rt = await runtimeOf({ env, io });
  if (!rt.up) {
    writeState({ runtime: rt, leases: leaseRows, started_by_mc: false, idle_stop: null }, { root, io });
    return {
      up: false, swept, removed: null, stopped: false, line: swept.length ? `docker: swept ${swept.length} lease(s) whose pid is gone` : null,
    };
  }

  const pruned = await removeDeadHolders({ io });
  const state = readState({ root }) || {};
  const liveServers = servers().filter((s) => s.live !== false);
  const idle = leases.length === 0 && liveServers.length === 0 && pruned.unlabelled.running === 0;
  const ours = rt.kind === 'orbstack' && state.started_by_mc === true && Boolean(state.last_release_at);
  const releasedAt = ours ? Date.parse(state.last_release_at) : Number.NaN;
  const idleMs = m.now() - releasedAt;

  const parts = [];
  if (swept.length) parts.push(`swept ${swept.length} lease(s) whose pid is gone`);
  const { containers, volumes } = pruned.removed;
  if (containers.length || volumes.length) {
    parts.push(`removed ${containers.length} container(s) and ${volumes.length} volume(s) labelled by a holder that is gone`);
  }

  let stopped = false;
  let stopFailed = null;
  if (idle && ours && idleMs >= IDLE_GRACE_MS) {
    const result = await m.run('orbctl', ['stop'], { timeoutMs: CALL_TIMEOUT_MS });
    if (result?.status === 0) {
      writeState({ runtime: { ...rt, up: false }, leases: [], started_by_mc: false, idle_stop: null }, { root, io });
      m.log('docker-idle-stop', { idle_ms: idleMs });
      stopped = true;
      parts.push(`idle ${Math.round(idleMs / 60000)} min with no lease, no dev server and no unlabelled container running — orbctl stop`);
    } else {
      stopFailed = `docker: orbctl stop failed — ${failure(result)}`;
    }
  }
  if (!stopped) {
    writeState({
      runtime: rt,
      leases: leaseRows,
      inventory: { df: pruned.df, unlabelled: pruned.unlabelled },
      idle_stop: idle && ours && Number.isFinite(releasedAt) ? new Date(releasedAt + IDLE_GRACE_MS).toISOString() : null,
    }, { root, io });
  }
  return {
    up: !stopped, swept, removed: pruned.removed, stopped, line: stopFailed ?? (parts.length ? `docker: ${parts.join(' · ')}` : null),
  };
}
