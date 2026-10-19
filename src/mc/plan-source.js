/**
 * `plan-source.js` — where a plan lives, and the readers that find one by its
 * place. This module alone knows the layout: `docs/project/<programme>/<project>/PLAN.json`
 * in a repository, and the legacy `PLAN.md` beside it. Every reader that finds
 * or reads a plan by its place asks here. When plans move out of the
 * repositories (ruling 48, `docs/project/mc/mc-project.md`) only this module
 * changes.
 *
 * Pure given what it is handed: `git` and the directory reads are arguments,
 * so the tests feed fixtures. It imports nothing from `src/mc` but the plan
 * reader, which imports nothing from here.
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';

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
