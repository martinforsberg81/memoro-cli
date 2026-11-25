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
 * the models the provider lists where that is known, a refusal instant (the
 * provider's) with its cause and the instant it was first seen
 * (`refusal_cause`, `refusal_since`: additive, a refusal without a cause reads
 * as `quota`; under a `host` refusal, the `quota` or `login` one it was written
 * over, `refusal_under`, additive the same way), and per-model refusal instants (`model_refusals`, additive: a file
 * without it reads as none, an older mc ignores it), beside them the reviews each
 * model cut short in a row (`model_cut_short`, additive the same way) —
 * and, beside it, the last failure. A failure never erases the snapshot before
 * it; it says so. A window whose reset has passed is expired: its usage is
 * unknown, never zero.
 *
 * Nothing here spends a model turn. Claude's windows come from its usage read
 * (claude-capacity.js) and from the stream of a session that ran anyway
 * (billing.js `planWindows`); Codex's come from the read-only collector in
 * codex-capacity.js.
 *
 * The functions that read the state take `now`, so the tests pin every answer.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { writeJsonAtomic } from './atomic-write.js';
import { planWindows } from './billing.js';
import { adapterOfProvider, billingProviders } from '../adapters/index.js';
import { runnerDir } from './paths.js';

export const CAPACITY_SCHEMA = 'mc-model-capacity';
export const CAPACITY_VERSION = 1;
export const CAPACITY_FILE = 'model-capacity.json';
export const PROVIDERS = Object.freeze(billingProviders());
/** The windows each provider reports: Claude's five-hour and seven-day, Codex's primary and secondary. */
export const WINDOWS = Object.freeze(Object.fromEntries(PROVIDERS.map((provider) => [provider, adapterOfProvider(provider).PLAN_WINDOWS])));
/** An observation older than this is stale: still shown, but never read as current. Codex is polled hourly. */
export const STALE_MS = 3 * 60 * 60 * 1000;
/** How often the runner reads each provider's capacity, both collectors alike. */
export const CAPACITY_POLL_MS = 15 * 60 * 1000;
/**
 * What refused a whole provider: `quota` (a session's quota, or a read that
 * found the plan full), `login` (a login the plan cannot get past, read from a
 * session or a capacity read) or `host` (the host refuses the tool's settings,
 * run.js `refuseClaudeHost`). A clean capacity read lifts the first two; the
 * host check owns the third.
 */
export const REFUSAL_CAUSES = Object.freeze(['quota', 'login', 'host']);
/** The causes a capacity read that shows no spent window lifts. */
export const LIFTED_BY_READ = Object.freeze(['quota', 'login']);

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

/** `{ <model>: <ISO instant> }` of the models a provider refused, bad entries dropped; empty when the file has none. */
function modelRefusals(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return Object.fromEntries(Object.entries(value).filter(([id, until]) => id && iso(until)).map(([id, until]) => [id, until]));
}

/** `{ <model>: <count> }` of the reviews each model cut short in a row, bad or zero entries dropped; empty when the file has none. */
function cutShortCounts(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return Object.fromEntries(Object.entries(value).filter(([id, count]) => id && Number.isInteger(count) && count > 0));
}

/**
 * The `quota` or `login` refusal a `host` refusal was written over
 * (`{ until, cause, since }`), or null: it comes back when the host refusal is
 * cleared or passes, and a clean read lifts it.
 */
function refusalUnder(value) {
  const until = iso(value?.until);
  if (!until) return null;
  return { until, cause: LIFTED_BY_READ.includes(value?.cause) ? value.cause : 'quota', since: iso(value?.since) };
}

/** One provider as the file holds it, every bad field null or empty. Windows are null until something was observed. */
function normaliseProvider(raw, provider) {
  const observed = iso(raw?.observed_at);
  const windows = Object.fromEntries(WINDOWS[provider].map((name) => [name, observed ? window(raw?.windows?.[name]) : null]));
  const refused = iso(raw?.refusal_until);
  const cause = refused ? (REFUSAL_CAUSES.includes(raw?.refusal_cause) ? raw.refusal_cause : 'quota') : null;
  return {
    observed_at: observed,
    windows,
    models: observed && Array.isArray(raw?.models) ? raw.models.map(model).filter(Boolean) : null,
    refusal_until: refused,
    // A refusal written before causes were recorded is a quota's: that is all that wrote one then.
    refusal_cause: cause,
    refusal_since: refused ? iso(raw?.refusal_since) : null,
    refusal_under: cause === 'host' ? refusalUnder(raw?.refusal_under) : null,
    model_refusals: modelRefusals(raw?.model_refusals),
    model_cut_short: cutShortCounts(raw?.model_cut_short),
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

/**
 * Claude's windows of a successful usage read. A window the body does not carry
 * (`unread` 'absent') is absent and replaces the held one. A window the body
 * carries but that did not validate (any other word, or a read that names no
 * word) keeps the one the snapshot holds, as observeClaudeStream keeps a window
 * a stream does not carry; its own reset still governs it (windowsAt).
 */
function streamWindowsOf(provider, held, read, unread) {
  return Object.fromEntries(WINDOWS[provider].map((name) => [name, read?.[name] ?? (unread?.[name] === 'absent' ? null : held[name])]));
}

/** The windows of a provider that read as spent at `now`: known, at or above 100 %. */
function spentWindows(state, provider, now) {
  return Object.values(windowsAt(state, provider, now)).filter((seen) => seen.status === 'known' && seen.fraction_used >= 1);
}

/**
 * One completed collector read applied to the latest state, and what it says
 * about the provider's refusal: `{ state, clean, lifted }`. A concurrent
 * provider-local observation wins over an older in-flight success (the read is
 * dropped: not clean); a failure records its attempt while keeping the last
 * valid snapshot. A success is `clean` when the observation it leaves shows no
 * known window at or above 100 % and the reader saw no full limit
 * (`answer.full`); a clean read lifts a live `quota` or `login` refusal of the
 * provider, and `lifted` is `{ cause, until }` of the one it lifted. A `host`
 * refusal and the model refusals are left alone. The caller holds the short
 * runner lock around this synchronous read-patch-write only.
 */
export function collectedCapacity(state, provider, answer, now = new Date(), baseline = null) {
  const current = normaliseCapacity(state);
  const changed = baseline !== null && JSON.stringify(current.providers[provider]) !== baseline;
  if (answer?.ok && changed) return { state: current, clean: false, lifted: null };
  if (!answer?.ok) return { state: applyFailure(current, provider, { why: answer?.why || 'subscription read failed' }, now), clean: false, lifted: null };
  const observed = applyObservation(current, provider, {
    windows: adapterOfProvider(provider)?.PLAN_STATE != null ? streamWindowsOf(provider, current.providers[provider].windows, answer.windows, answer.unread) : answer.windows,
    models: answer.models ?? null,
  }, now);
  const clean = answer.full !== true && spentWindows(observed, provider, now).length === 0;
  const held = standingRefusal(observed.providers[provider], now);
  if (!clean || !held) return { state: observed, clean, lifted: null };
  // A host refusal stays with its check; a quota or login one held under it is lifted, and the provider is still refused.
  if (held.cause === 'host') return { state: held.under ? withProvider(observed, provider, { refusal_under: null }) : observed, clean, lifted: null };
  return { state: applyRefusal(observed, provider, null, null, now), clean, lifted: { cause: held.cause, until: held.until } };
}

/**
 * The provider refusal in force at `now`, `{ until, cause, since, under }`, or
 * null: the recorded one while it is live, else the one held under a host
 * refusal that has passed. `under` is the quota or login refusal still live
 * under a live host refusal, else null.
 */
function standingRefusal(current, now) {
  const under = current.refusal_under && after(current.refusal_under.until, now) ? current.refusal_under : null;
  if (after(current.refusal_until, now)) return { until: current.refusal_until, cause: current.refusal_cause, since: current.refusal_since, under };
  return under ? { ...under, under: null } : null;
}

/** The later-end rule between two quota or login refusals (`{ until, cause, since }`): the same cause keeps its first instant, else the later end wins. */
function laterRefusal(held, fresh) {
  if (!held) return fresh;
  const later = Date.parse(fresh.until) > Date.parse(held.until);
  if (fresh.cause === held.cause) return { until: later ? fresh.until : held.until, cause: held.cause, since: held.since ?? fresh.since };
  return later ? fresh : held;
}

const recorded = (refusal, under = null) => ({ refusal_until: refusal?.until ?? null, refusal_cause: refusal?.cause ?? null, refusal_since: refusal?.since ?? null, refusal_under: under });

/** The state `collectedCapacity` leaves. */
export function applyCollectedCapacity(state, provider, answer, now = new Date(), baseline = null) {
  return collectedCapacity(state, provider, answer, now, baseline).state;
}

/**
 * The instant a provider refused until, or null to clear it, and its `cause`
 * (REFUSAL_CAUSES; anything else is `quota`). With a `model`, the refusal is
 * that model's alone (`model_refusals`): the provider's other models stay
 * eligible, and a passed instant of another model is dropped on the way.
 *
 * Over a provider refusal in force at `now` (standingRefusal): the same cause
 * renewed keeps the instant first seen and takes the later end. A `host`
 * refusal is never replaced by a `quota` or `login` one: that one is held
 * under it (`refusal_under`, by the same rule between the two). A `host`
 * refusal over a `quota` or `login` one takes over with its own end, and holds
 * that one under it, so the host check's clear brings it back and a clean read
 * can lift it. Between `quota` and `login` the later end wins, with its cause,
 * first seen `now`. A refusal over none is first seen `now`. Clearing (`until`
 * null) brings back a refusal held under the one cleared while that is live.
 */
export function applyRefusal(state, provider, until, model = null, now = new Date(), cause = 'quota') {
  if (!model) {
    const end = iso(until);
    const held = standingRefusal(normaliseCapacity(state).providers[provider], now);
    if (!end) return withProvider(state, provider, recorded(held?.under ?? null));
    const kind = REFUSAL_CAUSES.includes(cause) ? cause : 'quota';
    const fresh = { until: end, cause: kind, since: now.toISOString() };
    if (!held) return withProvider(state, provider, recorded(fresh));
    if (kind === 'host' && held.cause === 'host') return withProvider(state, provider, recorded(laterRefusal(held, fresh), held.under));
    if (held.cause === 'host') return withProvider(state, provider, recorded(held, laterRefusal(held.under, fresh)));
    if (kind === 'host') return withProvider(state, provider, recorded(fresh, { until: held.until, cause: held.cause, since: held.since }));
    return withProvider(state, provider, recorded(laterRefusal(held, fresh)));
  }
  const held = normaliseCapacity(state).providers[provider].model_refusals;
  const live = Object.fromEntries(Object.entries(held).filter(([id, at]) => id !== model && after(at, now)));
  return withProvider(state, provider, { model_refusals: iso(until) ? { ...live, [model]: iso(until) } : live });
}

/** How many reviews in a row `model` of `provider` cut short (`model_cut_short`); 0 when none. */
export function cutShortCount(state, provider, model) {
  return normaliseCapacity(state).providers[provider].model_cut_short[model] ?? 0;
}

/**
 * The state with `model`'s count of reviews cut short in a row set to `count`;
 * 0 removes it. Kept beside the model's refusals, so a restarted runner keeps it.
 */
export function applyCutShort(state, provider, model, count) {
  const held = normaliseCapacity(state).providers[provider].model_cut_short;
  const rest = Object.fromEntries(Object.entries(held).filter(([id]) => id !== model));
  return withProvider(state, provider, { model_cut_short: count > 0 ? { ...rest, [model]: count } : rest });
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
  const provider = PROVIDERS.find((name) => adapterOfProvider(name).PLAN_STATE === 'claude-stream');
  if (!provider) return current;
  const previous = current.providers[provider].windows;
  return applyObservation(current, provider, {
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
 * models, and its refusal, with its cause and first instant seen, while that
 * has not passed.
 */
export function providerAt(state, provider, now = new Date()) {
  const current = normaliseCapacity(state).providers[provider];
  const stale = current.observed_at !== null && now.getTime() - Date.parse(current.observed_at) > STALE_MS;
  const status = current.failure ? 'failed' : current.observed_at === null ? 'unobserved' : stale ? 'stale' : 'observed';
  const refusal = standingRefusal(current, now);
  return {
    status,
    observed_at: current.observed_at,
    stale,
    failure: current.failure,
    windows: windowsAt(state, provider, now),
    models: current.models,
    refusal_until: refusal?.until ?? null,
    refusal_cause: refusal?.cause ?? null,
    refusal_since: refusal?.since ?? null,
    model_refusals: Object.fromEntries(Object.entries(current.model_refusals).filter(([, until]) => after(until, now))),
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
