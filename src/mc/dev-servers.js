/**
 * `~/.memoro/mc/dev-servers/` — which dev server is running in which worktree.
 *
 * This is the cross-worktree inventory `mc-cut` removed on 2026-09-03 (#561),
 * back because it now has a reader. That distinction is the whole of the
 * argument, and the measurement that says so is `mc-dev-1`: in the month
 * `mc.log` covers, `mc dev` ran 565 times and **ten** of those were a person.
 * The other 555 were memoro's wrapper registering and unregistering into an
 * index nothing ever asked a question of. The decision file's own closing line
 * was *"if that need comes back it comes back with a person behind it"* — and
 * `mc test dev` is that person's verb. An index with one honest consumer is a
 * different object from an index with none, however identical the files look.
 *
 * Two things the old one did not do, and their absence is why it read as dead:
 *
 * - **Nothing reaped it.** It held 33 manifests when it was measured, the
 *   oldest from 2026-07-26, and not one had a live pid. `list` here sweeps
 *   what it reads, so the answer to "what is running" cannot be a list of
 *   things that are not. A registration whose pid is gone is not a server.
 * - **Nothing read it.** Fixed elsewhere, by `mc test dev`; named here because
 *   the next person to measure this directory should find the reason in the
 *   file rather than reconstruct it from a project log.
 *
 * The contract is not this module's to design. memoro's wrapper has spoken it
 * since 2026-08-29 and is not being changed to suit mc: `invokeMcDev`
 * (`scripts/lib/mc-dev-service.mjs`) probes with `mc dev list --json`, then
 * calls `mc dev <verb> <manifestPath> --json`. `docs/dev-server-protocol.md`
 * is the specification and it outlived the verb; the shape of a registered
 * file is `buildMcDevManifest`'s, read from the writer rather than from the
 * implementation that was deleted.
 *
 * Everything here is pure over the filesystem it is handed, so the rules can
 * be tested with a temporary directory and no dev server anywhere.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { isAbsolute, join, resolve, sep } from 'node:path';

import { writeJsonAtomic } from './atomic-write.js';
import { log } from './logger.js';
import { devServersRoot } from './paths.js';
import { pidAlive } from './status-collect.js';

/** The only schema this mc understands. A manifest saying anything else is refused. */
export const DEV_SCHEMA_VERSION = 1;

/**
 * An instance id becomes a filename, so it may not be a path. `dev-<uuid>` is
 * what the wrapper writes; the pattern is wider than that and still cannot
 * contain a separator, a `..`, or anything a shell would read as a glob.
 */
const INSTANCE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;

/** Loopback only. A dev server reachable from the network is not a dev server. */
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]', '::1']);

function text(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

/** `b` is `a` itself or lives underneath it — with no string-prefix trap. */
function inside(parent, child) {
  const root = resolve(parent);
  const path = resolve(child);
  return path === root || path.startsWith(root.endsWith(sep) ? root : root + sep);
}

function loopback(value) {
  const raw = text(value);
  if (!raw) return false;
  try {
    return LOOPBACK_HOSTS.has(new URL(raw).hostname);
  } catch {
    return false;
  }
}

/** An argv is a list of non-empty strings, never a shell string. */
function argv(value) {
  return Array.isArray(value) && value.length > 0 && value.every((part) => text(part));
}

/**
 * What a manifest has to say before mc will keep a copy of it.
 *
 * The refusals are the protocol's, in its order: the schema it was written
 * against, an instance id that is a name rather than a path, a worktree that
 * is absolute, an endpoint on loopback, and a log and a source manifest that
 * stay inside the worktree they claim. A manifest that fails any of them is
 * refused with the reason — never normalised into something acceptable, which
 * would be mc deciding what a project meant.
 *
 * Plan identity (`profile`, `definition_fingerprint`, `start_argv`,
 * `resource_class`) is optional and carried through as it comes: the protocol
 * says an older manifest without it stays visible and simply never counts as
 * an exact match. Nothing here is that matcher.
 */
export function checkManifest(manifest, { sourcePath = null } = {}) {
  const problems = [];
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) {
    return { ok: false, problems: ['not a JSON object'] };
  }
  if (manifest.schema_version !== DEV_SCHEMA_VERSION) {
    problems.push(`schema_version: ${DEV_SCHEMA_VERSION}, not ${JSON.stringify(manifest.schema_version)}`);
  }
  const instanceId = text(manifest.instance_id);
  if (!instanceId || !INSTANCE_ID.test(instanceId)) problems.push('instance_id: a name, not a path');
  if (!text(manifest.service)) problems.push('service: required');
  if (!text(manifest.session_name)) problems.push('session_name: required');

  const worktree = text(manifest.worktree_path);
  if (!worktree || !isAbsolute(worktree)) problems.push('worktree_path: an absolute path');

  const pid = Number(manifest.pid);
  if (!Number.isInteger(pid) || pid <= 0) problems.push('pid: a process id');

  if (!loopback(manifest.url)) problems.push('url: must be loopback');
  if (manifest.health_url !== undefined && manifest.health_url !== null && !loopback(manifest.health_url)) {
    problems.push('health_url: must be loopback');
  }

  const logPath = text(manifest.log_path);
  if (worktree && isAbsolute(worktree)) {
    if (logPath && !inside(worktree, logPath)) problems.push('log_path: must stay inside worktree_path');
    if (sourcePath && !inside(worktree, sourcePath)) {
      problems.push('the manifest itself must stay inside worktree_path');
    }
  }

  for (const name of ['stop', 'restart']) {
    const control = manifest.control?.[name];
    if (control !== undefined && control !== null && !argv(control.argv)) {
      problems.push(`control.${name}.argv: a list of arguments, never a shell string`);
    }
  }

  return problems.length ? { ok: false, problems } : { ok: true, problems: [] };
}

/** Where mc keeps its copy of one registration. */
export function registeredPath(instanceId, root = devServersRoot()) {
  return join(root, `${instanceId}.json`);
}

function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return null;
  }
}

/**
 * Take a copy of a manifest a wrapper has just written.
 *
 * The copy is mc's, not the project's: it carries `source_manifest_path` so an
 * unregister can find it by the same path the wrapper will hand back, and
 * `registered_at`/`updated_at` so a reader can tell a fresh registration from
 * one that has been re-registered under the same instance. Re-registering is
 * ordinary — a restart keeps the instance id — so it replaces rather than
 * refusing.
 */
export function registerManifest(sourcePath, { root = devServersRoot(), now = () => new Date() } = {}) {
  const path = resolve(sourcePath);
  if (!existsSync(path)) return { ok: false, reason: 'no-manifest', error: `no manifest at ${path}` };
  const manifest = readJson(path);
  if (!manifest) return { ok: false, reason: 'unreadable', error: `${path} is not JSON` };

  const checked = checkManifest(manifest, { sourcePath: path });
  if (!checked.ok) return { ok: false, reason: 'invalid', error: checked.problems.join('; '), problems: checked.problems };

  const target = registeredPath(manifest.instance_id, root);
  const existing = readJson(target);
  const stamp = now().toISOString();
  const record = {
    ...manifest,
    source_manifest_path: path,
    registered_at: text(existing?.registered_at) || stamp,
    updated_at: stamp,
  };
  mkdirSync(root, { recursive: true, mode: 0o700 });
  writeJsonAtomic(target, record);
  return { ok: true, instance_id: manifest.instance_id, path: target, replaced: Boolean(existing) };
}

/**
 * Forget a registration, named by the manifest the wrapper wrote.
 *
 * The source file is usually gone by now — an orderly shutdown unregisters
 * before it removes it — so the id is looked up in mc's own copies by
 * `source_manifest_path` when the source cannot be read. A shutdown that
 * cannot find its registration is not an error: the end state is the one
 * asked for either way, and reporting it as a failure would make every
 * double-stop look like a fault.
 */
export function unregisterManifest(sourcePath, { root = devServersRoot() } = {}) {
  const path = resolve(sourcePath);
  const fromSource = readJson(path);
  const instanceId = text(fromSource?.instance_id)
    || readRecords(root).find((record) => record.source_manifest_path === path)?.instance_id
    || null;
  if (!instanceId || !INSTANCE_ID.test(instanceId)) {
    return { ok: true, instance_id: null, removed: false, reason: 'not-registered' };
  }
  const target = registeredPath(instanceId, root);
  if (!existsSync(target)) return { ok: true, instance_id: instanceId, removed: false, reason: 'not-registered' };
  rmSync(target, { force: true });
  return { ok: true, instance_id: instanceId, removed: true };
}

/** Every file in the directory that parses, in a stable order. */
function readRecords(root) {
  let names = [];
  try {
    names = readdirSync(root).filter((name) => name.endsWith('.json')).sort();
  } catch {
    return [];
  }
  const records = [];
  for (const name of names) {
    const record = readJson(join(root, name));
    if (record && text(record.instance_id)) records.push({ ...record, registered_file: join(root, name) });
  }
  return records;
}

/**
 * What is running, and what only looks like it.
 *
 * `pidAlive` is the whole liveness test, and deliberately the only one: a tmux
 * session name and a `pgrep` pattern both lied on 2026-08-29, and mc has used
 * one test everywhere since. A record whose pid is gone is swept, because the
 * failure this inventory is best known for is answering a question about
 * running servers with a list of dead ones — 33 of them, none live, the oldest
 * six weeks old.
 *
 * Sweeping is what `reap: false` turns off, and the only caller that wants it
 * off is a test asking what the directory holds before the sweep.
 *
 * Each swept record is a death, and is logged as `dev-server-gone`: measured
 * 12–26 Sep 2026, 141 of 571 memoro dev-server starts died unexpectedly and
 * no log mc keeps recorded one of them, because this sweep removed the only
 * trace without a word.
 */
export function listServers({ root = devServersRoot(), reap = true, now = () => Date.now() } = {}) {
  const servers = [];
  const reaped = [];
  for (const record of readRecords(root)) {
    const live = pidAlive(record.pid);
    if (!live && reap) {
      rmSync(record.registered_file, { force: true });
      reaped.push(record.instance_id);
      const started = Date.parse(record.started_at ?? '');
      log('dev-server-gone', {
        instance_id: record.instance_id,
        service: record.service ?? null,
        worktree_path: record.worktree_path ?? null,
        server_pid: record.pid ?? null,
        started_at: record.started_at ?? null,
        age_s: Number.isFinite(started) ? Math.floor((now() - started) / 1000) : null,
      });
      continue;
    }
    const { registered_file: _file, ...rest } = record;
    servers.push({ ...rest, live });
  }
  return { servers, reaped };
}

/** How many app servers may run at once, and the free-memory floor under which none starts. */
export const DEFAULT_MAX_SERVERS = 2;
export const DEFAULT_MIN_FREE_PERCENT = 15;

/** How often a waiting admission looks again, and how often it says so. */
const ADMIT_POLL_MS = 10_000;
const ADMIT_SAY_MS = 60_000;

/**
 * May one more server start? The whole rule, pure.
 *
 * Measured 12–26 Sep 2026 on this 8 GB machine: 141 of 571 memoro dev-server
 * starts died unexpectedly, and on 2026-09-26 seven registered servers sat
 * beside 6.8–8.2 GB of swap. `resource_class` had been carried in every
 * manifest since #561 and read by nothing; this is its reader.
 *
 * A server counts when it is live and not `light`. The asker's own worktree
 * *and* service does not count, because a restart replaces itself. Memory is
 * asked first — a machine already short is refused whatever the count — and a
 * `freePercent` of null (no sysctl) skips it rather than guessing.
 */
export function admission({ servers, service, worktree, cap, minFreePercent, freePercent }) {
  const self = worktree ? resolve(worktree) : null;
  const holders = (servers || [])
    .filter((server) => server.live !== false
      && server.resource_class !== 'light'
      && !(self && server.worktree_path && resolve(server.worktree_path) === self && server.service === service))
    .map((server) => ({
      instance_id: server.instance_id,
      service: server.service,
      worktree_path: server.worktree_path,
      started_at: server.started_at ?? null,
      url: server.url ?? null,
    }));
  const free = Number.isFinite(freePercent) ? freePercent : null;
  if (free !== null && free < minFreePercent) {
    return { ok: false, reason: 'memory', holders, free_percent: free, cap };
  }
  if (holders.length >= cap) return { ok: false, reason: 'cap', holders, free_percent: free, cap };
  return { ok: true };
}

/** `kern.memorystatus_level` — the percentage of memory free, on macOS — or null. */
export function freeMemoryPercent(run = spawnSync) {
  try {
    const asked = run('sysctl', ['-n', 'kern.memorystatus_level'], { encoding: 'utf8' });
    if (asked?.status !== 0) return null;
    const value = Number.parseInt(String(asked.stdout || '').trim(), 10);
    return Number.isInteger(value) ? value : null;
  } catch {
    return null;
  }
}

/**
 * Ask, and wait up to `waitSeconds` for a yes.
 *
 * Nothing already running is stopped to make room: the wait is for a holder to
 * leave by itself. The registry is read afresh on every turn, through
 * `listServers`, so a holder that died is swept rather than waited for.
 */
export async function admit({
  service, worktree, waitSeconds = 0, env = process.env, root, sleep, now, onWaiting,
  freeMemory = freeMemoryPercent, logEvent = log,
} = {}) {
  const clock = now || (() => Date.now());
  const pause = sleep || ((ms) => new Promise((done) => { setTimeout(done, ms); }));
  const cap = Number(env.MC_DEV_MAX_SERVERS) || DEFAULT_MAX_SERVERS;
  const minFreePercent = minFreePercentOf(env);
  const startedAt = clock();
  const deadline = startedAt + Math.max(0, Number(waitSeconds) || 0) * 1000;
  let said = null;
  for (;;) {
    const { servers } = listServers(root ? { root } : {});
    const verdict = admission({
      servers, service, worktree, cap, minFreePercent, freePercent: freeMemory(),
    });
    if (verdict.ok) {
      if (said !== null) {
        logEvent('dev-server-admitted', {
          service, worktree_path: worktree, waited_s: Math.round((clock() - startedAt) / 1000),
        });
      }
      return verdict;
    }
    if (clock() >= deadline) {
      logEvent('dev-server-refused', {
        service,
        worktree_path: worktree,
        reason: verdict.reason,
        holders: verdict.holders.map((holder) => holder.instance_id),
        free_percent: verdict.free_percent,
      });
      return verdict;
    }
    if (said === null || clock() - said >= ADMIT_SAY_MS) {
      said = clock();
      onWaiting?.(verdict);
    }
    await pause(ADMIT_POLL_MS);
  }
}

/** The free-memory floor `env` sets, as `admit` reads it. */
export function minFreePercentOf(env = process.env) {
  return Number(env.MC_DEV_MIN_FREE_PERCENT) || DEFAULT_MIN_FREE_PERCENT;
}

/**
 * A refusal as the sentence a person reads — the verb's and `mc test dev`'s.
 *
 * The way to free a slot is `mc test dev --stop` in the holder's worktree: mc
 * has no `mc dev stop`, and naming a verb that does not exist would send the
 * reader to an error.
 */
export function refusalText(verdict, { env = process.env } = {}) {
  if (verdict.reason === 'memory') {
    return `only ${verdict.free_percent}% memory free (floor ${minFreePercentOf(env)}%)`;
  }
  return `${verdict.holders.length} of ${verdict.cap} app servers already running — ${holdersText(verdict)};`
    + ' stop one with mc test dev --stop in its worktree';
}

/** `<id> (<worktree>), …` */
export function holdersText(verdict) {
  return verdict.holders.map((holder) => `${holder.instance_id} (${holder.worktree_path})`).join(', ');
}

/**
 * Stop a registered server — by asking the project, never by signalling
 * anything.
 *
 * The manifest carries `control.stop.argv`, which is the wrapper's own stop
 * command (`node scripts/dev.mjs --stop` in memoro's case). mc runs that and
 * nothing else: it holds an index and it does not own the process. A pid or an
 * occupied port has never been authority to signal anything here, and the
 * unregister is the wrapper's to do on the way out — which is how mc learns
 * the server is gone without being told.
 *
 * A refusal rather than a guess when the manifest has no stop command: a
 * server mc cannot stop politely is one a person stops themselves, and the
 * message says where.
 */
export function stopServer(server, deps = {}) {
  const runOne = deps.spawnSync || spawnSync;
  const argv = server?.control?.stop?.argv;
  if (!Array.isArray(argv) || !argv.length) {
    return {
      ok: false,
      error: `${server?.instance_id || 'that server'} declares no stop command — stop it where it was started`,
    };
  }
  const [command, ...args] = argv;
  const finished = runOne(command, args, {
    cwd: server.worktree_path,
    encoding: 'utf8',
    shell: false,
    timeout: Number(server.control.stop.timeout_ms) || 30_000,
  });
  return finished.status === 0
    ? { ok: true, instance_id: server.instance_id }
    : {
      ok: false,
      error: `${argv.join(' ')} exited ${finished.status}${finished.stderr ? `: ${String(finished.stderr).trim().split('\n').at(-1)}` : ''}`,
    };
}

/**
 * The live servers serving this directory or anything below it.
 *
 * By path segment, not by string prefix: `/a/memoro2` is not inside
 * `/a/memoro`, and closing one workarea must not stop its neighbour's server.
 */
export function serversUnder(path, { root = devServersRoot() } = {}) {
  const base = resolve(path);
  return listServers({ root }).servers.filter((server) => {
    if (!server.live || !server.worktree_path) return false;
    const where = resolve(server.worktree_path);
    return where === base || where.startsWith(base + sep);
  });
}

/**
 * Stop every server under a directory that is about to go away.
 *
 * A server outlives the work that wanted it otherwise: `git worktree remove`
 * never looked at the registry, and on 2026-09-26 this machine held seven
 * registered servers and a handful of orphans with swap at 8 GB. Each stop is
 * the manifest's own (`stopServer`) and each is logged, succeeded or not — the
 * caller decides what a failed stop means for the removal.
 */
export function stopServersUnder(path, { reason, root = devServersRoot(), stop = stopServer } = {}) {
  const stopped = [];
  const failed = [];
  for (const server of serversUnder(path, { root })) {
    let result;
    try { result = stop(server); } catch (error) { result = { ok: false, error: error?.message || String(error) }; }
    const ok = Boolean(result?.ok);
    log('dev-server-stopped', {
      instance_id: server.instance_id, service: server.service, worktree_path: server.worktree_path, reason, ok,
    });
    if (ok) stopped.push(server.instance_id);
    else failed.push({ instance_id: server.instance_id, error: result?.error || 'stop failed' });
  }
  return { stopped, failed };
}
