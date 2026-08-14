/**
 * The watcher — a meter, not a session.
 *
 * `mc repo status` can count everything itself, and for one person asking now
 * and then that is right. It stops being right the moment several parties ask
 * on a loop: the same fetch, the same gh round and the same inspection of
 * every checkout, over and over, for an answer that moves once a minute.
 *
 * So one process keeps the answer fresh and everyone else reads a file. It is
 * a detached node process with a pid file and a log beside the snapshots it
 * writes — no tmux, no conversation, nothing to attach to. It writes its own
 * files and nothing else: not in any repository, not in the registry, not the
 * lease.
 *
 * It is also entirely optional. Nothing in mc requires it to be running; the
 * view says which of the two ways it answered.
 */
import { execFileSync, spawn } from 'node:child_process';
import {
  closeSync, mkdirSync, openSync, readFileSync, rmSync, statSync, truncateSync,
} from 'node:fs';
import { fileURLToPath } from 'node:url';

import { mcHome } from './paths.js';
import {
  DEFAULT_INTERVAL_MS,
  SNAPSHOT_SCHEMA,
  SNAPSHOT_VERSION,
  readCombinedSnapshot,
  repoStatusRoot,
  watcherLogPath,
  watcherStatePath,
  writeJsonAtomic,
} from './repo-snapshot.js';

const RUNNER = fileURLToPath(new URL('./repo-watch-run.js', import.meta.url));

/** A log this size has said everything useful twice. */
const LOG_LIMIT_BYTES = 1024 * 1024;

/** How long a stop waits for the round in flight before insisting. */
const STOP_GRACE_MS = 3000;

/**
 * Is a watcher running, and when did it last write?
 *
 * The pid is checked against the process table rather than trusted: a pid
 * file outlives the machine's last reboot, and a stale one that reads as
 * "running" would leave the whole fleet reading a snapshot nobody refreshes.
 * The command line has to be the runner too — pids are reused.
 */
export function watcherState({ root = mcHome(), now = Date.now() } = {}) {
  const record = readJson(watcherStatePath(root));
  const snapshot = readCombinedSnapshot({ root, now });
  const pid = Number(record?.pid);
  const running = Number.isInteger(pid) && pid > 0 && alive(pid) && isRunner(pid);
  return {
    running,
    pid: running ? pid : null,
    started_at: running ? record?.started_at || null : null,
    interval_ms: Number(record?.interval_ms) || snapshot.interval_ms || DEFAULT_INTERVAL_MS,
    // A pid file whose process is gone is the ordinary aftermath of a reboot
    // or a kill -9, and worth saying out loud: it is the difference between
    // "never started" and "stopped without telling anyone".
    abandoned: Boolean(record) && !running,
    last_write_at: snapshot.kind === 'present' ? snapshot.at : null,
    last_write_age_ms: snapshot.kind === 'present' ? snapshot.age_ms : null,
    stale: snapshot.kind === 'present' ? snapshot.stale : null,
    log: watcherLogPath(root),
  };
}

export function startWatcher({ intervalMs = DEFAULT_INTERVAL_MS, root = mcHome(), env = process.env } = {}) {
  const state = watcherState({ root });
  if (state.running) return { ok: false, reason: 'already-running', pid: state.pid, interval_ms: state.interval_ms };

  mkdirSync(repoStatusRoot(root), { recursive: true, mode: 0o700 });
  const log = watcherLogPath(root);
  rotate(log);
  // The log is the child's own stdout and stderr, so a round that throws
  // leaves its stack there rather than nowhere.
  const fd = openSync(log, 'a', 0o600);
  let child = null;
  try {
    child = spawn(process.execPath, [RUNNER, '--interval-ms', String(intervalMs)], {
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

  writeJsonAtomic(watcherStatePath(root), {
    schema: SNAPSHOT_SCHEMA,
    version: SNAPSHOT_VERSION,
    pid: child.pid,
    started_at: new Date().toISOString(),
    interval_ms: intervalMs,
    runner: RUNNER,
  });
  return { ok: true, pid: child.pid, interval_ms: intervalMs, log };
}

/**
 * Ask it to stop, and mean it.
 *
 * A round in flight is finished rather than cut in half — it holds a fetch
 * and a rename, and the snapshot on disk should be one of the two whole
 * answers either side of it. If it will not leave, it is killed, and that is
 * said rather than hidden.
 */
export async function stopWatcher({ root = mcHome() } = {}) {
  const state = watcherState({ root });
  if (!state.running) {
    if (state.abandoned) rmSync(watcherStatePath(root), { force: true });
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
  rmSync(watcherStatePath(root), { force: true });
  return { ok: true, stopped: true, pid, forced };
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

function isRunner(pid) {
  try {
    const command = execFileSync('ps', ['-o', 'command=', '-p', String(pid)], {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
    });
    return command.includes('repo-watch-run');
  } catch { return false; }
}
