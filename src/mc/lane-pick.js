/**
 * What a free lane takes next, of every kind of work on every repository.
 *
 * `mc run lanes <n>` is the total (lane-count.js): n lanes, none of them bound
 * to a repository or a kind. A lane that frees asks this for the next piece
 * of work, out of everything that could start now:
 *
 * - a `review` session — a project's review step, or a goal in review;
 * - a `build` session — a project's step (variant `project`) or a goal
 *   (variant `goal`).
 *
 * The order is finishing before starting: the project this lane has just run
 * goes on (a project holds its lane from its first step to its review), then
 * reviews, then a project's build, then a goal's. Within one of those, a step
 * the API cut off goes first (its cache is warm, ruling 33), and then the work
 * that has waited longest: the oldest `since`, which is when the work last
 * moved (a project's register entry, a goal's last log entry). A tie keeps the
 * order the candidates came in.
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

/** The rank of a kind, finishing first. */
function rankOf(item) {
  if (item.kind === 'review') return 0;
  return item.variant === 'goal' ? 2 : 1;
}

/**
 * `{ items, held, lanes, carry }` → the item to start, or null.
 *
 * `items`: `{ name, repo, kind: 'review'|'build', variant: 'project'|'goal',
 * since, resumed }` — everything that could start now, already without what
 * another lane holds. `held`: the repository of every session in flight on
 * this machine, one entry per session. `carry`: the name this lane ran a
 * moment ago, or null.
 */
export function pickWork({ items = [], held = [], lanes = 1, carry = null } = {}) {
  if (!items.length) return null;
  const holding = new Map();
  for (const repo of held) holding.set(repo, (holding.get(repo) || 0) + 1);
  const active = new Set([...held, ...items.map((item) => item.repo)]);
  const share = Math.ceil(Math.max(1, lanes) / Math.max(1, active.size));
  const full = (repo) => (holding.get(repo) || 0) >= share;
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
