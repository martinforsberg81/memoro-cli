/**
 * The candidate a fast, large or review step runs on (ruling 59), decided from
 * the catalog and the local capacity snapshot alone.
 *
 * Pure: it reads no file, spends no model turn and writes nothing, and the one
 * instant it needs is `now`, passed in. The catalog is what `readModels`
 * returns (model-config.js); the snapshot is what `readCapacity` returns
 * (model-capacity.js). Nothing here is wired into the runner yet.
 *
 * Only subscriptions are candidates: claude on the Max plan, codex on the
 * ChatGPT plan. No credit is a candidate in any billing mode. Review is not
 * chosen: it is the catalog's one review candidate, returned as it stands —
 * unless its provider refused and the refusal has not passed, which is a
 * transient no-capacity until it does, never another model.
 *
 * A candidate is judged at `now` as:
 *   - refused: its provider refused and the refusal has not passed. Never chosen.
 *   - known: every window in force has a usage read and each is under
 *     RESERVE_UTILIZATION. Its headroom is the remaining fraction of its tightest
 *     window, so a candidate is scored by its most restrictive window.
 *   - reserved: a window in force is at or over RESERVE_UTILIZATION. The last
 *     fifth is kept for Martin's interactive work. Never chosen until it resets.
 *   - unknown: no window in force has a usable read. A window whose reset has
 *     passed is expired, not empty. A claude read older than STALE_MS is not
 *     current either: usage only grows inside a window, so an old high reading
 *     still holds and an old low one proves nothing. Only claude may bootstrap
 *     on an unknown plan, because no quota read API is wired for it.
 *   - unavailable (codex only): no fresh successful rate-limit and model-list
 *     read, or the model is not listed at the effort. The collector does not
 *     read the account type. A successful `account/rateLimits/read` is taken as
 *     the ChatGPT entitlement and a failed one as its absence. That is an
 *     inference; an `account/read` would make it a fact.
 */
import { candidateSpec, CLASSES } from './model-config.js';
import { codexCandidateAt, providerAt, STALE_MS } from './model-capacity.js';
import { REVIEW_CLASS } from './plan-schema.js';

/** The fraction a window may reach for automatic choice. The rest is kept for Martin's interactive work. */
export const RESERVE_UTILIZATION = 0.8;

const pct = (fraction) => `${Math.round(fraction * 100)} %`;
const latest = (instants) => instants.reduce((a, b) => (Date.parse(b) > Date.parse(a) ? b : a));
const earliest = (instants) => instants.reduce((a, b) => (Date.parse(b) < Date.parse(a) ? b : a));
const refused = (name, until) => ({ state: 'refused', headroom: null, retry_at: until, why: `${name} refused until ${until}` });

/** A provider's windows judged at `now`: `reserved`, `unknown`, or `known` with its headroom. */
function windowStanding(name, standing) {
  const live = Object.values(standing.windows).filter((window) => window.status === 'known');
  const over = live.filter((window) => window.fraction_used >= RESERVE_UTILIZATION);
  if (over.length) {
    const used = Math.max(...over.map((window) => window.fraction_used));
    return { state: 'reserved', headroom: null, retry_at: latest(over.map((window) => window.resets_at)), why: `${name} is at ${pct(used)} — its last fifth is kept for interactive use` };
  }
  if (live.length === 0) return { state: 'unknown', headroom: null, retry_at: null, why: `${name} usage is unknown — its windows are unseen or have reset` };
  if (standing.stale) return { state: 'unknown', headroom: null, retry_at: null, why: `${name} was last read more than ${STALE_MS / 3_600_000} h ago` };
  const headroom = Math.min(...live.map((window) => 1 - window.fraction_used));
  return { state: 'known', headroom, retry_at: null, why: `${name} has ${pct(headroom)} headroom` };
}

/** One candidate judged at `now`: `{ state, headroom, retry_at, why }`. */
function judge(capacity, candidate, now) {
  if (candidate.tool === 'claude') {
    const standing = providerAt(capacity, 'claude', now);
    return standing.refusal_until ? refused('claude', standing.refusal_until) : windowStanding('claude', standing);
  }
  const standing = providerAt(capacity, 'codex', now);
  if (standing.refusal_until) return refused('codex', standing.refusal_until);
  const listed = codexCandidateAt(capacity, candidate, now);
  if (!listed.available) return { state: 'unavailable', headroom: null, retry_at: null, why: listed.why };
  return windowStanding('codex', standing);
}

const answer = (cls, candidate, basis, headroom, why) => ({ ok: true, class: cls, candidate, spec: candidateSpec(candidate), basis, headroom, why });

/**
 * The candidate a class runs on.
 *
 * `{ ok: true, class, candidate, spec, basis, headroom, why }`, where `basis` is
 * `pinned` (review), `known` (the candidate with the most headroom; the first in
 * catalog order on a tie) or `bootstrap` (the first claude candidate with unknown
 * capacity, when no candidate is known).
 *
 * `{ ok: false, transient: true, class, reason, retry_at }` when nothing can take
 * the class now. `retry_at` is the earliest instant that changes an answer (a
 * refusal passing, a window resetting), or null when none is known. Transient:
 * the step waits for it, it is not a block on the project.
 */
export function chooseCandidate({ cls, catalog, capacity, now = new Date() }) {
  if (cls === REVIEW_CLASS) {
    // Never routed, so its usage is not scored and its reserve not kept; but a
    // provider that refused is refused for review too, and review waits for it.
    const until = providerAt(capacity, catalog.review.tool, now).refusal_until;
    if (until) return { ok: false, transient: true, class: cls, reason: `the review model ${candidateSpec(catalog.review)}: ${refused(catalog.review.tool, until).why}`, retry_at: until };
    return answer(cls, catalog.review, 'pinned', null, 'review is the catalog\'s review model, never routed');
  }
  if (!CLASSES.includes(cls)) throw new Error(`"${cls}" is not a class — fast, large or review`);
  const judged = catalog[cls].map((candidate) => ({ candidate, ...judge(capacity, candidate, now) }));
  const known = judged.filter((entry) => entry.state === 'known');
  if (known.length) {
    const best = known.reduce((a, b) => (b.headroom > a.headroom ? b : a));
    return answer(cls, best.candidate, 'known', best.headroom, best.why);
  }
  const bootstrap = judged.find((entry) => entry.state === 'unknown' && entry.candidate.tool === 'claude');
  if (bootstrap) return answer(cls, bootstrap.candidate, 'bootstrap', null, `${bootstrap.why} — bootstrapped on the included plan`);
  const instants = judged.map((entry) => entry.retry_at).filter(Boolean);
  return {
    ok: false,
    transient: true,
    class: cls,
    reason: `no ${cls} candidate has capacity — ${judged.map((entry) => `${candidateSpec(entry.candidate)}: ${entry.why}`).join('; ')}`,
    retry_at: instants.length ? earliest(instants) : null,
  };
}
