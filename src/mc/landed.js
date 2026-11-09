/**
 * What landed in the last 24 hours, and what it took: the hero frame's
 * outcome lines (docs/technical/mc-ui.md, "Manager header").
 *
 * Read from runs.tsv alone. A merge row whose note says `merged` is one pull
 * request on main; a row named `goal:<programme>/<goal>` is a goal's, every
 * other merge row (named after its repository) is a pull request without a
 * goal. A landed goal's effort is every build, review, finish and mend row
 * it ever had, summed over its whole life, not only the day, because a goal
 * landed today may have been built yesterday. Its planning is not the goal's:
 * the headless plan rows are `plan_cost`, beside the interactive sessions.
 */
import { rowCost } from './prices.js';
import { RUNNER_MODEL } from './status-collect.js';
import { RUNS_HEADER } from './run-plan.js';

export const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * The histogram's buckets of session time per goal, in minutes: upper bounds,
 * the last open. Doubling widths, since the spread is roughly log-normal
 * (2026-11-09: median 50 min, p90 149, max 309).
 */
export const TIME_BUCKETS_MIN = Object.freeze([15, 30, 60, 120, 240, Infinity]);

/**
 * runs.tsv rows as objects. The file keeps the header it was created with,
 * and columns were appended since (`RUNS_HEADER`, run-plan.js), so a shorter
 * header that is a prefix of the current one reads with the current one —
 * otherwise `model` and the rest are dropped and nothing can be priced.
 */
export function readRunRows(tsv) {
  const lines = String(tsv || '').split('\n').filter((line) => line.trim());
  if (!lines.length) return [];
  const own = lines[0].split('\t');
  const header = own.length < RUNS_HEADER.length && own.every((key, i) => RUNS_HEADER[i] === key) ? RUNS_HEADER : own;
  return lines.slice(1).map((line) => {
    const cells = line.split('\t');
    return Object.fromEntries(header.map((key, i) => [key, cells[i] ?? '']));
  });
}

const number = (value) => {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
};

/** The value at fraction `p` of a sorted list (nearest rank). */
function quantile(sorted, p) {
  if (!sorted.length) return null;
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1))];
}

/**
 * The landed section: `goals` and `without_goal` count distinct goals and
 * pull requests merged since `now - 24 h`; `attempts` is every merge row in
 * that window, landed or not. `time` and `cost` are per landed goal.
 */
export function landedSection({ rows = [], now = new Date() } = {}) {
  const since = now.getTime() - DAY_MS;
  const inDay = (row) => {
    const ts = Date.parse(row.ts);
    return Number.isFinite(ts) && ts >= since && ts <= now.getTime();
  };
  const merges = rows.filter((row) => row.kind === 'merge' && inDay(row));
  const landed = merges.filter((row) => String(row.note || '').split(',').includes('merged'));
  const goals = [...new Set(landed.filter((row) => row.name?.startsWith('goal:')).map((row) => row.name))];
  const withoutGoal = new Set(landed.filter((row) => !row.name?.startsWith('goal:')).map((row) => `${row.name}#${row.pr}`));

  const effort = new Map(goals.map((name) => [name, { seconds: 0, sessions: 0, cost: 0, priced: 0, unpriced: 0, again: false }]));
  for (const row of rows) {
    const goal = effort.get(row.name);
    // A goal's own work: its merge rows are the merger's, and its planning is
    // counted with the planning, not the goal (Martin, 2026-11-09).
    if (!goal || row.kind === 'merge' || row.kind === 'plan') continue;
    goal.seconds += number(row.seconds);
    goal.sessions += 1;
    if (row.kind === 'finish' || row.kind === 'mend') goal.again = true;
    const cost = rowCost(row, RUNNER_MODEL);
    if (cost == null) { if (number(row.output) > 0) goal.unpriced += 1; }
    else { goal.cost += cost; goal.priced += 1; }
  }
  const measured = [...effort.values()].filter((goal) => goal.sessions);
  const minutes = measured.map((goal) => goal.seconds / 60).sort((a, b) => a - b);
  const histogram = TIME_BUCKETS_MIN.map(() => 0);
  for (const value of minutes) histogram[TIME_BUCKETS_MIN.findIndex((top) => value < top)] += 1;
  const costs = measured.filter((goal) => goal.priced).map((goal) => goal.cost).sort((a, b) => a - b);
  const round = (value) => (value == null ? null : Math.round(value));
  const cents = (value) => (value == null ? null : Math.round(value * 100) / 100);
  // Headless planning in the window, for the planning line beside the interactive sessions.
  const planCost = rows.filter((row) => row.kind === 'plan' && inDay(row)).reduce((n, row) => n + (rowCost(row, RUNNER_MODEL) ?? 0), 0);
  return {
    goals: goals.length,
    plan_cost: cents(planCost),
    plan_sessions: rows.filter((row) => row.kind === 'plan' && inDay(row)).length,
    without_goal: withoutGoal.size,
    prs: landed.length,
    attempts: merges.length,
    // A goal that never needed a finish or mend session went through review the first time.
    first_pass: measured.length ? measured.filter((goal) => !goal.again).length : null,
    measured: measured.length,
    sessions_per_goal: measured.length ? Math.round((measured.reduce((n, goal) => n + goal.sessions, 0) / measured.length) * 10) / 10 : null,
    time: {
      median_min: round(quantile(minutes, 0.5)),
      p25_min: round(quantile(minutes, 0.25)),
      p75_min: round(quantile(minutes, 0.75)),
      p90_min: round(quantile(minutes, 0.9)),
      max_min: round(minutes.at(-1) ?? null),
      buckets_min: TIME_BUCKETS_MIN.map((top) => (top === Infinity ? null : top)),
      histogram,
    },
    cost: {
      median: cents(quantile(costs, 0.5)),
      total: cents(costs.length ? costs.reduce((n, value) => n + value, 0) : null),
      // Goals with at least one priced session, and sessions whose model has no list price.
      priced: costs.length,
      unpriced_sessions: measured.reduce((n, goal) => n + goal.unpriced, 0),
    },
  };
}
