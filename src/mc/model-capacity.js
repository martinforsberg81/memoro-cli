/**
 * What the runner has seen of each provider's subscription capacity (ruling 59).
 *
 * `~/mc/runner/model-capacity.json` is the runner's, written whole and atomically
 * (writeJsonAtomic). It is kept apart from `models.json`, which is Martin's: an
 * observation never edits the catalog and a catalog edit never rewrites what was
 * observed.
 *
 * Per provider it holds the last valid observation — when it was taken, the
 * windows (the fraction of the plan used, and the instant the window resets),
 * the models the provider lists where that is known, and a refusal instant —
 * and, beside it, the last failure. A failure never erases the snapshot before
 * it; it says so. A window whose reset has passed is expired: its usage is
 * unknown, never zero.
 *
 * Nothing here spends a model turn. Claude's windows come from the stream of a
 * session that ran anyway (billing.js `planWindows`); Codex's come from the
 * read-only collector in codex-capacity.js.
 *
 * The functions that read the state take `now`, so the tests pin every answer.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { writeJsonAtomic } from './atomic-write.js';
import { planWindows } from './billing.js';
import { runnerDir } from './paths.js';

export const CAPACITY_SCHEMA = 'mc-model-capacity';
export const CAPACITY_VERSION = 1;
export const CAPACITY_FILE = 'model-capacity.json';
export const PROVIDERS = Object.freeze(['claude', 'codex']);
/** The windows each provider reports: Claude's five-hour and seven-day, Codex's primary and secondary. */
export const WINDOWS = Object.freeze({ claude: Object.freeze(['five_hour', 'seven_day']), codex: Object.freeze(['primary', 'secondary']) });
/** An observation older than this is stale: still shown, but never read as current. Codex is polled hourly. */
export const STALE_MS = 3 * 60 * 60 * 1000;

export function capacityPath(root = runnerDir()) {
  return join(root, CAPACITY_FILE);
}

function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return null;
  }
}

const iso = (value) => (typeof value === 'string' && Number.isFinite(Date.parse(value)) ? value : null);
const after = (value, now) => {
  const at = Date.parse(value || '');
  return Number.isFinite(at) && at > now.getTime();
};

/** `{ fraction_used, resets_at }` with a finite usage and a readable reset, or null. */
function window(value) {
  const fraction = value?.fraction_used;
  const resets = iso(value?.resets_at);
  if (typeof fraction !== 'number' || !Number.isFinite(fraction) || fraction < 0 || !resets) return null;
  return { fraction_used: fraction, resets_at: resets };
}

/** `{ id, efforts }` for one model a provider lists, or null. */
function model(value) {
  if (typeof value?.id !== 'string' || !value.id) return null;
  const efforts = Array.isArray(value.efforts) ? value.efforts.filter((effort) => typeof effort === 'string' && effort) : [];
  return { id: value.id, efforts };
}

/** `{ why, at }` for the last failed observation, or null. */
function failure(value) {
  if (typeof value?.why !== 'string' || !value.why) return null;
  return { at: iso(value.at), why: value.why };
}

/** One provider as the file holds it, every bad field null or empty. Windows are null until something was observed. */
function normaliseProvider(raw, provider) {
  const observed = iso(raw?.observed_at);
  const windows = Object.fromEntries(WINDOWS[provider].map((name) => [name, observed ? window(raw?.windows?.[name]) : null]));
  return {
    observed_at: observed,
    windows,
    models: observed && Array.isArray(raw?.models) ? raw.models.map(model).filter(Boolean) : null,
    refusal_until: iso(raw?.refusal_until),
    failure: failure(raw?.failure),
  };
}

/** The state as the file holds it, every bad field read as absent. Never throws. */
export function normaliseCapacity(raw) {
  return {
    schema: CAPACITY_SCHEMA,
    version: CAPACITY_VERSION,
    providers: Object.fromEntries(PROVIDERS.map((provider) => [provider, normaliseProvider(raw?.providers?.[provider], provider)])),
  };
}

export function readCapacity({ root = runnerDir() } = {}) {
  return normaliseCapacity(readJson(capacityPath(root)));
}

/** Written whole, mode 0600, and returned as normalised. */
export function writeCapacity(state, { root = runnerDir() } = {}) {
  const next = normaliseCapacity(state);
  writeJsonAtomic(capacityPath(root), next, { mode: 0o600 });
  return next;
}

/** The state with one provider's fields replaced; the other provider is untouched. */
function withProvider(state, provider, patch) {
  const current = normaliseCapacity(state);
  return normaliseCapacity({ ...current, providers: { ...current.providers, [provider]: { ...current.providers[provider], ...patch } } });
}

/**
 * A complete observation of one provider: its windows and the models it lists
 * (`null` where the provider lists none). The failure, if any, is cleared — this
 * is the last valid snapshot now. The refusal is kept: it is not an observation.
 */
export function applyObservation(state, provider, { windows, models = null }, now = new Date()) {
  return withProvider(state, provider, { observed_at: now.toISOString(), windows, models, failure: null });
}

/** A failed try to observe a provider: the snapshot before it stays, and says it failed. */
export function applyFailure(state, provider, { why }, now = new Date()) {
  return withProvider(state, provider, { failure: { at: now.toISOString(), why: String(why) } });
}

/** The instant a provider refused until, or null to clear it. */
export function applyRefusal(state, provider, until) {
  return withProvider(state, provider, { refusal_until: iso(until) });
}

/** `{ five_hour, seven_day }` of a claude stream, as fractions; a missing window is null. */
const fraction = (value) => (value ? { fraction_used: value.utilization, resets_at: value.resets_at } : null);

/**
 * The state with Claude's windows as one claude stream carried them. A window
 * the stream does not carry keeps the last one seen; a stream with no windows
 * at all changes nothing. Nothing is sent: the session ran anyway.
 */
export function observeClaudeStream(state, stdout, now = new Date()) {
  const seen = planWindows(stdout);
  const current = normaliseCapacity(state);
  if (!seen || (!seen.five_hour && !seen.seven_day)) return current;
  const previous = current.providers.claude.windows;
  return applyObservation(current, 'claude', {
    windows: { five_hour: fraction(seen.five_hour) ?? previous.five_hour, seven_day: fraction(seen.seven_day) ?? previous.seven_day },
    models: null,
  }, now);
}

/**
 * Each window of a provider as it reads at `now`. `known` carries its fraction;
 * `expired` (its reset has passed) and `unknown` (never seen) carry null — an
 * expired window is not zero usage.
 */
export function windowsAt(state, provider, now = new Date()) {
  const current = normaliseCapacity(state).providers[provider];
  return Object.fromEntries(WINDOWS[provider].map((name) => {
    const seen = current.windows[name];
    if (!seen) return [name, { status: 'unknown', fraction_used: null, resets_at: null }];
    if (!after(seen.resets_at, now)) return [name, { status: 'expired', fraction_used: null, resets_at: seen.resets_at }];
    return [name, { status: 'known', fraction_used: seen.fraction_used, resets_at: seen.resets_at }];
  }));
}

/**
 * A provider's standing at `now`: `failed` (the last try failed; the snapshot
 * is kept and says so), `unobserved`, `stale` (the snapshot is older than
 * STALE_MS) or `observed`. Also its windows as `windowsAt` reads them, its
 * models, and its refusal while that has not passed.
 */
export function providerAt(state, provider, now = new Date()) {
  const current = normaliseCapacity(state).providers[provider];
  const stale = current.observed_at !== null && now.getTime() - Date.parse(current.observed_at) > STALE_MS;
  const status = current.failure ? 'failed' : current.observed_at === null ? 'unobserved' : stale ? 'stale' : 'observed';
  return {
    status,
    observed_at: current.observed_at,
    stale,
    failure: current.failure,
    windows: windowsAt(state, provider, now),
    models: current.models,
    refusal_until: after(current.refusal_until, now) ? current.refusal_until : null,
  };
}

/**
 * Whether a configured Codex model at an effort is available: `{ available, why }`.
 * Only a current observation whose `model/list` held the model with that effort
 * is available. A failed, stale, unread or incomplete list is not a guess that
 * it is, so Codex is unavailable then.
 */
export function codexCandidateAt(state, { model: id, effort }, now = new Date()) {
  const standing = providerAt(state, 'codex', now);
  if (standing.status === 'failed') return { available: false, why: `the last codex poll failed: ${standing.failure.why}` };
  if (standing.status !== 'observed') return { available: false, why: `codex is ${standing.status}` };
  if (!standing.models) return { available: false, why: 'codex model/list was not read' };
  const listed = standing.models.find((entry) => entry.id === id);
  if (!listed) return { available: false, why: `${id} is not in the codex model list` };
  if (!listed.efforts.includes(effort)) return { available: false, why: `${id} does not offer effort ${effort}` };
  return { available: true, why: `${id} at ${effort} is in the codex model list` };
}
