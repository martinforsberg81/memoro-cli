/**
 * The candidate a list's session runs on (ruling 59) — a work class (fast,
 * large) for build, or a role list (review, finish, mend, plan, manager) — decided from
 * the catalog and the local capacity snapshot alone.
 *
 * Pure: it reads no file, spends no model turn and writes nothing, and the one
 * instant it needs is `now`, passed in. The catalog is what `readModels`
 * returns (model-config.js); the snapshot is what `readCapacity` returns
 * (model-capacity.js). The runner reads this choice at each class launch.
 *
 * In `auto`, available subscriptions rank by headroom, with catalog order on a
 * tie. A provider priority ranks its eligible subscription candidates first,
 * and the other provider's eligible subscriptions before either API reserve.
 *
 * Review's first candidate is its first choice: it runs whenever it can (not
 * refused, not exhausted, its tool launchable, and known under the plan limit or
 * unknown on a tool that bootstraps). Only build-model avoidance outranks it:
 * when the first candidate's model built the goal, or when the caller says the
 * catalog's first is not in the list (`first: null`, having removed
 * the author), the ranking below chooses, as it does among the rest when the
 * first cannot run.
 *
 * Otherwise review chooses the plan with most known headroom. On equal headroom
 * it prefers a model other than the build model, then catalog order. Unknown
 * capacity ranks after measured capacity. API reserve remains the fallback, and
 * it takes only a candidate whose tool declares an API route (`apiProviders()`):
 * a tool with none is never launched on a spent or refusing plan, and when no
 * candidate has a route the list waits (`ok: false, transient: true`).
 *
 * Whether a tool can launch is the caller's to say (`launchable`, a tool name
 * to a boolean): this module reads no file and no process. The default says yes.
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
import { apiProviders, declared } from '../adapters/index.js';
import { candidateSpec, LISTS } from './model-config.js';
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

/** Whether a tool's plan may carry a choice while its capacity is unknown: the adapter's standing rule. */
const bootstraps = (tool) => declared(tool, 'MODEL_CHOICE')?.bootstrapsOnUnknown === true;

/** One candidate judged at `now`: `{ state, headroom, retry_at, why }`. */
function judge(capacity, candidate, now) {
  const provider = declared(candidate.tool, 'BILLING_PROVIDER');
  const rule = declared(candidate.tool, 'MODEL_CHOICE');
  if (!provider || !rule) return { state: 'unavailable', headroom: null, retry_at: null, why: `${candidate.tool} declares no ${provider ? 'MODEL_CHOICE' : 'BILLING_PROVIDER'}` };
  const standing = providerAt(capacity, provider, now);
  if (standing.refusal_until) return refused(provider, standing.refusal_until);
  // A model-scoped quota refused this model alone: the provider's others stay candidates.
  const spent = candidate.model ? standing.model_refusals[candidate.model] : null;
  if (spent) return refused(`${provider}:${candidate.model}`, spent);
  if (rule.perModel) {
    const listed = codexCandidateAt(capacity, candidate, now);
    if (!listed.available) return { state: 'unavailable', headroom: null, retry_at: null, why: listed.why };
  }
  return windowStanding(provider, standing);
}

/** Whether a candidate's tool declares an API route its reserve can use. */
const hasApiRoute = (candidate) => apiProviders().includes(declared(candidate.tool, 'BILLING_PROVIDER'));
const sameCandidate = (a, b) => a.tool === b.tool && a.model === b.model && a.effort === b.effort;

/** The wait a list answers when its reserve has no candidate to take: each candidate and why, "no API route" where it has none. */
function waiting(cls, judged) {
  const instants = judged.map((entry) => entry.retry_at).filter(Boolean);
  return {
    ok: false,
    transient: true,
    class: cls,
    reason: `no ${cls} candidate has capacity — ${judged.map((entry) => `${candidateSpec(entry.candidate)}: ${entry.why}${hasApiRoute(entry.candidate) ? '' : '; no API route'}`).join('; ')}`,
    retry_at: instants.length ? earliest(instants) : null,
  };
}

const answer = (cls, candidate, basis, headroom, why) => ({ ok: true, class: cls, candidate, spec: candidateSpec(candidate), basis, headroom, why });

/**
 * Review takes its first candidate when it can run; otherwise it ranks provider preference first, then plan
 * headroom, and build-model avoidance breaks ties. `first` is the catalog's first candidate: absent, the list's
 * own first; `null`, none (the catalog's first is not in this list).
 */
function chooseReview(cls, catalog, capacity, now, avoid, priority = 'auto', launchable = () => true, first = undefined) {
  const list = catalog.review;
  const builtOn = (value) => Boolean(avoid?.model) && value.model === avoid.model;
  const others = list.filter((value) => !builtOn(value));
  const order = [...others, ...list.filter(builtOn)];
  const judged = order.map((value) => (launchable(value.tool)
    ? { candidate: value, ...judge(capacity, value, now) }
    : { candidate: value, state: 'unavailable', headroom: null, retry_at: null, why: `${value.tool} cannot be launched here` }));
  const firstCandidate = first === undefined ? list[0] : first;
  const firstEntry = firstCandidate && !builtOn(firstCandidate) ? judged.find((entry) => sameCandidate(entry.candidate, firstCandidate)) : null;
  if (firstEntry && (firstEntry.state === 'known' || (firstEntry.state === 'unknown' && bootstraps(firstEntry.candidate.tool)))) {
    return answer(cls, firstEntry.candidate, firstEntry.state === 'unknown' && priority !== 'auto' ? 'bootstrap' : 'preferred', firstEntry.headroom ?? null, `review candidate ${list.indexOf(firstEntry.candidate) + 1}, the first choice — ${firstEntry.why}`);
  }
  const passed = (entry) => `${candidateSpec(entry.candidate)}: ${entry.why}`;
  const allKnown = judged.some((entry) => entry.state === 'known');
  const eligible = judged.filter((entry) => entry.state === 'known' || (!allKnown && entry.state === 'unknown' && bootstraps(entry.candidate.tool)));
  const preferred = priority === 'auto' ? eligible : eligible.filter((entry) => entry.candidate.tool === priority);
  // An explicit subscription priority is an attempted launch even when its
  // usage is unknown/stale; a known alternative must not silently override it.
  const preferredBootstrap = priority !== 'auto' && !preferred.length
    ? judged.filter((entry) => entry.candidate.tool === priority && entry.state === 'unknown' && bootstraps(entry.candidate.tool))
    : [];
  const selectedPool = preferred.length ? preferred : preferredBootstrap.length ? preferredBootstrap : eligible;
  const best = selectedPool.reduce((a, b) => !a || (b.headroom ?? -1) > (a.headroom ?? -1) ? b : a, null);
  const index = judged.indexOf(best);
  if (index >= 0) {
    const chosen = judged[index];
    const same = builtOn(chosen.candidate);
    const priorityOverridesHeadroom = priority !== 'auto' && chosen.candidate.tool === priority
      && eligible.some((entry) => (entry.headroom ?? -1) > (chosen.headroom ?? -1));
    const reasons = same
      ? [...(priority !== 'auto' && chosen.candidate.tool === priority ? [`${priority} provider priority`] : []), ...judged.slice(0, index).map(passed), `${avoid.tool} ${avoid.model} built it${eligible.some((entry) => !builtOn(entry.candidate)) ? (priorityOverridesHeadroom ? "; provider priority overrides a roomier alternative" : "; its plan has the most headroom") : ", and no other candidate can run on its plan"}`]
      : [...(priority !== 'auto' && chosen.candidate.tool === priority ? [`${priority} provider priority`] : []), ...(others.length < list.length ? [`${avoid.tool} ${avoid.model} built it`] : []), ...judged.slice(0, index).map(passed)];
    const place = `review candidate ${list.indexOf(chosen.candidate) + 1}`;
    const fallback = priority !== 'auto' && chosen.candidate.tool !== priority ? `; ${priority} unavailable on subscription, ${chosen.candidate.tool} subscription fallback` : '';
    return answer(cls, chosen.candidate, chosen.state === 'unknown' && priority !== 'auto' ? 'bootstrap' : 'preferred', chosen.headroom ?? null, `${reasons.length ? `${place} — ${reasons.join('; ')}` : `${place}, the first`}${fallback}`);
  }
  const ordered = priority === 'auto' ? judged : [...judged.filter((entry) => entry.candidate.tool === priority), ...judged.filter((entry) => entry.candidate.tool !== priority)];
  const reserve = ordered.find((entry) => hasApiRoute(entry.candidate) && launchable(entry.candidate.tool));
  if (!reserve) return waiting(cls, judged);
  const priorityWhy = priority === 'auto' ? '' : `; ${priority} priority has no usable subscription`;
  return { ...answer(cls, reserve.candidate, 'api', null, `${judged.map(passed).join('; ')}${priorityWhy}; API reserve`), billing: 'credits' };
}

/**
 * The candidate a list runs on. Decision takes the first usable subscription
 * in catalog order; the other lists balance capacity (review also avoids the
 * build model). Each judges its own candidates only: a role list never borrows a class's.
 *
 * `{ ok: true, class, candidate, spec, basis, headroom, why }`, where `basis` is
 * `preferred` (the review candidate with most headroom), `known` (the candidate with the most headroom; the
 * first in catalog order on a tie), `bootstrap` (the first claude candidate
 * with unknown capacity when no candidate is known), or `api`.
 *
 * `{ ok: false, transient: true, class, reason, retry_at }` when nothing can take
 * the class now. `retry_at` is the earliest instant that changes an answer (a
 * refusal passing, a window resetting), or null when none is known. Transient:
 * the step waits for it, it is not a block on the project.
 *
 * `avoid` (`{ tool, model }`, review only) is the model a goal's last build
 * session ran on: review avoids it on equal headroom, and uses the API
 * reserve only when no candidate can run on its plan. `launchable` and `first`
 * are review's too: whether a tool can launch (a function of the tool's name,
 * default yes), and the catalog's first candidate when the list given is a
 * reduction of it (`null` when the reduction removed it).
 */
export function chooseCandidate({ cls, catalog, capacity, now = new Date(), avoid = null, priority = 'auto', launchable = () => true, first }) {
  if (cls === REVIEW_CLASS) return chooseReview(cls, catalog, capacity, now, avoid, priority, launchable, first);
  if (!LISTS.includes(cls)) throw new Error(`"${cls}" is not a list — ${LISTS.join(', ')}`);
  const judged = catalog[cls].map((candidate) => ({ candidate, ...judge(capacity, candidate, now) }));
  if (cls === 'decision') {
    const usable = judged.find(entry => entry.state === 'known' || (entry.state === 'unknown' && bootstraps(entry.candidate.tool)));
    if (usable) return answer(cls, usable.candidate, usable.state === 'known' ? 'known' : 'bootstrap', usable.headroom, `${usable.why}; first usable decision candidate`);
  }
  if (priority !== 'auto') {
    const known = judged.filter((entry) => entry.state === 'known');
    const usable = known.length ? known : judged.filter((entry) => entry.state === 'unknown' && bootstraps(entry.candidate.tool));
    const preferred = usable.filter((entry) => entry.candidate.tool === priority);
    const preferredBootstrap = bootstraps(priority) && !preferred.length
      ? judged.filter((entry) => entry.candidate.tool === priority && entry.state === 'unknown')
      : [];
    const pool = preferred.length ? preferred : preferredBootstrap.length ? preferredBootstrap : usable;
    if (pool.length) {
      const best = pool.reduce((a, b) => (b.headroom ?? -1) > (a.headroom ?? -1) ? b : a);
      const fallback = best.candidate.tool === priority ? '' : `; ${priority} unavailable on subscription, ${best.candidate.tool} subscription fallback`;
      return answer(cls, best.candidate, best.state === 'unknown' ? 'bootstrap' : 'known', best.headroom, `${best.why} — ${priority} provider priority${fallback}`);
    }
    const ordered = [...judged.filter((entry) => entry.candidate.tool === priority), ...judged.filter((entry) => entry.candidate.tool !== priority)];
    const reserve = ordered.find((entry) => ['exhausted', 'refused', 'unavailable'].includes(entry.state) && hasApiRoute(entry.candidate));
    if (reserve) return { ...answer(cls, reserve.candidate, 'api', null, `${reserve.why}; ${priority} priority has no usable subscription; API reserve`), billing: 'credits' };
  }
  const known = judged.filter((entry) => entry.state === 'known');
  if (known.length) {
    const best = known.reduce((a, b) => (b.headroom > a.headroom ? b : a));
    return answer(cls, best.candidate, 'known', best.headroom, best.why);
  }
  const bootstrap = judged.find((entry) => entry.state === 'unknown' && bootstraps(entry.candidate.tool));
  if (bootstrap) return answer(cls, bootstrap.candidate, 'bootstrap', null, `${bootstrap.why} — bootstrapped on the included plan`);
  const reserve = judged.find((entry) => ['exhausted', 'refused', 'unavailable'].includes(entry.state) && hasApiRoute(entry.candidate));
  if (reserve) return { ...answer(cls, reserve.candidate, 'api', null, `${reserve.why}; API reserve`), billing: 'credits' };
  return waiting(cls, judged);
}
