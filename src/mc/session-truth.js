/**
 * Effective session truth: registry state cross-checked against what is
 * actually alive on this machine.
 *
 * The registry's session_state goes stale whenever PTYs die out from
 * under it (crash, shutdown, broker restart). Read paths must never
 * present a dead session as live: probe the local broker + session hosts
 * once, then render registry-live entries with no live local session as
 * 'stale'. Repair stays explicit (`mc storage repair --apply`) — read
 * commands never mutate the registry.
 */
import { fetchLocalBrokerCodingSessions } from './session-list.js';
import { escalateSafetyVerdict } from './safety-verdict.js';

export async function fetchLiveLocalSessionIds({ deps = {} } = {}) {
  const fetchLocal = deps.fetchLocalBrokerSessions
    || (() => fetchLocalBrokerCodingSessions({ deps }));
  const res = await fetchLocal();
  return new Set(
    (res?.sessions || []).map((s) => s.coding_session_id).filter(Boolean),
  );
}

/**
 * Return a copy of the entry with truthful session_state and (unless
 * withVerdict is false) an escalate-only safety verdict. Callers whose
 * projection carries no git facts (e.g. the open/resume picker) pass
 * withVerdict: false to get the state correction alone.
 */
export function normalizeEntryTruth(entry, liveIds = new Set(), { withVerdict = true } = {}) {
  const storedState = entry.session_state || 'no-session-yet';
  const isStale = storedState === 'live' && !liveIds.has(entry.coding_session_id);
  const next = {
    ...entry,
    session_state: isStale ? 'stale' : storedState,
  };
  if (!withVerdict) return next;
  // A stale session cannot be active now; drop the stored claim so the
  // verdict re-derives from git facts (escalate-only, fail-safe).
  const storedVerdict = isStale && entry.safety_verdict === 'IS_ACTIVE_NOW'
    ? null
    : entry.safety_verdict || null;
  next.safety_verdict = escalateSafetyVerdict({
    stored: storedVerdict,
    dirtyFiles: entry.dirty_files ?? null,
    ahead: entry.ahead ?? null,
  });
  return next;
}

export function countStaleDemotions(entries = []) {
  return entries.filter((e) => e.session_state === 'stale').length;
}

export function staleDemotionHint(count) {
  return `mc: ${count} session(s) marked live in the registry have no live local session — shown as stale; run \`mc storage repair --apply\` to reconcile\n`;
}
