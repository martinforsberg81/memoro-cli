/**
 * `mc migrate [--session <name>]… [--dry-run] [--stop-legacy-runtimes] [--json]`
 *
 * The one-time move from the old global registry to source-owned session
 * homes. It is explicit on purpose: creating, opening, or listing a session
 * must never depend on what an older mc left behind, so nothing runs this
 * for you.
 *
 * When it refuses, it says which runtime is still alive and what to do about
 * it, because "live-incompatible-runtimes" with no subject is a dead end.
 */
import { readdirSync } from 'node:fs';
import { connect } from 'node:net';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

import {
  applySessionCutoverSync,
  createSessionCutoverPlanSync,
  inspectSessionCutoverReadinessSync,
  migrateLegacySessionsSync,
} from '../session-cutover.js';
import { resolveLocalSourceSync } from '../local-source.js';
import { mcHome } from '../paths.js';
import { processIsAlive } from '../session-home-lock.js';

const STOP_GRACE_MS = 3_000;
const STOP_POLL_MS = 100;
const SOCKET_PROBE_MS = 300;

export async function run(argv, deps = {}) {
  const stdout = deps.stdout || process.stdout;
  const stderr = deps.stderr || process.stderr;
  const opts = parseArgs(argv);
  if (opts.error) {
    stderr.write(`mc: ${opts.error}\n`);
    stderr.write('usage — mc migrate [--session <name>]… [--dry-run] [--stop-legacy-runtimes] [--json]\n');
    return 2;
  }

  const inspect = deps.inspectReadiness || inspectSessionCutoverReadinessSync;
  let readiness;
  try {
    readiness = inspect({ mcHomeDir: deps.mcHomeDir });
  } catch (error) {
    return emitFailure({ stdout, stderr, opts, reason: error?.reason || error?.message });
  }

  if (readiness.state === 'complete') {
    if (opts.json) stdout.write(`${JSON.stringify({ ok: true, state: 'complete' }, null, 2)}\n`);
    else stdout.write('mc: this machine is already migrated to V1 sessions\n');
    return 0;
  }

  if (opts.sessions.length > 0) {
    return migrateSelected({ stdout, stderr, opts, deps });
  }

  if (opts.dryRun) {
    if (opts.json) stdout.write(`${JSON.stringify({ ok: true, ...readiness }, null, 2)}\n`);
    else writeReadiness(stdout, readiness);
    return 0;
  }

  if (readiness.state === 'blocked' && opts.stopLegacyRuntimes) {
    const stopped = await stopLegacyRuntimes(readiness.blocking, {
      kill: deps.kill || ((pid, signal) => process.kill(pid, signal)),
      isAlive: deps.isAlive || processIsAlive,
      graceMs: deps.stopGraceMs ?? STOP_GRACE_MS,
      pollMs: deps.stopPollMs ?? STOP_POLL_MS,
    });
    if (!opts.json) {
      for (const item of stopped) {
        stdout.write(`mc: stopped legacy runtime pid ${item.pid} (${item.result})\n`);
      }
    }
    try {
      readiness = inspect({ mcHomeDir: deps.mcHomeDir });
    } catch (error) {
      return emitFailure({ stdout, stderr, opts, reason: error?.reason || error?.message });
    }
  }

  if (readiness.state === 'blocked') {
    if (opts.json) {
      stdout.write(`${JSON.stringify({ ok: false, ...readiness }, null, 2)}\n`);
    } else {
      writeReadiness(stderr, readiness);
      stderr.write('mc: stop them and retry, or run mc migrate --stop-legacy-runtimes\n');
    }
    return 1;
  }

  // A pid file is a claim about a process, and claims go missing: any mc that
  // rewrites `broker.pid` can leave a running broker unnamed, and the process
  // check then sees nothing. The socket is the process — if something accepts
  // a connection on it, quarantining it would pull the floor out from under a
  // live runtime. This runs only for the full cutover; a selective migration
  // takes no socket away from anyone.
  const listening = await probeLegacySockets(deps.mcHomeDir || mcHome(), {
    connectFn: deps.connectFn || connect,
    timeoutMs: deps.socketProbeMs ?? SOCKET_PROBE_MS,
  });
  if (listening.length > 0) {
    if (opts.json) {
      stdout.write(`${JSON.stringify({ ok: false, state: 'blocked', listening }, null, 2)}\n`);
    } else {
      stderr.write(`mc: a legacy runtime is still listening on ${listening.length} socket${listening.length === 1 ? '' : 's'}\n`);
      for (const path of listening) stderr.write(`  ${path}\n`);
      stderr.write('mc: stop it with mc broker stop, then retry\n');
    }
    return 1;
  }

  let result;
  try {
    const source = (deps.resolveLocalSource || resolveLocalSourceSync)({
      mcHomeDir: deps.mcHomeDir,
    });
    (deps.createPlan || createSessionCutoverPlanSync)({
      mcHomeDir: deps.mcHomeDir,
      sourceId: source.source_id,
    });
    result = (deps.applyCutover || applySessionCutoverSync)({ mcHomeDir: deps.mcHomeDir });
  } catch (error) {
    return emitFailure({ stdout, stderr, opts, reason: error?.reason || error?.message });
  }

  const migrated = result?.completion?.sessions?.length
    ?? result?.sessions?.length
    ?? readiness.legacy_sessions;
  if (opts.json) stdout.write(`${JSON.stringify({ ok: true, state: 'complete', migrated }, null, 2)}\n`);
  else stdout.write(`mc: migrated ${migrated} legacy session${migrated === 1 ? '' : 's'} to V1 session homes\n`);
  return 0;
}

export function parseArgs(argv) {
  const opts = { dryRun: false, stopLegacyRuntimes: false, json: false, sessions: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--dry-run') { opts.dryRun = true; continue; }
    if (arg === '--stop-legacy-runtimes') { opts.stopLegacyRuntimes = true; continue; }
    if (arg === '--json') { opts.json = true; continue; }
    if (arg === '--session') {
      const value = argv[index + 1];
      if (!value || value.startsWith('--')) return { ...opts, error: '--session needs a session name' };
      opts.sessions.push(value);
      index += 1;
      continue;
    }
    return { ...opts, error: `unknown argument: ${arg}` };
  }
  if (opts.dryRun && opts.stopLegacyRuntimes) {
    return { ...opts, error: '--dry-run and --stop-legacy-runtimes are mutually exclusive' };
  }
  if (opts.sessions.length > 0 && (opts.dryRun || opts.stopLegacyRuntimes)) {
    return { ...opts, error: '--session cannot be combined with --dry-run or --stop-legacy-runtimes' };
  }
  return opts;
}

/**
 * Move only the named sessions and leave everything else where it is, so a
 * machine with real work on it can try the migration on something it can
 * afford to lose first.
 */
function migrateSelected({ stdout, stderr, opts, deps }) {
  let result;
  try {
    const source = (deps.resolveLocalSource || resolveLocalSourceSync)({
      mcHomeDir: deps.mcHomeDir,
    });
    result = (deps.migrateSessions || migrateLegacySessionsSync)({
      mcHomeDir: deps.mcHomeDir,
      sourceId: source.source_id,
      names: opts.sessions,
    });
  } catch (error) {
    if (error?.reason === 'unknown-legacy-session') {
      return emitFailure({
        stdout,
        stderr,
        opts,
        reason: `no legacy session named ${error.names.map((name) => `"${name}"`).join(', ')}`,
      });
    }
    return emitFailure({ stdout, stderr, opts, reason: error?.reason || error?.message });
  }
  if (opts.json) {
    stdout.write(`${JSON.stringify({ ok: result.blocked.length === 0, ...result }, null, 2)}\n`);
    return result.blocked.length === 0 ? 0 : 1;
  }
  for (const item of result.migrated) {
    stdout.write(`mc: migrated ${item.name} (${item.mc_session_id})\n`);
  }
  for (const item of result.skipped) {
    stdout.write(`mc: ${item.name} was already migrated\n`);
  }
  for (const item of result.blocked) {
    stderr.write(`mc: ${item.name} was not migrated — ${describe(item.reason)}\n`);
  }
  if (result.migrated.length > 0) {
    stdout.write('mc: the rest of this machine is untouched; run mc migrate to finish\n');
  }
  return result.blocked.length === 0 ? 0 : 1;
}

async function probeLegacySockets(root, { connectFn, timeoutMs }) {
  const candidates = [join(root, 'broker.sock'), join(root, 'provider-artifact.sock')];
  try {
    for (const name of readdirSync(join(root, 'hosts'))) {
      candidates.push(join(root, 'hosts', name, 'broker.sock'));
    }
  } catch { /* no hosts directory is the migrated-or-never-used case */ }
  const results = await Promise.all(candidates.map((path) => new Promise((resolve) => {
    let socket;
    const finish = (value) => {
      try { socket?.destroy(); } catch { /* the probe is over either way */ }
      resolve(value);
    };
    try {
      socket = connectFn(path);
    } catch {
      resolve(null);
      return;
    }
    socket.setTimeout?.(timeoutMs);
    socket.once('connect', () => finish(path));
    socket.once('error', () => finish(null));
    socket.once('timeout', () => finish(null));
  })));
  return results.filter(Boolean);
}

async function stopLegacyRuntimes(blocking, { kill, isAlive, graceMs, pollMs }) {
  const pids = [...new Set(blocking.map((item) => item.pid).filter((pid) => Number.isSafeInteger(pid) && pid > 0))];
  const stopped = [];
  for (const pid of pids) {
    try { kill(pid, 'SIGTERM'); } catch { /* already gone is the outcome we want */ }
  }
  const deadline = graceMs;
  let waited = 0;
  while (waited < deadline && pids.some((pid) => isAlive(pid))) {
    await sleep(pollMs);
    waited += pollMs;
  }
  for (const pid of pids) {
    if (!isAlive(pid)) { stopped.push({ pid, result: 'exited' }); continue; }
    try { kill(pid, 'SIGKILL'); } catch { /* nothing else to try */ }
    stopped.push({ pid, result: isAlive(pid) ? 'still running' : 'killed' });
  }
  return stopped;
}

function writeReadiness(out, readiness) {
  if (readiness.migrated_sessions) {
    out.write(`mc: ${readiness.migrated_sessions} session${readiness.migrated_sessions === 1 ? '' : 's'} already migrated one at a time\n`);
  }
  if (readiness.state === 'ready') {
    out.write(`mc: ready to migrate ${readiness.legacy_sessions} legacy session${readiness.legacy_sessions === 1 ? '' : 's'}\n`);
    writePending(out, readiness);
    return;
  }
  out.write(`mc: migration is blocked by ${readiness.blocking.length} live legacy runtime${readiness.blocking.length === 1 ? '' : 's'}\n`);
  for (const item of readiness.blocking) {
    out.write(`  ${item.id} — ${describe(item.reason)}${item.pid ? ` (pid ${item.pid})` : ''}\n`);
  }
  writePending(out, readiness);
}

function writePending(out, readiness) {
  const pending = readiness.pending || [];
  if (pending.length === 0) return;
  const free = pending.filter((item) => !item.blocked).map((item) => item.name);
  out.write(`mc: ${pending.length} legacy session${pending.length === 1 ? '' : 's'} not yet migrated\n`);
  if (free.length > 0) {
    out.write(`mc: try one first — mc migrate --session ${free[0]}\n`);
    out.write(`    available: ${free.join(', ')}\n`);
  }
}

function describe(reason) {
  if (reason === 'global-broker-alive') return 'the old global broker is still running';
  if (reason === 'runtime-process-alive') return 'its runtime process is still running';
  if (reason === 'managed-generation-active') return 'its managed generation is still running';
  return reason || 'unknown';
}

function emitFailure({ stdout, stderr, opts, reason }) {
  if (opts.json) stdout.write(`${JSON.stringify({ ok: false, reason: reason || 'unknown' }, null, 2)}\n`);
  else stderr.write(`mc: migration failed (${reason || 'unknown'})\n`);
  return 1;
}
