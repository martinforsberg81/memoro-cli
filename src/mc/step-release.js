/**
 * When a blocked step's wait is over (ruling 35, 2026-10-10).
 *
 * A blocked step is a person's (ruling 21) — except for three waits nobody
 * has to judge: a time (`time`, `at`), an earlier step's deploy plus a delay
 * (`deploy`, `step`, `hours`), and another project being done (`project`).
 * The runner asks `blockerDue` of every blocked step it holds and sets the
 * ones that are due `ready`, with `why` as the comment; `mc step` and the
 * page say how long the rest have left with `describeWait`. `decision` and
 * `workarea` are never due here: their way back is still `mc step ready`.
 *
 * `blockerDue` and `describeWait` are pure; `releaseDue` writes the register
 * through what its caller hands it. The caller hands in the clock, the plans,
 * the register, the deploy log and the ancestor question:
 *
 *   now        a Date
 *   plans      the plan records `queue()` holds, across both repositories
 *   stepsOf()  this project's register steps, in plan order
 *   deploys    `readDeploys()` rows (deploys.js)
 *   contains(sha, rowSha)  is `sha` in the tree `rowSha` deployed —
 *              `git merge-base --is-ancestor sha rowSha` in the checkout
 *
 * A `project` blocker is due only when that project's plan is on main and
 * `done`. One that is not on main may have been abandoned rather than
 * delivered, and only a person can tell which (`stale-blockers.js`).
 */
import { DEPLOYED } from './deploys.js';
import { planState, planSummary } from './plan-schema.js';
import { readEntry, updateStep } from './register.js';

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;

/** How long ago an ISO time was, in the largest unit that fits: `40m ago`, `3h ago`, `2d ago`. */
export function ago(iso, nowMs) {
  const at = Date.parse(iso || '');
  if (!Number.isFinite(at) || !Number.isFinite(nowMs)) return '?';
  const minutes = Math.max(0, Math.round((nowMs - at) / MINUTE_MS));
  if (minutes < 60) return `${minutes}m ago`;
  if (minutes < 48 * 60) return `${Math.round(minutes / 60)}h ago`;
  return `${Math.round(minutes / 1440)}d ago`;
}

/**
 * How long until a moment, by `ago`'s units: `40m`, `7h40m`, `3d`. Rounded
 * up, so a wait that has a few seconds left does not say `0m`. Under two days
 * the minutes are kept, because a wait is read to know when to look again.
 */
export function left(ms) {
  const minutes = Math.max(0, Math.ceil(ms / MINUTE_MS));
  if (minutes < 60) return `${minutes}m`;
  if (minutes < 48 * 60) {
    const rest = minutes % 60;
    return `${Math.floor(minutes / 60)}h${rest ? `${rest}m` : ''}`;
  }
  return `${Math.round(minutes / 1440)}d`;
}

/** `2026-10-14T08:00Z` — an instant to the minute. `sep` is what stands between date and time. */
function minute(ms, sep = 'T') {
  return new Date(ms).toISOString().slice(0, 16).replace('T', sep) + 'Z';
}

function hoursOf(blocker) {
  return Number.isFinite(blocker?.hours) && blocker.hours > 0 ? blocker.hours : 0;
}

/**
 * Where a `deploy` blocker stands: `not-landed` (the step it waits on is not
 * done with a `landed.sha`), `not-deployed` (no deployed row contains that
 * sha), or `deployed` with the earliest such row and the moment it is due.
 */
function deployState(blocker, context) {
  const steps = (typeof context.stepsOf === 'function' ? context.stepsOf() : null) || [];
  const earlier = steps[blocker.step - 1];
  const sha = earlier?.status === 'done' ? earlier.landed?.sha : null;
  if (!sha) return { state: 'not-landed' };
  const contains = context.contains || (() => false);
  const rows = (context.deploys || [])
    .filter((row) => row?.outcome === DEPLOYED && row.sha && Number.isFinite(Date.parse(row.ended || '')))
    .filter((row) => contains(sha, row.sha))
    .sort((a, b) => Date.parse(a.ended) - Date.parse(b.ended));
  if (!rows.length) return { state: 'not-deployed' };
  const row = rows[0];
  return { state: 'deployed', row, dueMs: Date.parse(row.ended) + hoursOf(blocker) * HOUR_MS };
}

/**
 * Is this blocked step's wait over? `{ due: true, why }` with `why` the words
 * the release comment carries, or `{ due: false }`.
 */
export function blockerDue(step, context = {}) {
  const blocker = step?.blocked_by;
  const nowMs = context.now instanceof Date ? context.now.getTime() : NaN;
  if (!blocker || !Number.isFinite(nowMs)) return { due: false };
  if (blocker.kind === 'time') {
    const at = Date.parse(blocker.at || '');
    if (!Number.isFinite(at) || nowMs < at) return { due: false };
    return { due: true, why: `time ${minute(at)} passed` };
  }
  if (blocker.kind === 'deploy') {
    if (!Number.isInteger(blocker.step)) return { due: false };
    const found = deployState(blocker, context);
    if (found.state !== 'deployed' || found.dueMs > nowMs) return { due: false };
    const hours = hoursOf(blocker);
    return {
      due: true,
      why: `deploy ${String(found.row.sha).slice(0, 7)} ended ${minute(Date.parse(found.row.ended))}${hours ? `, + ${hours}h` : ''}`,
    };
  }
  if (blocker.kind === 'project') {
    const done = (context.plans || []).some((record) => record?.project === blocker.name && record.status === 'done');
    return done ? { due: true, why: `project ${blocker.name} is done` } : { due: false };
  }
  return { due: false };
}

/**
 * What a blocked step waits for and how long it has left, as `mc step` and
 * the page say it: `on deploy of step 3 + 24h — 7h40m left`, `on deploy of
 * step 3 — not deployed yet`, `on deploy of step 3 — step 3 not landed`,
 * `until 2026-10-14 08:00Z — 3d left`, `on project y — not done`. Any other
 * kind is `on <kind> <name>`, as before.
 */
export function describeWait(step, context = {}) {
  const blocker = step?.blocked_by;
  if (!blocker) return '';
  const nowMs = context.now instanceof Date ? context.now.getTime() : Date.now();
  if (blocker.kind === 'time') {
    const at = Date.parse(blocker.at || '');
    if (!Number.isFinite(at)) return `on time ${blocker.name} — no time to wait for`;
    return `until ${minute(at, ' ')} — ${at > nowMs ? `${left(at - nowMs)} left` : 'due'}`;
  }
  if (blocker.kind === 'deploy' && Number.isInteger(blocker.step)) {
    const hours = hoursOf(blocker);
    const head = `on deploy of step ${blocker.step}${hours ? ` + ${hours}h` : ''}`;
    const found = deployState(blocker, context);
    if (found.state === 'not-landed') return `${head} — step ${blocker.step} not landed`;
    if (found.state === 'not-deployed') return `${head} — not deployed yet`;
    return `${head} — ${found.dueMs > nowMs ? `${left(found.dueMs - nowMs)} left` : 'due'}`;
  }
  if (blocker.kind === 'project' && Array.isArray(context.plans)) {
    const record = context.plans.find((item) => item?.project === blocker.name);
    if (!record) return `on project ${blocker.name} — not on main`;
    return `on project ${blocker.name} — ${record.status === 'done' ? 'done' : 'not done'}`;
  }
  return `on ${blocker.kind} ${blocker.name}`;
}

/**
 * The runner's release (ruling 35): every record whose current step — the one
 * `planState` picks, so a blocked step behind another stopped step is not
 * reached — is `blocked` on a wait that is over is written `ready` in the
 * register with `Released <now>: <why>`, and said. `plans` holds both
 * repositories' records, because a `project` blocker may name a project in
 * the other one.
 *
 * Returns the records with each released step `ready` and its summary
 * recomputed, so the picker sees `ready` in the same pass. A record that
 * throws — an unreadable entry, a refused patch — is said and left as it was;
 * the others are released all the same.
 *
 *   update(project, index, patch)  the register write; `updateStep` over
 *                                  `read`, `write` and `lock` by default
 */
export function releaseDue(plans = [], {
  root, now = new Date(), deploys = [], contains = () => false,
  read, write, lock = (_root, fn) => fn(), say = () => {}, update = null,
} = {}) {
  const at = now.toISOString().replace(/\.\d{3}Z$/u, 'Z');
  const release = update || ((project, index, patch) => updateStep({ root, project, index, patch, read, write, lock, now: at }));
  return plans.map((record) => {
    if (!record?.plan || record.legacy) return record;
    const { status, index } = planState(record.plan);
    if (status !== 'blocked') return record;
    try {
      const entry = readEntry(root, record.project, { read });
      const step = entry?.steps[index];
      if (step?.status !== 'blocked') return record;
      const found = blockerDue(step, { now, plans, stepsOf: () => entry.steps, deploys, contains });
      if (!found.due) return record;
      release(record.project, index, { status: 'ready', blocked_by: null, reason: null, comment: `Released ${at}: ${found.why}` });
      say(`${record.project} step ${index + 1}: released — ${found.why}`);
      const steps = record.plan.steps.map((each, i) => (i === index ? { ...each, status: 'ready', blocked_by: null } : each));
      const plan = { ...record.plan, steps };
      return { ...record, plan, ...planSummary(plan) };
    } catch (error) {
      say(`${record.project} step ${index + 1}: not released — ${error?.message || error}`);
      return record;
    }
  });
}
