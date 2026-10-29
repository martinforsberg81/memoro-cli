/**
 * The candidate a fast, large or review step runs on (ruling 59), decided from
 * the catalog and the local capacity snapshot alone.
 *
 * Pure: it reads no file, spends no model turn and writes nothing, and the one
 * instant it needs is `now`, passed in. The catalog is what `readModels`
 * returns (model-config.js); the snapshot is what `readCapacity` returns
 * (model-capacity.js). The runner reads this choice at each class launch.
 *
 * Available subscription candidates come first. If all lack plan capacity,
 * the first catalog candidate uses its provider's API reserve. Review keeps
 * its pinned model and uses the same provider's API at 100 %.
 *
 * A candidate is judged at `now` as:
 *   - refused: its provider refused and the refusal has not passed. Never chosen.
 *   - known: every window in force has a usage read and each is under
 *     PLAN_LIMIT_UTILIZATION. Its headroom is the remaining fraction of its tightest
 *     window, so a candidate is scored by its most restrictive window.
 *   - exhausted: a window in force is at or over PLAN_LIMIT_UTILIZATION.
 *     Never chosen until it resets.
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

/** Use the included plan until a reported window reaches its full limit. */
export const PLAN_LIMIT_UTILIZATION = 1;

const pct = (fraction) => `${Math.round(fraction * 100)} %`;
const latest = (instants) => instants.reduce((a, b) => (Date.parse(b) > Date.parse(a) ? b : a));
const earliest = (instants) => instants.reduce((a, b) => (Date.parse(b) < Date.parse(a) ? b : a));
const refused = (name, until) => ({ state: 'refused', headroom: null, retry_at: until, why: `${name} refused until ${until}` });

/** A provider's windows judged at `now`: `exhausted`, `unknown`, or `known` with its headroom. */
function windowStanding(name, standing) {
  const live = Object.values(standing.windows).filter((window) => window.status === 'known');
  const over = live.filter((window) => window.fraction_used >= PLAN_LIMIT_UTILIZATION);
  if (over.length) {
    const used = Math.max(...over.map((window) => window.fraction_used));
    return { state: 'exhausted', headroom: null, retry_at: latest(over.map((window) => window.resets_at)), why: `${name} is at ${pct(used)} of its plan limit` };
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
 * `pinned` (review on plan), `known` (the candidate with the most headroom; the
 * first in catalog order on a tie), `bootstrap` (the first claude candidate
 * with unknown capacity when no candidate is known), or `api`.
 *
 * `{ ok: false, transient: true, class, reason, retry_at }` when nothing can take
 * the class now. `retry_at` is the earliest instant that changes an answer (a
 * refusal passing, a window resetting), or null when none is known. Transient:
 * the step waits for it, it is not a block on the project.
 */
export function chooseCandidate({ cls, catalog, capacity, now = new Date() }) {
  if (cls === REVIEW_CLASS) {
    // Review is pinned to a model, but the plan limit still applies to it.
    const standing = providerAt(capacity, catalog.review.tool, now);
    const until = standing.refusal_until;
    if (until) return { ...answer(cls, catalog.review, 'api', null, `plan refused until ${until}; API reserve`), billing: 'credits' };
    const capacityNow = windowStanding(catalog.review.tool, standing);
    if (capacityNow.state === 'exhausted') return { ...answer(cls, catalog.review, 'api', null, `${capacityNow.why}; API reserve`), billing: 'credits' };
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
  const reserve = judged.find((entry) => ['exhausted', 'refused', 'unavailable'].includes(entry.state));
  if (reserve) return { ...answer(cls, reserve.candidate, 'api', null, `${reserve.why}; API reserve`), billing: 'credits' };
  const instants = judged.map((entry) => entry.retry_at).filter(Boolean);
  return {
    ok: false,
    transient: true,
    class: cls,
    reason: `no ${cls} candidate has capacity — ${judged.map((entry) => `${candidateSpec(entry.candidate)}: ${entry.why}`).join('; ')}`,
    retry_at: instants.length ? earliest(instants) : null,
  };
}
