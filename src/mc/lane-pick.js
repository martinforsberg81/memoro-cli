/**
 * What a free lane takes next from the candidates the runner supplies.
 *
 * `run.js`'s `nextWork` supplies only startable goal sessions today:
 *
 * - `review` for a goal in review;
 * - `plan` for a blocked goal, a goal in finish or merge after a red, and the
 *   programme wakeup after all its goals are done;
 * - `build` for a goal in build.
 *
 * Goals are gated before picking: `goalWork` uses `goalSession`, the goal's
 * first repository, and `phaseOpen` (goals in the lowest unfinished valid
 * phase run side by side; later phases wait for lower goals to finish). It
 * also excludes claims/current session files and reviews without an available
 * route. The runner does not schedule project steps. `variant: 'project'` and
 * project-shaped build/review items remain accepted legacy inputs to this
 * picker; they do not describe today's runner candidates.
 *
 * Blocked recovery goes first, then finish/merge, review, build and next-step
 * planning. Within the earliest runnable rank, repository fairness reserves a
 * share (`ceil(lanes / repositories)`) before programme priority, highest first.
 * Carry, resumed work and oldest wait break remaining ties. A carried build
 * never jumps ahead of a review or recovery. A repository with work in the
 * earliest rank may take every lane while others have only lower-ranked work.
 * Running sessions are never interrupted.
 */

/** Finish work already started before commissioning more. Eligibility is the caller's. */
function rankOf(item) {
  if (item.goal?.reason === 'next_step') return 5;
  if (item.goal?.status === 'blocked') return 0;
  if (item.kind === 'plan') return 1;
  if (item.kind === 'review') return 2;
  return item.variant === 'goal' ? 4 : 3;
}

const priorityOf = (item) => Number.isSafeInteger(item.priority) && item.priority >= 0 ? item.priority : 0;

/**
 * `{ items, held, lanes, carry }` → the item to start, or null. `lanes` is
 * the machine-wide lane cap, not a per-repository allowance.
 *
 * `items`: `{ name, repo, kind: 'review'|'plan'|'build', variant: 'project'|'goal'|null,
 * since, resumed, priority }` — caller-approved candidates. `variant: 'project'` and
 * project build/review kinds are retained for compatibility, although
 * `run.js` currently supplies goal sessions only. `held`: one repository per
 * in-flight session known to the caller. `carry`: the name this lane ran a
 * moment ago, or null.
 */
export function pickWork({ items = [], held = [], lanes = 1, carry = null } = {}) {
  if (!items.length) return null;
  const holding = new Map();
  for (const repo of held) holding.set(repo, (holding.get(repo) || 0) + 1);
  const rank = Math.min(...items.map(rankOf));
  const ranked = items.filter((item) => rankOf(item) === rank);
  const active = new Set([...held, ...ranked.map((item) => item.repo)]);
  const share = Math.ceil(Math.max(1, lanes) / Math.max(1, active.size));
  const full = (repo) => (holding.get(repo) || 0) >= share;
  // If any candidate repository is below its share, exclude full repositories;
  // otherwise all candidates remain eligible. Carry cannot bypass this filter.
  const fair = ranked.some((item) => !full(item.repo)) ? ranked.filter((item) => !full(item.repo)) : ranked;
  const ordered = fair.map((item, index) => ({ item, index })).sort((a, b) => priorityOf(b.item) - priorityOf(a.item)
    || Number(b.item.name === carry) - Number(a.item.name === carry)
    || Number(Boolean(b.item.resumed)) - Number(Boolean(a.item.resumed))
    || waitedSince(a.item) - waitedSince(b.item)
    || a.index - b.index);
  return ordered[0].item;
}

/** `since` as milliseconds; none, or one that does not parse, is the oldest of all. */
function waitedSince(item) {
  const t = Date.parse(item.since ?? '');
  return Number.isNaN(t) ? -Infinity : t;
}

/** The share of the lanes one repository may hold while another waits. */
export function laneShare(lanes, repositories) {
  return Math.ceil(Math.max(1, lanes) / Math.max(1, repositories));
}
