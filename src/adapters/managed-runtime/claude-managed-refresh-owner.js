/**
 * Long-lived refresh owner for one managed Claude runtime.
 *
 * The owner is trusted host code. It gives the sandbox one stable sentinel,
 * then changes only the sentinel registry's real-value mapping after the
 * rotated OAuth grant has been durably committed under the vault refresh
 * lease.
 */
import {
  loadManagedClaudeCustody,
  rotateManagedClaudeCustody,
} from './claude-managed-custody.js';
import { managedClaudeRefreshDelay } from './claude-managed-refresh.js';

const SENTINEL_NAME = 'mc:claude-oauth';
const API_HOST = 'api.anthropic.com';
const MIN_RETRY_MS = 1_000;

export function createManagedClaudeRefreshOwner({
  sentinelRegistry,
  portal,
  custodyDeps = {},
  loadCustody = loadManagedClaudeCustody,
  rotateCustody = rotateManagedClaudeCustody,
  now = Date.now,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
  onFatal = () => {},
} = {}) {
  if (!sentinelRegistry
    || typeof sentinelRegistry.register !== 'function'
    || typeof loadCustody !== 'function'
    || typeof rotateCustody !== 'function'
    || typeof now !== 'function'
    || typeof setTimer !== 'function'
    || typeof clearTimer !== 'function'
    || typeof onFatal !== 'function') {
    throw new TypeError('managed Claude refresh owner contract is invalid');
  }

  let state = 'created';
  let timer = null;
  let sentinel = null;
  let currentGrant = null;
  let activeRefresh = null;
  let fatalReason = null;

  const cancelTimer = () => {
    if (timer !== null) clearTimer(timer);
    timer = null;
  };
  const fail = (reason) => {
    if (state === 'stopped' || state === 'failed') return;
    cancelTimer();
    state = 'failed';
    fatalReason = reason || 'managed-claude-refresh-failed';
    currentGrant = null;
    try { onFatal(fatalReason); } catch {}
  };
  const schedule = (delay) => {
    if (state !== 'running'
      || !Number.isSafeInteger(delay)
      || delay < 0) {
      fail('managed-claude-refresh-schedule-invalid');
      return;
    }
    cancelTimer();
    timer = setTimer(() => {
      timer = null;
      void refresh();
    }, delay);
    timer?.unref?.();
  };
  const scheduleFromGrant = () => {
    const delay = managedClaudeRefreshDelay(currentGrant, { now: now() });
    if (delay === null) {
      fail('managed-claude-refresh-schedule-invalid');
      return;
    }
    schedule(delay);
  };
  const installGrant = (grant) => {
    const nextSentinel = sentinelRegistry.register(
      SENTINEL_NAME,
      grant.accessToken,
      [API_HOST],
    );
    if (typeof nextSentinel !== 'string'
      || !nextSentinel
      || (sentinel !== null && nextSentinel !== sentinel)) {
      return false;
    }
    sentinel = nextSentinel;
    currentGrant = grant;
    return true;
  };
  const refresh = async () => {
    if (state !== 'running') return { ok: false, reason: 'refresh-owner-not-running' };
    if (activeRefresh) return activeRefresh;
    activeRefresh = Promise.resolve()
      .then(() => rotateCustody({ portal, deps: custodyDeps }))
      .then((result) => {
        if (state !== 'running') return result;
        if (result?.ok) {
          if (!installGrant(result.grant)) {
            fail('managed-claude-sentinel-rotation-failed');
            return { ok: false, reason: fatalReason };
          }
          const delay = Number.isSafeInteger(result.nextRefreshInMs)
            ? result.nextRefreshInMs
            : managedClaudeRefreshDelay(currentGrant, { now: now() });
          schedule(delay);
          return result;
        }
        if (result?.reason === 'managed-claude-refresh-busy'
          && Number.isSafeInteger(result.retryAt)) {
          const delay = Math.max(MIN_RETRY_MS, result.retryAt - now() + MIN_RETRY_MS);
          const expiresAt = Number(currentGrant?.expiresAt);
          if (!Number.isFinite(expiresAt) || now() + delay >= expiresAt) {
            fail('managed-claude-refresh-deadline-lost');
            return { ok: false, reason: fatalReason };
          }
          schedule(delay);
          return result;
        }
        fail(result?.reason || 'managed-claude-refresh-failed');
        return result;
      })
      .catch(() => {
        fail('managed-claude-refresh-failed');
        return { ok: false, reason: fatalReason };
      })
      .finally(() => {
        activeRefresh = null;
      });
    return activeRefresh;
  };

  return Object.freeze({
    async start() {
      if (state !== 'created') {
        return { ok: false, reason: 'refresh-owner-already-started' };
      }
      state = 'starting';
      const loaded = await Promise.resolve()
        .then(() => loadCustody({ portal, deps: custodyDeps }))
        .catch(() => null);
      if (!loaded?.ok || !installGrant(loaded.grant)) {
        fail(loaded?.reason || 'managed-claude-custody-load-failed');
        return { ok: false, reason: fatalReason };
      }
      state = 'running';
      scheduleFromGrant();
      return state === 'running'
        ? { ok: true, sentinel }
        : { ok: false, reason: fatalReason };
    },
    refresh,
    stop() {
      cancelTimer();
      state = 'stopped';
      currentGrant = null;
      return { ok: true };
    },
    status() {
      return Object.freeze({
        state,
        scheduled: timer !== null,
        refresh_active: activeRefresh !== null,
        fatal_reason: fatalReason,
      });
    },
  });
}
