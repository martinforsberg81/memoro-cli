/**
 * Archiving a project under `~/mc/programs/` — the rules, with no git, no gh
 * and no file system behind them.
 *
 * Ruling 48 (`docs/project/mc/mc-project.md` § Verbs): a done project under
 * `~/mc/programs/` is archived by `mc project archive <project>`, or by the
 * runner once it has been done for 24 hours. What reaches the repository is one
 * row in that repository's `docs/project/project_log.md`, landed as a
 * docs-only pull request. The plan and its closeout stay in mc: `CLOSEOUT.json`
 * beside `PLAN.json`. A programme is never archived automatically.
 *
 * The row and its cells are the ones `archive-plan.js` writes for a plan in a
 * repository, reused unchanged. Every function here takes what it needs as an
 * argument; reading the register, running git and writing the files is the
 * caller's (`archivePrograms`, run.js and the `mc project` verbs).
 */
import { dirname, isAbsolute, join } from 'node:path';

import { mergedPrs, planDoc, planSummary, pointerCell } from './archive-plan.js';
import { buildCloseout } from './closeout.js';
import { CLOSEOUT_FILE } from './plan-source.js';

/** How long a done project stays listed as done before the runner archives it. */
export const ARCHIVE_HOLD_MS = 24 * 60 * 60 * 1000;

const HOUR_MS = 60 * 60 * 1000;

/**
 * The ISO time a register entry became done: the latest of its steps'
 * `updated` and its criteria's `at`, each one only when `Date.parse` reads it.
 * A project is done when every step is `done` and every criterion is met, and
 * the last of those moments is when it became so. Null when the entry is
 * missing, has no steps, has a step that is not `done`, has a criterion that
 * is not met, or no time can be read from it.
 */
export function doneAt(entry) {
  const steps = Array.isArray(entry?.steps) ? entry.steps : [];
  if (!steps.length) return null;
  if (steps.some((step) => step?.status !== 'done')) return null;
  const criteria = Array.isArray(entry.criteria) ? entry.criteria : [];
  if (criteria.some((criterion) => criterion?.met !== true)) return null;
  const times = [...steps.map((step) => step.updated), ...criteria.map((criterion) => criterion.at)]
    .filter((at) => typeof at === 'string' && !Number.isNaN(Date.parse(at)))
    .map((at) => Date.parse(at));
  if (!times.length) return null;
  return new Date(Math.max(...times)).toISOString();
}

/**
 * Whether the runner archives this project now, and why in one line. `record`
 * is a plan as `listPlans` returns it; `entry` its register entry. A plan in a
 * repository (a path that is not absolute) is `archiveDone`'s, not this one's.
 * A project is due once it has been done for `holdMs` — exactly that long is
 * due. `why` is what the runner's log says about it either way.
 */
export function archiveDue({ record, entry, nowMs, holdMs = ARCHIVE_HOLD_MS }) {
  if (!isAbsolute(record?.path || '')) {
    return { due: false, why: 'the plan is in a repository — archiveDone archives it' };
  }
  if (record.status !== 'done') return { due: false, why: `the plan is ${record.status}` };
  const at = doneAt(entry);
  if (!at) return { due: false, why: 'the register does not say when it was done' };
  const since = nowMs - Date.parse(at);
  const hours = Math.max(0, Math.floor(since / HOUR_MS));
  if (since < holdMs) {
    return { due: false, why: `done ${hours}h ago — archived after ${Math.round(holdMs / HOUR_MS)}h` };
  }
  return { due: true, why: `done ${hours}h ago` };
}

/**
 * The `project_log.md` row of an archived project (`LOG_COLUMNS`). `existing`
 * is the row `rowFor` found for it, and is returned as it is: a row already on
 * main is never rewritten. Otherwise the row says the project was delivered,
 * with its summary and doc read from the plan, and its pointer the PRs the
 * runner merged for it (`tsv` is runs.tsv), linked when `slug` is known.
 */
export function archiveRow({ planText, programme, project, date, tsv, slug, existing }) {
  if (existing) return existing;
  return {
    date,
    programme,
    project,
    outcome: 'delivered',
    summary: planSummary(planText),
    doc: planDoc(planText),
    pointer: pointerCell(mergedPrs(tsv, project), { slug }),
  };
}

/**
 * The closeout record of an archived project in mc: `buildCloseout` with the
 * same arguments, so it has the shape of a repository closeout. `planPath` is
 * the absolute path of the `PLAN.json` it describes, and `plan` the parsed plan
 * (null when it could not be read).
 */
export function closeoutOf({ plan, entry, tsv, sessions, archivedAt, project, programme, repo, planPath }) {
  return buildCloseout({ plan, entry, runs: tsv, sessions, archivedAt, project, programme, repo, planPath });
}

/** Where a project's closeout lives in mc: `CLOSEOUT.json` beside its `PLAN.json`. */
export function closeoutFileOf(planPath) {
  return join(dirname(planPath), CLOSEOUT_FILE);
}
