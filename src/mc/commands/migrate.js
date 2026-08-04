/**
 * `mc migrate [--dry-run] [--stop-legacy-runtimes] [--json]`
 *
 * The one-time move from the old global registry to source-owned session
 * homes. It is explicit on purpose: creating, opening, or listing a session
 * must never depend on what an older mc left behind, so nothing runs this
 * for you.
 *
 * When it refuses, it says which runtime is still alive and what to do about
 * it, because "live-incompatible-runtimes" with no subject is a dead end.
 */
import { setTimeout as sleep } from 'node:timers/promises';

import {
  applySessionCutoverSync,
  createSessionCutoverPlanSync,
  inspectSessionCutoverReadinessSync,
} from '../session-cutover.js';
import { resolveLocalSourceSync } from '../local-source.js';
import { processIsAlive } from '../session-home-lock.js';

const STOP_GRACE_MS = 3_000;
const STOP_POLL_MS = 100;

export async function run(argv, deps = {}) {
  const stdout = deps.stdout || process.stdout;
  const stderr = deps.stderr || process.stderr;
  const opts = parseArgs(argv);
  if (opts.error) {
    stderr.write(`mc: ${opts.error}\n`);
    stderr.write('usage — mc migrate [--dry-run] [--stop-legacy-runtimes] [--json]\n');
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
  const opts = { dryRun: false, stopLegacyRuntimes: false, json: false };
  for (const arg of argv) {
    if (arg === '--dry-run') { opts.dryRun = true; continue; }
    if (arg === '--stop-legacy-runtimes') { opts.stopLegacyRuntimes = true; continue; }
    if (arg === '--json') { opts.json = true; continue; }
    return { ...opts, error: `unknown argument: ${arg}` };
  }
  if (opts.dryRun && opts.stopLegacyRuntimes) {
    return { ...opts, error: '--dry-run and --stop-legacy-runtimes are mutually exclusive' };
  }
  return opts;
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
  if (readiness.state === 'ready') {
    out.write(`mc: ready to migrate ${readiness.legacy_sessions} legacy session${readiness.legacy_sessions === 1 ? '' : 's'}\n`);
    return;
  }
  out.write(`mc: migration is blocked by ${readiness.blocking.length} live legacy runtime${readiness.blocking.length === 1 ? '' : 's'}\n`);
  for (const item of readiness.blocking) {
    out.write(`  ${item.id} — ${describe(item.reason)}${item.pid ? ` (pid ${item.pid})` : ''}\n`);
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
