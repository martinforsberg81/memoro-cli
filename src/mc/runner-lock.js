/**
 * One writer at a time across the runner's shared files: a lock file with the
 * writer's pid, taken with `O_EXCL`, held for the milliseconds a
 * read-patch-write takes. A file naming a dead pid is litter from a killed
 * writer and is taken over; a live one is waited on, briefly, and then the
 * write goes ahead anyway — a file that cannot be written is worse than one
 * written a moment early, and every write is whole (`writeJsonAtomic`).
 *
 * It guards `merges.json`, deploys, language runs and iOS builds. The file is
 * under `runner/`: `runner/register.lock` in layout 2, `runner/projects/.lock`
 * in layout 1 — the names the project register used, kept so a process on
 * older code and one on newer still exclude each other.
 * `strict: true` refuses to run `fn` without the lock.
 *
 * Visibility, so a caller that holds the lock too long, or writes without it,
 * shows in the runner's log (logger.js) with the caller's `name`:
 *   - `runner-lock-held`: `fn` held the lock for more than HELD_LOG_MS.
 *   - `runner-lock-unlocked`: a non-strict caller waited out a live holder, or
 *     could not take the lock at all (`EACCES`, `EROFS`, `ENOSPC`, …), and ran
 *     `fn` without it. `reason` is `EEXIST` for the holder or the error code of
 *     the failed open or mkdir. A waited-out holder is named by both pids, and
 *     by its name when the holder recorded one.
 *
 * The lock file stays exactly the pid, one line. Older mc reads it with
 * `Number(text)`, and a second line would make that NaN — an older reader
 * would then take a live holder's lock as dead. The holder's name is kept in a
 * sidecar, `<lock>.holder`, as `{ "pid", "name" }`, and only trusted while its
 * pid is the lock's holder, so a sidecar left by a killed writer names nobody.
 */
import { closeSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync, writeSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { log as logEvent } from './logger.js';
import { RUNNER_HOME, layoutVersion } from './paths.js';

export const LOCK_WAIT_MS = 5000;
export const HELD_LOG_MS = 1000;
const LOCK_POLL_MS = 25;

const readText = (path) => { try { return readFileSync(path, 'utf8'); } catch { return null; } };

export function lockPath(root) {
  return layoutVersion({ root }) === 2 ? join(root, RUNNER_HOME, 'register.lock') : join(root, RUNNER_HOME, 'projects', '.lock');
}

/** The sidecar that names the holder of the lock at `path`. */
export function holderPath(path) {
  return `${path}.holder`;
}

function holderName(path, holder) {
  try {
    const record = JSON.parse(readText(holderPath(path)) ?? 'null');
    return record && Number(record.pid) === holder && typeof record.name === 'string' ? record.name : null;
  } catch { return null; }
}

function recordHolder(path, name) {
  try { writeFileSync(holderPath(path), JSON.stringify({ pid: process.pid, name })); } catch { /* the name is a courtesy */ }
}

function forgetHolder(path) {
  try { rmSync(holderPath(path), { force: true }); } catch { /* gone */ }
}

/**
 * Run `fn` under the runner lock. `name` says who is asking (`'merges'`,
 * `'tidy-pressure'`, …) and goes into the log lines. `now` and `log` are for
 * tests: the clock that times the wait and the hold, and the logger.
 */
export function realLock(root, fn, {
  alive = pidAlive, waitMs = LOCK_WAIT_MS, strict = false, name = null,
  now = () => Date.now(), log = logEvent, open = openSync,
} = {}) {
  const path = lockPath(root);
  const startedAt = now();
  const deadline = startedAt + waitMs;
  let holding = false;
  let unlocked = null;
  for (;;) {
    let fd = null;
    try {
      fd = open(path, 'wx');
      writeSync(fd, String(process.pid));
      closeSync(fd);
      recordHolder(path, name);
      holding = true;
      break;
    } catch (error) {
      if (error?.code === 'ENOENT') {
        // The directory is not there yet: the first lock makes it.
        try { mkdirSync(dirname(path), { recursive: true }); } catch (mkdirError) {
          if (strict) throw mkdirError;
          unlocked = { reason: mkdirError?.code ?? null };
          break;
        }
        continue;
      }
      if (error?.code !== 'EEXIST') {
        if (strict) throw error;
        unlocked = { reason: error?.code ?? null };
        break;
      }
      const holder = Number(readText(path));
      if (!alive(holder)) { try { rmSync(path, { force: true }); } catch { /* raced */ } continue; }
      if (now() > deadline) {
        if (strict) throw new Error(`the runner lock is held by pid ${holder} — try again`);
        unlocked = { holder, holderName: holderName(path, holder), reason: 'EEXIST' };
        break;
      }
      sleepSync(LOCK_POLL_MS);
    }
  }
  if (unlocked) {
    log('runner-lock-unlocked', {
      name,
      pid: process.pid,
      holder_pid: unlocked.holder ?? null,
      holder_name: unlocked.holderName ?? null,
      reason: unlocked.reason,
      waited_ms: now() - startedAt,
    });
  }
  const acquiredAt = now();
  try {
    return fn();
  } finally {
    if (holding) {
      const heldMs = now() - acquiredAt;
      if (heldMs > HELD_LOG_MS) log('runner-lock-held', { name, pid: process.pid, held_ms: heldMs });
    }
    try {
      if (Number(readText(path)) === process.pid) { forgetHolder(path); rmSync(path, { force: true }); }
    } catch { /* gone */ }
  }
}

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function pidAlive(pid) {
  const n = Number(pid);
  if (!Number.isInteger(n) || n <= 0) return false;
  try { process.kill(n, 0); return true; } catch (error) { return error?.code === 'EPERM'; }
}
