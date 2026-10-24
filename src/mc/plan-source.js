/**
 * `plan-source.js` — where a plan lives, and the readers that find one by its
 * place. This module alone knows the layout. A plan lives in one place:
 * `~/mc/programs/<programme>/<project>/PLAN.json` (`programsHome`, ruling 48),
 * read from disk, naming its repository in `repo`.
 *
 * A repository's `docs/project/<programme>/<project>/PLAN.json`, and the legacy
 * `PLAN.md` beside it, is where a plan used to be: no reader reads one, and the
 * path is known here only so that the docs route and the gate can refuse one
 * (`isRepoPlanPath`, `plansInTree`) and `mc tidy` can judge old closeouts.
 *
 * Every reader that finds or reads a plan by its place asks here.
 *
 * Pure given what it is handed: `git` and the directory reads are arguments,
 * so the tests feed fixtures. It imports nothing from `src/mc` but the plan
 * reader, which imports nothing from here, and the path of the programs tree,
 * which imports nothing from `src/mc` at all.
 */
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';

import { programsHome } from './paths.js';
import { readPlanText } from './plan-schema.js';
import { gitDirOf } from './repos.js';

/** The directory, in a repository, that holds the plans. */
export const PROJECT_DIR = 'docs/project';
/** The plan file the runner reads. */
export const PLAN_FILE = 'PLAN.json';
/** The file an archived project holds beside its plan (ruling 48): its closeout. */
export const CLOSEOUT_FILE = 'CLOSEOUT.json';
/** The old plan file: reported as what it is, never read as a plan. */
export const LEGACY_PLAN_FILE = 'PLAN.md';

/** The repository path of a project's plan file. */
export function planPath(programme, project, file = PLAN_FILE) {
  return `${PROJECT_DIR}/${programme}/${project}/${file}`;
}

/** The programme, project and file a repository path names as a plan, or null. */
export function parsePlanPath(path) {
  const parts = String(path).split('/');
  if (parts.length !== 5 || `${parts[0]}/${parts[1]}` !== PROJECT_DIR) return null;
  if (parts[4] !== PLAN_FILE && parts[4] !== LEGACY_PLAN_FILE) return null;
  return { path, programme: parts[2], project: parts[3], file: parts[4] };
}

/**
 * True when `path` is a plan file in a repository: `docs/project/<programme>/<project>/PLAN.json`,
 * or the legacy `PLAN.md` beside it. Since ruling 48 a plan is never written there,
 * so the docs route refuses a pull request that adds lines to one.
 */
export function isRepoPlanPath(path) {
  return parsePlanPath(path) !== null;
}

/** The `git ls-tree` arguments that list every file under the plans directory. */
export function lsTreeArgs(ref = 'origin/main') {
  return ['ls-tree', '-r', '--name-only', ref, '--', PROJECT_DIR];
}

/** Every plan entry in an `ls-tree` listing, in listing order; none for null. */
export function plansInTree(tree) {
  if (tree == null) return [];
  return tree.split('\n')
    .filter((line) => line !== '')
    .map((line) => parsePlanPath(line))
    .filter((entry) => entry !== null);
}

/** The project names the `~/mc/programs/` plans of one repository give it. */
const programNames = (programs, repo) => programs.filter((e) => e.repo === repo).map((e) => e.project);

/**
 * The plan of a project: the one under `~/mc/programs/` (ruling 48), with its
 * repository when that repository is here. `ref` and `git` are accepted and
 * not used: no repository holds a plan any more.
 */
export function findPlan(repos, name, { programs = programsPlans } = {}) {
  const all = programs();
  const held = all.find((e) => e.project === name);
  if (!held) return null;
  // The plan is its repository's, so a repository not here has nothing to find.
  const repo = repos.find((r) => r.name === held.repo);
  if (!repo || !existsSync(gitDirOf(repo))) return null;
  return {
    repo: repo.name,
    path: repo.path,
    programme: held.programme,
    plan: held.path,
    text: held.text,
    // Every project of this repository, because a pull request is matched
    // to a project by the longest name its branch begins with — without
    // the siblings, `mc-cut-2` would read as `mc`'s (project-prs.js).
    names: programNames(all, repo.name),
  };
}

/**
 * The plan a project has under `~/mc/programs/`, or null. `tree`, `list`,
 * `exists` and `read` are accepted and not used: a worktree holds no plan.
 */
export function planIn(tree, name, { programs = programsPlans } = {}) {
  const held = programs().find((e) => e.project === name);
  if (!held) return null;
  const { plan, problems } = readPlanText(held.text);
  return { path: held.path, programme: held.programme, text: held.text, plan, problems, legacy: false };
}

/** The names of the directories in `path`, sorted, dot-directories left out; none when it cannot be read. */
function listDirs(path) {
  try {
    return readdirSync(path, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'))
      .map((entry) => entry.name)
      .sort();
  } catch {
    return [];
  }
}

/** A file's text, or null when it cannot be read. */
function readText(path) {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return null;
  }
}

/** The repository a plan names in its top-level `repo`, or null when it names none or is not JSON. */
function namedRepo(text) {
  try {
    const { repo } = JSON.parse(text);
    return typeof repo === 'string' ? repo : null;
  } catch {
    // Not JSON: the plan is unreadable, and names no repository.
    return null;
  }
}

/**
 * Every plan under `~/mc/programs/`, with its text: the shape `plansInTree`
 * gives (`path`, `programme`, `project`, `file`) plus `text` and `repo`, the
 * repository the plan names in its top-level `repo` (null when it names none,
 * or is not JSON). `path` is absolute. The programme's own worktrees
 * (`programs/<programme>/memoro/`) hold no `PLAN.json` directly, so they are
 * skipped by that alone. A project with a `CLOSEOUT.json` beside its plan is
 * archived, and is skipped too: an archived project is not a plan any reader
 * lists (`programsArchived` lists it). In listing order: programmes, then projects.
 */
export function programsPlans({ home = programsHome(), list = listDirs, read = readText } = {}) {
  const plans = [];
  for (const programme of list(home)) {
    for (const project of list(join(home, programme))) {
      const dir = join(home, programme, project);
      if (read(join(dir, CLOSEOUT_FILE)) !== null) continue;
      const path = join(dir, PLAN_FILE);
      const text = read(path);
      if (text === null) continue;
      plans.push({ path, programme, project, file: PLAN_FILE, text, repo: namedRepo(text) });
    }
  }
  return plans;
}

/**
 * The archived projects under `~/mc/programs/`: one record a project directory
 * that holds both its `PLAN.json` and its `CLOSEOUT.json` beside it. `path` is
 * the plan and `closeoutPath` the closeout, both absolute; `repo` is read the
 * way `programsPlans` reads it. A directory with only a closeout is not one.
 * In listing order, as `programsPlans`.
 */
export function programsArchived({ home = programsHome(), list = listDirs, read = readText } = {}) {
  const archived = [];
  for (const programme of list(home)) {
    for (const project of list(join(home, programme))) {
      const dir = join(home, programme, project);
      const path = join(dir, PLAN_FILE);
      const closeoutPath = join(dir, CLOSEOUT_FILE);
      const text = read(path);
      if (text === null || read(closeoutPath) === null) continue;
      archived.push({ path, programme, project, repo: namedRepo(text), closeoutPath });
    }
  }
  return archived;
}
