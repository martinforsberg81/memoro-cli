import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';

import { mcHome } from './paths.js';
import { scanRuntimeCleanup, reapRuntimeCleanup } from './storage-management.js';
import { resolveStoragePolicy } from './storage-policy.js';

const STATE_FILE = 'storage-gc.json';
const LOCK_FILE = 'storage.lock';

export async function maybeRunAutomaticRuntimeGc({
  mcDir = mcHome(),
  policy = resolveStoragePolicy(),
  now = Date.now(),
  scanRuntime = scanRuntimeCleanup,
  reapRuntime = reapRuntimeCleanup,
  env = process.env,
} = {}) {
  if (env.MC_STORAGE_RUNTIME_GC_DISABLE === '1') {
    return { ran: false, skipped: 'disabled' };
  }

  const nowMs = resolveNowMs(now);
  const state = readStorageGcState(mcDir);
  const lastFinishedMs = Date.parse(state.last_runtime_gc_finished_at || '');
  const throttleMs = Number(policy.runtimeGcThrottleMs);
  if (
    Number.isFinite(lastFinishedMs)
    && Number.isFinite(throttleMs)
    && throttleMs > 0
    && nowMs - lastFinishedMs < throttleMs
  ) {
    return {
      ran: false,
      skipped: 'throttled',
      next_eligible_at: new Date(lastFinishedMs + throttleMs).toISOString(),
    };
  }

  const lock = acquireStorageLock(mcDir, {
    now: nowMs,
    staleMs: policy.lockStaleMs,
  });
  if (!lock.acquired) {
    return { ran: false, skipped: lock.reason || 'locked' };
  }

  try {
    const scan = await scanRuntime({
      mcDir,
      minAgeMs: policy.runtimeMinAgeMs,
      now: nowMs,
    });
    const outcome = reapRuntime(scan);
    safeWriteStorageGcState(mcDir, {
      ...state,
      last_runtime_gc_started_at: new Date(nowMs).toISOString(),
      last_runtime_gc_finished_at: new Date(nowMs).toISOString(),
      last_runtime_gc_ok: outcome.ok,
      last_runtime_gc_counts: scan.counts,
      last_runtime_gc_error: null,
    });
    return { ran: true, ok: outcome.ok, runtime: outcome };
  } catch (err) {
    safeWriteStorageGcState(mcDir, {
      ...state,
      last_runtime_gc_error_at: new Date(nowMs).toISOString(),
      last_runtime_gc_error: err?.message || String(err),
    });
    return { ran: false, skipped: 'error', error: err?.message || String(err) };
  } finally {
    lock.release();
  }
}

export function readStorageGcState(mcDir = mcHome()) {
  try {
    const raw = readFileSync(storageGcStatePath(mcDir), 'utf8');
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

export function writeStorageGcState(mcDir = mcHome(), state = {}) {
  const path = storageGcStatePath(mcDir);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, JSON.stringify(state, null, 2), { mode: 0o600 });
  return path;
}

function safeWriteStorageGcState(mcDir, state) {
  try {
    writeStorageGcState(mcDir, state);
  } catch {}
}

export function storageGcStatePath(mcDir = mcHome()) {
  return join(mcDir, STATE_FILE);
}

export function storageLockPath(mcDir = mcHome()) {
  return join(mcDir, LOCK_FILE);
}

export function acquireStorageLock(mcDir = mcHome(), {
  now = Date.now(),
  staleMs = 30 * 60 * 1000,
} = {}) {
  const path = storageLockPath(mcDir);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  try {
    const fd = openSync(path, 'wx', 0o600);
    writeFileSync(fd, JSON.stringify({
      pid: process.pid,
      acquired_at: new Date(resolveNowMs(now)).toISOString(),
    }));
    closeSync(fd);
    return {
      acquired: true,
      path,
      release: () => {
        try { unlinkSync(path); } catch {}
      },
    };
  } catch (err) {
    if (err?.code !== 'EEXIST') {
      return { acquired: false, path, reason: 'lock-error', release: () => {} };
    }
    if (!lockIsStale(path, { now, staleMs })) {
      return { acquired: false, path, reason: 'locked', release: () => {} };
    }
    try {
      unlinkSync(path);
      const fd = openSync(path, 'wx', 0o600);
      writeFileSync(fd, JSON.stringify({
        pid: process.pid,
        acquired_at: new Date(resolveNowMs(now)).toISOString(),
        replaced_stale_lock: true,
      }));
      closeSync(fd);
      return {
        acquired: true,
        path,
        stale_replaced: true,
        release: () => {
          try { unlinkSync(path); } catch {}
        },
      };
    } catch {
      return { acquired: false, path, reason: 'locked', release: () => {} };
    }
  }
}

function lockIsStale(path, { now = Date.now(), staleMs = 30 * 60 * 1000 } = {}) {
  if (!Number.isFinite(Number(staleMs)) || Number(staleMs) <= 0) return false;
  if (!existsSync(path)) return false;
  try {
    const stats = statSync(path);
    return resolveNowMs(now) - stats.mtimeMs >= Number(staleMs);
  } catch {
    return false;
  }
}

function resolveNowMs(now) {
  if (typeof now === 'function') return Number(now());
  return Number(now);
}
