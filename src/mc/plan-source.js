/**
 * `plan-source.js` — where a plan lives, and the readers that find one by its
 * place. This module alone knows the layout, and it knows two places:
 *
 * - `~/mc/programs/<programme>/<project>/PLAN.json` (`programsHome`, ruling 48),
 *   read from disk. A plan here names its repository in `repo`, and shadows a
 *   plan of the same name in a repository.
 * - the repositories' `docs/project/<programme>/<project>/PLAN.json`, and the
 *   legacy `PLAN.md` beside it, read from origin/main.
 *
 * Every reader that finds or reads a plan by its place asks here. When plans
 * move out of the repositories (ruling 48, `docs/project/mc/mc-project.md`)
 * only this module changes.
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

/** The directory, in a repository, that holds the plans. */
export const PROJECT_DIR = 'docs/project';
/** The plan file the runner reads. */
export const PLAN_FILE = 'PLAN.json';
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

/** The project names with a PLAN.json in an `ls-tree` listing, in listing order. */
export function projectNames(tree) {
  return plansInTree(tree).filter((entry) => entry.file === PLAN_FILE).map((entry) => entry.project);
}

/** The plan on origin/main, if the project has one there: the first repository that has it. */
export function findPlan(repos, name, { ref = 'origin/main', git } = {}) {
  for (const repo of repos) {
    if (!existsSync(join(repo.path, '.git'))) continue;
    const tree = git(repo.path, lsTreeArgs(ref));
    if (tree == null) continue;
    const entry = plansInTree(tree).find((p) => p.project === name && p.file === PLAN_FILE);
    if (entry) {
      return {
        repo: repo.name,
        path: repo.path,
        programme: entry.programme,
        plan: entry.path,
        text: git(repo.path, ['show', `${ref}:${entry.path}`]) || '',
        // Every project of this repository, because a pull request is matched
        // to a project by the longest name its branch begins with — without
        // the siblings, `mc-cut-2` would read as `mc`'s (project-prs.js).
        names: projectNames(tree),
      };
    }
  }
  return null;
}

/**
 * The plan a worktree holds for a project: each programme's directory for the
 * project is looked in for the plan file. A project still on the old file comes
 * back as `legacy`, with no plan to read.
 */
export function planIn(tree, name, { list, exists, read }) {
  const base = join(tree, PROJECT_DIR);
  for (const programme of list(base)) {
    const dir = join(base, programme, name);
    const path = join(dir, PLAN_FILE);
    if (exists(path)) {
      const text = read(path) || '';
      const { plan, problems } = readPlanText(text);
      return { path, programme, text, plan, problems, legacy: false };
    }
    // A project still on the old file is reported as what it is. The runner
    // reads PLAN.json and nothing else; guessing at markdown is what let a
    // plan missing the sections the role names be handed out anyway.
    if (exists(join(dir, LEGACY_PLAN_FILE))) {
      return { path: join(dir, LEGACY_PLAN_FILE), programme, text: '', plan: null, problems: [], legacy: true };
    }
  }
  return null;
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

/**
 * Every plan under `~/mc/programs/`, with its text: the shape `plansInTree`
 * gives (`path`, `programme`, `project`, `file`) plus `text` and `repo`, the
 * repository the plan names in its top-level `repo` (null when it names none,
 * or is not JSON). `path` is absolute. The programme's own worktrees
 * (`programs/<programme>/memoro/`) hold no `PLAN.json` directly, so they are
 * skipped by that alone. In listing order: programmes, then projects.
 */
export function programsPlans({ home = programsHome(), list = listDirs, read = readText } = {}) {
  const plans = [];
  for (const programme of list(home)) {
    for (const project of list(join(home, programme))) {
      const path = join(home, programme, project, PLAN_FILE);
      const text = read(path);
      if (text === null) continue;
      let repo = null;
      try {
        const { repo: named } = JSON.parse(text);
        if (typeof named === 'string') repo = named;
      } catch {
        // Not JSON: the plan is unreadable, and names no repository.
      }
      plans.push({ path, programme, project, file: PLAN_FILE, text, repo });
    }
  }
  return plans;
}
