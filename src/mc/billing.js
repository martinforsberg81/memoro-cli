/**
 * Which account pays for a claude step session — the plan's weekly and 5-hour
 * budget, or the Max plan's monthly API credit — and what the runner has seen
 * of the plan's windows (project step-credits, ruling 38).
 *
 * Two files under `~/mc/runner/`, written the way `lanes.json` is:
 *
 *   `billing.json` is Martin's — `{ mode, set }`, written by
 *   `mc run --billing <mode>`. Absent, unreadable or unknown reads as `plan`,
 *   which is what the runner did before the setting existed.
 *
 *   `billing-state.json` is the runner's — the last 5-hour and seven-day
 *   windows a claude plan session's stream carried, when the plan last
 *   refused, and when the credit last proved unusable. Every field that does
 *   not read is null; a broken file is an empty state, never a wall.
 *
 * `billingFor` is the one answer to "which billing would this launch get",
 * and it is pure: the runner, `mc run --billing` and the tests ask it the
 * same question with the same files.
 *
 * Lanes share one process, so a state write is the whole file and the last
 * write wins. The mode is read at every new session, so a running runner takes
 * a new mode without a restart.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { writeJsonAtomic } from './atomic-write.js';
import { runnerDir } from './paths.js';

export const BILLING_MODES = ['plan', 'credits'];
/** Today's behaviour: nothing in step-credits changes a runner until Martin picks another mode. */
export const DEFAULT_BILLING = 'plan';
/**
 * How long an exhausted or rejected credit is left alone. There is no endpoint
 * that says the balance is back, so the only way to learn it is to try again;
 * once a day is often enough, and `mc run --billing <mode>` clears it sooner.
 */
export const CREDITS_RETRY_MS = 24 * 60 * 60 * 1000;

export function billingPath(root = runnerDir()) {
  return join(root, 'billing.json');
}

export function billingStatePath(root = runnerDir()) {
  return join(root, 'billing-state.json');
}

function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return null;
  }
}

/** The mode as set: one of `BILLING_MODES`, `plan` for anything else. Never throws. */
export function readBillingMode({ root = runnerDir() } = {}) {
  return readBillingFile({ root }).mode;
}

/** `{ mode, set }` — `set` the ISO the mode was written, or null. */
export function readBillingFile({ root = runnerDir() } = {}) {
  const raw = readJson(billingPath(root));
  const mode = BILLING_MODES.includes(raw?.mode) ? raw.mode : DEFAULT_BILLING;
  return { mode, set: mode === raw?.mode ? iso(raw?.set) : null };
}

/**
 * Set the mode. Anything not in `BILLING_MODES` is refused with
 * `{ ok: false, reason }` naming the three. A write also clears the credit
 * mark: Martin setting the mode is his word that the key or the balance was
 * fixed.
 */
export function writeBillingMode(value, { root = runnerDir(), now = new Date() } = {}) {
  const mode = typeof value === 'string' ? value.trim().toLowerCase() : value;
  if (!BILLING_MODES.includes(mode)) {
    return { ok: false, reason: `billing is ${BILLING_MODES.join(', ')}, not ${JSON.stringify(value)}` };
  }
  const set = now.toISOString();
  writeJsonAtomic(billingPath(root), { mode, set }, { mode: 0o600 });
  patchBillingState({ credits: { unusable_until: null, why: null } }, { root });
  return { ok: true, mode, set };
}

/** An ISO time, or null for anything that does not parse as one. */
function iso(value) {
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) return null;
  return value;
}

/** `{ utilization, resets_at }` with a finite utilization and a readable reset, or null. */
function window(value) {
  const utilization = Number(value?.utilization);
  const resets = iso(value?.resets_at);
  if (value == null || typeof value.utilization !== 'number' || !Number.isFinite(utilization) || !resets) return null;
  return { utilization, resets_at: resets };
}

/** The state as the file holds it, every bad field null. Never throws. */
export function normaliseBillingState(raw) {
  const plan = raw?.plan || {};
  const credits = raw?.credits || {};
  return {
    plan: {
      five_hour: window(plan.five_hour),
      seven_day: window(plan.seven_day),
      seen: iso(plan.seen),
      refused_until: iso(plan.refused_until),
    },
    credits: {
      unusable_until: iso(credits.unusable_until),
      why: typeof credits.why === 'string' && credits.why ? credits.why : null,
    },
  };
}

export function readBillingState({ root = runnerDir() } = {}) {
  return normaliseBillingState(readJson(billingStatePath(root)));
}

/** Read, merge per top-level key, write whole. Returns the state as written. */
export function patchBillingState(patch, { root = runnerDir() } = {}) {
  const state = readBillingState({ root });
  const next = normaliseBillingState({
    plan: { ...state.plan, ...(patch?.plan || {}) },
    credits: { ...state.credits, ...(patch?.credits || {}) },
  });
  writeJsonAtomic(billingStatePath(root), next, { mode: 0o600 });
  return next;
}

/** One `unifiedWindows` entry as `{ utilization, resets_at }`, epoch seconds made ISO; null when its numbers are not finite. */
function streamWindow(value) {
  const utilization = Number(value?.utilization);
  const at = Number(value?.resetsAt);
  if (value?.utilization == null || value?.resetsAt == null) return null;
  if (!Number.isFinite(utilization) || !Number.isFinite(at) || at <= 0) return null;
  return { utilization, resets_at: new Date(at * 1000).toISOString() };
}

/**
 * The plan's windows from a claude stream-json run: the last
 * `rate_limit_event` that carries `rate_limit_info.unifiedWindows`, as
 * `{ five_hour, seven_day }`, or null when there is none. Read line by line as
 * `streamRateLimit` reads the same events; a line that does not parse is
 * passed over.
 */
export function planWindows(stdout) {
  let seen = null;
  for (const line of String(stdout || '').split('\n')) {
    if (!line.includes('"rate_limit_event"')) continue;
    let event = null;
    try { event = JSON.parse(line); } catch { continue; }
    if (event?.type !== 'rate_limit_event') continue;
    const windows = event.rate_limit_info?.unifiedWindows;
    if (!windows || typeof windows !== 'object') continue;
    seen = { five_hour: streamWindow(windows.five_hour), seven_day: streamWindow(windows.seven_day) };
  }
  return seen;
}

const after = (value, now) => {
  const at = Date.parse(value || '');
  return Number.isFinite(at) && at > now.getTime();
};

/**
 * Which billing a launch would get: `{ billing: 'plan'|'credits', why }`.
 *
 * In order: a tool that is not claude is plan; a credit marked unusable is
 * plan in every mode; then the mode — `plan` and `credits` are themselves.
 * Only an explicit `credits` mode moves a Claude session to the API credit.
 */
export function billingFor({ mode = DEFAULT_BILLING, state, toolId, now = new Date() } = {}) {
  const read = normaliseBillingState(state);
  if (toolId !== 'claude-code') return { billing: 'plan', why: `${toolId || 'no tool'} is never on credits` };
  if (after(read.credits.unusable_until, now)) {
    return { billing: 'plan', why: `credits unusable until ${read.credits.unusable_until}${read.credits.why ? ` — ${read.credits.why}` : ''}` };
  }
  const chosen = BILLING_MODES.includes(mode) ? mode : DEFAULT_BILLING;
  if (chosen === 'credits') return { billing: 'credits', why: 'mode credits' };
  return { billing: 'plan', why: 'mode plan' };
}
