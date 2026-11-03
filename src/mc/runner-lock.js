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
 */
import { closeSync, mkdirSync, openSync, readFileSync, rmSync, writeSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { RUNNER_HOME, layoutVersion } from './paths.js';

export const LOCK_WAIT_MS = 5000;
const LOCK_POLL_MS = 25;

const readText = (path) => { try { return readFileSync(path, 'utf8'); } catch { return null; } };

export function lockPath(root) {
  return layoutVersion({ root }) === 2 ? join(root, RUNNER_HOME, 'register.lock') : join(root, RUNNER_HOME, 'projects', '.lock');
}

export function realLock(root, fn, { alive = pidAlive, waitMs = LOCK_WAIT_MS, strict = false } = {}) {
  const path = lockPath(root);
  const deadline = Date.now() + waitMs;
  for (;;) {
    let fd = null;
    try {
      fd = openSync(path, 'wx');
      writeSync(fd, String(process.pid));
      closeSync(fd);
      break;
    } catch (error) {
      if (error?.code === 'ENOENT') {
        // The directory is not there yet: the first lock makes it.
        try { mkdirSync(dirname(path), { recursive: true }); } catch (mkdirError) { if (strict) throw mkdirError; break; }
        continue;
      }
      if (error?.code !== 'EEXIST') { if (strict) throw error; break; }
      const holder = Number(readText(path));
      if (!alive(holder)) { try { rmSync(path, { force: true }); } catch { /* raced */ } continue; }
      if (Date.now() > deadline) {
        if (strict) throw new Error(`the runner lock is held by pid ${holder} — try again`);
        break;
      }
      sleepSync(LOCK_POLL_MS);
    }
  }
  try {
    return fn();
  } finally {
    try { if (Number(readText(path)) === process.pid) rmSync(path, { force: true }); } catch { /* gone */ }
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
