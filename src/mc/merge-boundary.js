/**
 * The door: a pull request from a project branch may not change more of its
 * `PLAN.json` than a step session is allowed to.
 *
 * Runs before the gate, because a trespass is a fact about the pull request,
 * not about what a suite would measure. Fails open on anything it could not
 * read — `gh` down, the fetch failing, a branch that names no project, a base
 * copy that will not `git show` — because `prFacts` (repo-gate.js) asks
 * GitHub again moments later and stops the round at `pr` when it cannot; a
 * second, different refusal for the same missing answer tells the operator
 * nothing new. The one thing it invents a stop for is a head plan that does
 * not parse: nothing later would catch that either.
 *
 * A head whose plan is byte-identical to the base's passes without running
 * the comparison — most pull requests from a project branch touch code or
 * docs, not the plan, and the comparison is only interesting when the plan
 * moved.
 */
import { spawnSync } from 'node:child_process';

import { readPlanText, unauthorisedChanges } from './plan-schema.js';
import { projectForBranch } from './project-prs.js';
import { stepOfPr } from './run-plan.js';

function run(tool) {
  return (args, options = {}) => spawnSync(tool, args, { cwd: options.cwd, encoding: 'utf8' });
}

/** Every project with a plan in an `ls-tree` of `docs/project` on some ref. */
function names(tree) {
  return (tree || '').split('\n')
    .map((p) => p.split('/'))
    .filter((parts) => parts.length === 5 && parts[4] === 'PLAN.json')
    .map((parts) => parts[3]);
}

const notChecked = { checked: false, ok: true, problems: [] };

/**
 * `{ checked, ok, problems }` — `checked: false` means the question was never
 * asked (no project branch, or something could not be read); `ok: false`
 * means it was asked and the answer was a trespass.
 */
export async function planBoundary({ repoPath, pr, git, gh } = {}) {
  const askGit = git || run('git');
  const askGh = gh || run('gh');

  const asked = askGh(['pr', 'view', String(pr), '--json', 'headRefName,baseRefName'], { cwd: repoPath });
  if (asked.status !== 0) return notChecked;
  let raw = null;
  try { raw = JSON.parse(asked.stdout); } catch { return notChecked; }
  const head = raw?.headRefName;
  const base = raw?.baseRefName;
  if (!head || !base) return notChecked;

  const fetched = askGit(['fetch', 'origin', '--prune'], { cwd: repoPath });
  if (fetched.status !== 0) return notChecked;

  const tree = askGit(['ls-tree', '-r', '--name-only', `origin/${base}`, '--', 'docs/project'], { cwd: repoPath });
  if (tree.status !== 0) return notChecked;
  const known = names(tree.stdout);
  const project = projectForBranch(head, known);
  if (!project) return notChecked;

  const path = String(tree.stdout || '').split('\n').find((p) => {
    const parts = p.split('/');
    return parts.length === 5 && parts[3] === project && parts[4] === 'PLAN.json';
  });
  if (!path) return notChecked;

  const mainShow = askGit(['show', `origin/${base}:${path}`], { cwd: repoPath });
  if (mainShow.status !== 0) return notChecked;
  const headShow = askGit(['show', `origin/${head}:${path}`], { cwd: repoPath });
  if (headShow.status !== 0) return notChecked;
  if (mainShow.stdout === headShow.stdout) return { checked: true, ok: true, problems: [] };

  const before = readPlanText(mainShow.stdout);
  if (!before.plan) return notChecked;
  const after = readPlanText(headShow.stdout);
  if (!after.plan) {
    return { checked: true, ok: false, problems: [`the plan no longer parses: ${after.problems[0]}`] };
  }

  const index = stepOfPr(after.plan, Number(pr));
  const { ok, problems } = unauthorisedChanges(before.plan, after.plan, index);
  return { checked: true, ok, problems };
}
