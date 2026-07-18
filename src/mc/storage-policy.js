import { DEFAULT_RUNTIME_MIN_AGE_MS } from './storage-management.js';

export const DEFAULT_RUNTIME_GC_THROTTLE_MS = 10 * 60 * 1000;
export const DEFAULT_STORAGE_LOCK_STALE_MS = 30 * 60 * 1000;

export function resolveStoragePolicy({
  config = {},
  env = process.env,
} = {}) {
  const storage = config?.storage || config?.mcStorage || {};
  return {
    runtimeMinAgeMs: firstDuration(
      env.MC_STORAGE_RUNTIME_MIN_AGE,
      storage.runtimeMinAge,
      storage.runtimeMinAgeMs,
      DEFAULT_RUNTIME_MIN_AGE_MS,
    ),
    runtimeGcThrottleMs: firstDuration(
      env.MC_STORAGE_RUNTIME_GC_THROTTLE,
      storage.runtimeGcThrottle,
      storage.runtimeGcThrottleMs,
      DEFAULT_RUNTIME_GC_THROTTLE_MS,
    ),
    lockStaleMs: firstDuration(
      env.MC_STORAGE_LOCK_STALE,
      storage.lockStale,
      storage.lockStaleMs,
      DEFAULT_STORAGE_LOCK_STALE_MS,
    ),
  };
}

export function parseDurationMs(spec) {
  if (spec == null || spec === '') return null;
  if (typeof spec === 'number') return Number.isFinite(spec) && spec >= 0 ? spec : null;
  const m = String(spec).trim().match(/^(\d+)(ms|[smhd])?$/i);
  if (!m) return null;
  const n = Number(m[1]);
  const unit = (m[2] || 's').toLowerCase();
  if (unit === 'ms') return n;
  if (unit === 's') return n * 1000;
  if (unit === 'm') return n * 60_000;
  if (unit === 'h') return n * 3_600_000;
  if (unit === 'd') return n * 86_400_000;
  return null;
}

function firstDuration(...values) {
  const fallback = values[values.length - 1];
  for (const value of values.slice(0, -1)) {
    const parsed = parseDurationMs(value);
    if (parsed != null) return parsed;
  }
  return fallback;
}
