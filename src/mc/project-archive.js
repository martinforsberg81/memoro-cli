/**
 * Archiving a project under `~/mc/programs/` — the rules, with no git, no gh
 * and no file system behind them.
 *
 * Ruling 48 (`docs/project/mc/mc-project.md` § Verbs): a done project under
 * `~/mc/programs/` is archived by `mc project archive <project>`, or by the
 * runner once it has been done for 24 hours. What reaches the repository is one
 * row in that repository's `docs/project/project_log.md`, landed as a
 * docs-only pull request. The closeout stays in mc, `CLOSEOUT.json` beside
 * `PLAN.json`, and the project's directory moves to `~/mc/archive/projects/`
 * (`shelveProject`). A programme is never archived automatically.
 *
 * The row and its cells are the ones `archive-plan.js` writes for a plan in a
 * repository, reused unchanged. The rules take what they need as arguments.
 * `archivePrograms` is the one routine that runs git and gh, and it does so only
 * through the `deps` it is handed, as run.js does; the register is read by its
 * caller (the runner and the `mc project` verbs).
 */
import { existsSync, mkdirSync, renameSync } from 'node:fs';
import { dirname, isAbsolute, join } from 'node:path';

import {
  ARCHIVE_BRANCH_PREFIX, UNDOCUMENTED_HEADER, appendRow, isUndocumented,
  mergedPrs, planDoc, planSummary, pointerCell, remoteSlug, rowFor, undocumentedRow,
} from './archive-plan.js';
import { buildCloseout, closeoutText, readSessionResults } from './closeout.js';
import { archivedProjectsHome } from './paths.js';
import { CLOSEOUT_FILE } from './plan-source.js';
import { landingNote } from './run-plan.js';
import { tilde } from './status-project.js';

/** How long a done project stays listed as done before the runner archives it. */
export const ARCHIVE_HOLD_MS = 24 * 60 * 60 * 1000;

const HOUR_MS = 60 * 60 * 1000;

/**
 * The ISO time a register entry became done. The register holds it as
 * `done_at`, set by the write that made the entry done (`withDoneAt` in
 * register.js), and that is what this returns while the entry is still done.
 * The computed time is the fallback for registers written before `done_at`
 * existed: the latest of its steps' `updated` and its criteria's `at`, each
 * one only when `Date.parse` reads it. A project is done when every step is
 * `done` and every criterion is met. Null when the entry is missing, has no
 * steps, has a step that is not `done`, has a criterion that is not met, or no
 * time can be read from it.
 */
export function doneAt(entry) {
  const steps = Array.isArray(entry?.steps) ? entry.steps : [];
  if (!steps.length) return null;
  if (steps.some((step) => step?.status !== 'done')) return null;
  const criteria = Array.isArray(entry.criteria) ? entry.criteria : [];
  if (criteria.some((criterion) => criterion?.met !== true)) return null;
  if (typeof entry.done_at === 'string' && !Number.isNaN(Date.parse(entry.done_at))) return entry.done_at;
  const times = [...steps.map((step) => step.updated), ...criteria.map((criterion) => criterion.at)]
    .filter((at) => typeof at === 'string' && !Number.isNaN(Date.parse(at)))
    .map((at) => Date.parse(at));
  if (!times.length) return null;
  return new Date(Math.max(...times)).toISOString();
}

/**
 * Whether the runner archives this project now, and why in one line. `record`
 * is a plan as `listPlans` returns it; `entry` its register entry. A plan in a
 * repository (a path that is not absolute) is not this one's.
 * A project is due once it has been done for `holdMs` — exactly that long is
 * due. `why` is what the runner's log says about it either way.
 */
export function archiveDue({ record, entry, nowMs, holdMs = ARCHIVE_HOLD_MS }) {
  if (!isAbsolute(record?.path || '')) {
    return { due: false, why: 'the plan is in a repository, not under ~/mc/programs/' };
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
 * `docExists(path)` says whether a `docs/technical/` path the plan names is in
 * the repository; a path that is not gives no doc link (see `planDoc`).
 */
export function archiveRow({ planText, programme, project, date, tsv, slug, existing, docExists = () => true }) {
  if (existing) return existing;
  return {
    date,
    programme,
    project,
    outcome: 'delivered',
    summary: planSummary(planText),
    doc: planDoc(planText, docExists),
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

/**
 * Moves a project's directory, whole, to `archive/projects/<programme>/<project>`
 * — or to `<project>-2`, `-3`, … when one of that name is there already. Its
 * PLAN.json, CLOSEOUT.json and STATE.json go with it, and nothing in it is
 * deleted. Returns where it went; throws when the move fails, with the directory
 * where it was.
 */
export function shelveProject(dir, programme, project, {
  home = archivedProjectsHome(),
  exists = existsSync,
  mkdir = (path) => mkdirSync(path, { recursive: true }),
  rename = renameSync,
} = {}) {
  mkdir(join(home, programme));
  let to = join(home, programme, project);
  for (let n = 2; exists(to); n += 1) to = join(home, programme, `${project}-${n}`);
  rename(dir, to);
  return to;
}

/* ------------------------------------------------- the archive, through git */

/** The project log of a repository, as its docs-only archive pull request edits it. */
const LOG = 'docs/project/project_log.md';

/** A `PLAN.json` text as an object, or null. The closeout records it; it does not judge it. */
function parsedPlan(text) {
  try {
    const value = JSON.parse(String(text ?? ''));
    return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
  } catch { return null; }
}

/**
 * Archives the done projects of one repository that live under `~/mc/programs/`.
 * `items` is `[{ record, entry }]`: a plan as `listPlans` returns it and its
 * register entry. A project whose row is already on origin/main gets its
 * closeout and nothing else. The rest get their rows in one docs-only pull
 * request, landed through `docsMerge`; a row is never added twice. The closeout
 * is written only once the row is on main, so a pass that stops between the two
 * finds the row next time.
 *
 * Returns `{ archived, held }`: the projects whose CLOSEOUT.json was written,
 * and `[{ project, why }]` for the rest. Each of those then has its directory
 * moved to `archive/projects/` — by `deps.shelve`, else `shelveProject` at
 * `paths.archived`. A move that fails is said and the project stays archived:
 * its CLOSEOUT.json is there, and every reader skips a project that has one. A failure holds the projects it stopped
 * — the others go on. The worktree is taken down however the pass ends.
 */
export async function archivePrograms({ repo, items, root, paths, deps, docsMerge, now, say }) {
  const prefix = `archive: ${repo.name} `;
  if (!items.length) return { archived: [], held: [] };
  const onMain = deps.git(repo.path, ['show', `origin/main:${LOG}`]);
  if (!onMain.ok) {
    say(`${prefix}could not read the project log, nothing archived`);
    return { archived: [], held: items.map(({ record }) => ({ project: record.project, why: 'the project log could not be read' })) };
  }
  const rows = new Map();
  const need = [];
  for (const item of items) {
    const row = rowFor(String(onMain.stdout ?? ''), item.record.project);
    if (row) rows.set(item, row);
    else need.push(item);
  }
  const failed = new Map();
  if (need.length) {
    let why = null;
    try {
      why = await landRows({ repo, need, root, paths, deps, docsMerge, now, say, rows });
    } catch (error) {
      why = `the archive stopped: ${error?.message || error}`;
    }
    if (why) for (const item of need) failed.set(item, why);
  }

  const date = now().toISOString().slice(0, 10);
  const tsv = deps.read(paths.runs) || '';
  for (const item of items) {
    if (failed.has(item)) continue;
    const { record, entry } = item;
    const { programme, project } = record;
    try {
      const closeout = closeoutOf({
        plan: parsedPlan(deps.read(record.path)), entry, tsv,
        sessions: readSessionResults({ dir: paths.log, project, list: deps.list, read: deps.read, readBytes: deps.readBytes }),
        archivedAt: date, project, programme, repo: repo.name, planPath: record.path,
      });
      deps.write(closeoutFileOf(record.path), closeoutText(closeout));
      const row = rows.get(item);
      if (isUndocumented(row)) {
        if (!deps.exists(paths.undocumented)) deps.write(paths.undocumented, UNDOCUMENTED_HEADER);
        deps.append(paths.undocumented, `${undocumentedRow({ date, repo: repo.name, programme, project, pointer: row.pointer })}\n`);
      }
    } catch (error) {
      failed.set(item, error?.message || String(error));
      continue;
    }
    say(`${prefix}${programme}/${project} archived — CLOSEOUT.json written`);
    try {
      const to = deps.shelve
        ? deps.shelve(dirname(record.path), programme, project)
        : shelveProject(dirname(record.path), programme, project, { home: paths.archived });
      say(`${prefix}${project} moved to ${tilde(to)}`);
    } catch (error) {
      say(`${prefix}${project} not moved (${error?.message || error}) — left in ~/mc/programs; nothing tries the move again`);
    }
  }

  for (const item of items) {
    if (failed.has(item)) say(`${prefix}${item.record.programme}/${item.record.project} held — ${failed.get(item)}`);
  }
  return {
    archived: items.filter((item) => !failed.has(item)).map(({ record }) => record.project),
    held: items.filter((item) => failed.has(item)).map((item) => ({ project: item.record.project, why: failed.get(item) })),
  };
}

/**
 * The rows of the `need` items, landed as one docs-only pull request from a
 * worktree of their own. Null when they landed, else why they did not — and
 * then none of them has a row on main. `rows` gets each item's new row.
 */
async function landRows({ repo, need, root, paths, deps, docsMerge, now, say, rows }) {
  const open = deps.gh(repo.path, ['pr', 'list', '--state', 'open', '--json', 'number,headRefName',
    '-q', `.[] | select(.headRefName | startswith("${ARCHIVE_BRANCH_PREFIX}")) | .number`]);
  const earlier = open.ok ? String(open.stdout ?? '').trim().split('\n').filter(Boolean)[0] : null;
  if (earlier) {
    say(`archive: ${repo.name} #${earlier} is still open from an earlier archive — not opening another`);
    return `#${earlier} is still open`;
  }

  const stamp = now().toISOString().replace(/\.\d{3}Z$/u, 'Z').replace(/[-:]/gu, '');
  const branch = `${ARCHIVE_BRANCH_PREFIX}${stamp}-programs`;
  // Named for the repository: the docs route reads its name from the last segment of this path.
  const worktree = join(root, 'runner', 'archive', 'programs', repo.name);
  if (deps.exists(worktree)) deps.git(repo.path, ['worktree', 'remove', '--force', worktree]);
  try {
    if (!deps.git(repo.path, ['worktree', 'add', '-b', branch, worktree, 'origin/main']).ok) {
      return 'the archive worktree could not be opened';
    }
    return await commitRows({ repo, need, worktree, branch, paths, deps, docsMerge, now, say, rows });
  } finally {
    deps.git(repo.path, ['worktree', 'remove', '--force', worktree]);
    deps.git(repo.path, ['branch', '-D', branch]);
  }
}

/**
 * The rows of the `need` items appended to the worktree's log, committed,
 * pushed, opened as a pull request and landed through `docsMerge`. Null when
 * the pull request merged into main, else why it did not.
 */
async function commitRows({ repo, need, worktree, branch, paths, deps, docsMerge, now, say, rows }) {
  const logPath = join(worktree, LOG);
  const logText = deps.read(logPath);
  if (logText == null) return 'the project log is not in the archive worktree';
  const date = now().toISOString().slice(0, 10);
  const remote = deps.git(repo.path, ['remote', 'get-url', 'origin']);
  const slug = remote.ok ? remoteSlug(remote.stdout) : null;
  const tsv = deps.read(paths.runs) || '';
  let text = logText;
  for (const item of need) {
    const { record } = item;
    const row = archiveRow({
      planText: deps.read(record.path) || '', programme: record.programme, project: record.project,
      date, tsv, slug, existing: null,
      docExists: (path) => deps.exists(join(worktree, path)),
    });
    rows.set(item, row);
    text = appendRow(text, row);
  }
  deps.write(logPath, text);
  if (!deps.git(worktree, ['add', '--', LOG]).ok) return 'git add failed on the project log';

  const names = need.map(({ record }) => record.project);
  const title = `Archive ${names.length} done project${names.length === 1 ? '' : 's'}: ${names.join(', ')}`;
  const body = [
    'The plans of these projects stay in mc under `~/mc/programs/`, each with its `CLOSEOUT.json` beside `PLAN.json`.',
    'This pull request only adds their rows to `docs/project/project_log.md`.',
    '',
    ...names.map((project) => `- ${project}`),
  ].join('\n');
  if (!deps.git(worktree, ['commit', '-q', '-m', title, '-m', body]).ok
    || !deps.git(worktree, ['push', '-q', '-u', 'origin', 'HEAD']).ok) {
    return 'commit or push failed';
  }
  const created = deps.gh(worktree, ['pr', 'create', '--base', 'main', '--head', branch, '--title', title, '--body', body]);
  const listed = deps.gh(worktree, ['pr', 'list', '--head', branch, '--state', 'open', '--json', 'number', '-q', '.[0].number']);
  const pr = (/(\d+)\s*$/u.exec(String(created.stdout ?? '').trim())?.[1]) || (listed.ok && String(listed.stdout ?? '').trim()) || null;
  if (!pr) return `the pull request could not be opened (${String(created.stderr ?? '').trim().split('\n').at(-1) || 'no number'})`;
  say(`archive: ${repo.name} opened #${pr} for ${names.join(', ')}`);

  let report;
  try {
    report = await docsMerge({
      repoPath: worktree, pr: Number(pr), gh: (args) => deps.gh(worktree, args),
      onProgress: (message) => say(`archive: ${repo.name} ${message}`),
    });
  } catch (error) {
    return `#${pr} could not be merged: ${error?.message || error}`;
  }
  const note = landingNote(report);
  if (note !== 'merged') {
    return note.startsWith('off-')
      ? `#${pr} was merged into ${report.merged_into || 'another branch'}, not main`
      : `#${pr} left open — ${report?.reason || 'the docs merge said nothing'}`;
  }
  deps.git(repo.path, ['fetch', '-q', 'origin']);
  say(`archive: ${repo.name} merged #${pr} into main (docs only)`);
  return null;
}
