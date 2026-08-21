/**
 * One daemon form, for both legs of the loop.
 *
 * `mc repo watch` settled what a background process in mc looks like: a
 * detached node process, a pid file checked against the process table rather
 * than trusted, a log beside it, and a freshness rule so a reader can tell a
 * watcher that stopped from one that never started. `mc watch pm` and
 * `mc watch sessions` are that same form, so it is written once here and
 * each leg supplies its runner, its target name and where its last write is
 * recorded. Two daemon forms would be two ways to operate, two ways to debug
 * and two ways to forget.
 */
import { execFileSync, spawn } from 'node:child_process';
import {
  closeSync, mkdirSync, openSync, readFileSync, rmSync, statSync, truncateSync,
} from 'node:fs';
import { basename } from 'node:path';

import { writeJsonAtomic } from './atomic-write.js';
import { mcHome } from './paths.js';
import { watchLogPath, watchRoot, watchStatePath } from './watch-paths.js';

export const DAEMON_SCHEMA = 'mc-watch';
export const DAEMON_VERSION = 1;

/** A log this size has said everything useful twice. */
const LOG_LIMIT_BYTES = 1024 * 1024;

/** How long a stop waits for the pass in flight before insisting. */
const STOP_GRACE_MS = 3000;

/** A last write older than this many intervals is old news, and says so. */
export const STALE_ROUNDS = 3;

/**
 * Is it running, and when did it last do something?
 *
 * The pid is checked against the process table rather than trusted: a pid
 * file outlives the machine's last reboot, and a stale one reading as
 * "running" would leave everyone waiting on a round nobody is running. The
 * command line has to be the runner too — pids are reused.
 */
export function daemonState({
  target, runner, root = mcHome(), now = Date.now(), lastWriteAt = null, defaultIntervalMs = 0,
} = {}) {
  const record = readJson(watchStatePath(target, root));
  const pid = Number(record?.pid);
  const running = Number.isInteger(pid) && pid > 0 && alive(pid) && isRunner(pid, runner);
  const intervalMs = Number(record?.interval_ms) || defaultIntervalMs;
  const wrote = lastWriteAt ? Date.parse(lastWriteAt) : NaN;
  const ageMs = Number.isFinite(wrote) ? Math.max(0, now - wrote) : null;
  return {
    target,
    running,
    pid: running ? pid : null,
    started_at: running ? record?.started_at || null : null,
    interval_ms: intervalMs,
    // A pid file whose process is gone is the ordinary aftermath of a reboot
    // or a kill -9, and worth saying out loud: it is the difference between
    // "never started" and "stopped without telling anyone".
    abandoned: Boolean(record) && !running,
    last_write_at: Number.isFinite(wrote) ? lastWriteAt : null,
    last_write_age_ms: ageMs,
    stale: ageMs === null ? null : intervalMs > 0 && ageMs > intervalMs * STALE_ROUNDS,
    log: watchLogPath(target, root),
  };
}

export function startDaemon({
  target, runner, args = [], intervalMs = 0, root = mcHome(), env = process.env, lastWriteAt = null,
} = {}) {
  const state = daemonState({ target, runner, root, lastWriteAt, defaultIntervalMs: intervalMs });
  if (state.running) return { ok: false, reason: 'already-running', pid: state.pid, interval_ms: state.interval_ms };

  mkdirSync(watchRoot(root), { recursive: true, mode: 0o700 });
  const log = watchLogPath(target, root);
  rotate(log);
  // The log is the child's own stdout and stderr, so a pass that throws
  // leaves its stack there rather than nowhere.
  const fd = openSync(log, 'a', 0o600);
  let child = null;
  try {
    child = spawn(process.execPath, [runner, ...args], {
      detached: true,
      stdio: ['ignore', fd, fd],
      env: { ...env },
    });
    child.unref();
  } catch (error) {
    closeSync(fd);
    return { ok: false, reason: error?.message || String(error) };
  }
  closeSync(fd);

  writeJsonAtomic(watchStatePath(target, root), {
    schema: DAEMON_SCHEMA,
    version: DAEMON_VERSION,
    target,
    pid: child.pid,
    started_at: new Date().toISOString(),
    interval_ms: intervalMs,
    runner,
  });
  return { ok: true, pid: child.pid, interval_ms: intervalMs, log };
}

/**
 * Ask it to stop, and mean it.
 *
 * A pass in flight is finished rather than cut in half — it holds a git
 * commit and a message being written into somebody's inbox, and neither is a
 * thing to leave halfway. If it will not leave, it is killed, and that is
 * said rather than hidden.
 */
export async function stopDaemon({ target, runner, root = mcHome() } = {}) {
  const state = daemonState({ target, runner, root });
  if (!state.running) {
    if (state.abandoned) rmSync(watchStatePath(target, root), { force: true });
    return { ok: true, stopped: false, abandoned: state.abandoned };
  }
  const { pid } = state;
  try { process.kill(pid, 'SIGTERM'); } catch { /* it went on its own */ }
  const deadline = Date.now() + STOP_GRACE_MS;
  while (Date.now() < deadline && alive(pid)) {
    await new Promise((resolve) => { setTimeout(resolve, 50); });
  }
  let forced = false;
  if (alive(pid)) {
    forced = true;
    try { process.kill(pid, 'SIGKILL'); } catch { /* already gone */ }
  }
  rmSync(watchStatePath(target, root), { force: true });
  return { ok: true, stopped: true, pid, forced };
}

/**
 * The runner clears its own pid file on the way out.
 *
 * Leaving it behind would tell the next reader a watcher is running when none
 * is. Only its own: a file naming a different pid belongs to a process that
 * replaced this one, and taking it would be worse than leaving it.
 */
export function clearOwnState(target, root = mcHome()) {
  try {
    const { pid } = JSON.parse(readFileSync(watchStatePath(target, root), 'utf8'));
    if (Number(pid) === process.pid) rmSync(watchStatePath(target, root), { force: true });
  } catch { /* stopped by something that already removed it */ }
}

function rotate(log) {
  try {
    if (statSync(log).size > LOG_LIMIT_BYTES) truncateSync(log, 0);
  } catch { /* no log yet */ }
}

function readJson(path) {
  try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return null; }
}

function alive(pid) {
  try { process.kill(pid, 0); return true; } catch (error) { return error?.code === 'EPERM'; }
}

function isRunner(pid, runner) {
  const marker = basename(String(runner || '')).replace(/\.js$/u, '');
  if (!marker) return false;
  try {
    const command = execFileSync('ps', ['-o', 'command=', '-p', String(pid)], {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
    });
    return command.includes(marker);
  } catch { return false; }
}
