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
 * With no eligible carry, review and plan tie at the first rank, then legacy
 * project builds, then goal builds. Within a rank, `resumed` sorts first (the
 * current goal caller sets it false), then oldest `since` (goal log time, or
 * the programme wakeup's empty/oldest value), then input order. A surviving
 * carry is chosen before that ordering: it wins within the fair set regardless
 * of rank, age, or `resumed`.
 *
 * **No repository takes every lane while another waits.** Each repository
 * with work, or with a session running, has a share of the lanes:
 * `ceil(lanes / repositories)`. While any repository below its share has work
 * that can start, work on a repository at or above its share is not picked,
 * whatever its kind or its wait — and that includes the project a lane would
 * otherwise carry on with. With two repositories and two lanes or more, the
 * share is at most `lanes − 1`, so one repository can only reach the last
 * lane when the other has nothing to start; and a repository that holds every
 * lane because the other was idle gives up the next lane that frees as soon
 * as the other has work. With one lane, one repository holds it by
 * necessity, and the two take turns by their wait.
 */

/** The rank of a kind, finishing first: a plan session unblocks a goal, and ranks with a review. */
function rankOf(item) {
  if (item.kind === 'review' || item.kind === 'plan') return 0;
  return item.variant === 'goal' ? 2 : 1;
}

/**
 * `{ items, held, lanes, carry }` → the item to start, or null. `lanes` is
 * the machine-wide lane cap, not a per-repository allowance.
 *
 * `items`: `{ name, repo, kind: 'review'|'plan'|'build', variant: 'project'|'goal'|null,
 * since, resumed }` — caller-approved candidates. `variant: 'project'` and
 * project build/review kinds are retained for compatibility, although
 * `run.js` currently supplies goal sessions only. `held`: one repository per
 * in-flight session known to the caller. `carry`: the name this lane ran a
 * moment ago, or null.
 */
export function pickWork({ items = [], held = [], lanes = 1, carry = null } = {}) {
  if (!items.length) return null;
  const holding = new Map();
  for (const repo of held) holding.set(repo, (holding.get(repo) || 0) + 1);
  const active = new Set([...held, ...items.map((item) => item.repo)]);
  const share = Math.ceil(Math.max(1, lanes) / Math.max(1, active.size));
  const full = (repo) => (holding.get(repo) || 0) >= share;
  // If any candidate repository is below its share, exclude full repositories;
  // otherwise all candidates remain eligible. Carry cannot bypass this filter.
  const fair = items.some((item) => !full(item.repo)) ? items.filter((item) => !full(item.repo)) : items;
  const carried = carry ? fair.find((item) => item.name === carry) : null;
  if (carried) return carried;
  const ordered = fair.map((item, index) => ({ item, index })).sort((a, b) => rankOf(a.item) - rankOf(b.item)
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
