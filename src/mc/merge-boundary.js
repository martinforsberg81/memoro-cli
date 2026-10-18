/**
 * The door: a pull request from a project branch may not change more of its
 * `PLAN.json` than a step session is allowed to.
 *
 * Runs before the gate, because a trespass is a fact about the pull request,
 * not about what a suite would measure. Fails open on anything it could not
 * read — `gh` down, the fetch failing, a branch that names no project, a
 * base or head copy that will not `git show` — because `prFacts` (repo-gate.js) asks
 * GitHub again moments later and stops the round at `pr` when it cannot; a
 * second, different refusal for the same missing answer tells the operator
 * nothing new. The one thing it invents a stop for is a head plan that does
 * not parse: nothing later would catch that either.
 *
 * A head whose plan is byte-identical to the base's passes without running
 * the comparison — most pull requests from a project branch touch code or
 * docs, not the plan, and the comparison is only interesting when the plan
 * moved.
 *
 * "Before" is the plan the branch started from, not main as it is now: the
 * `git merge-base` of `origin/<base>` and `origin/<head>`. A planning commit
 * that lands on main while the step runs would otherwise read as the
 * session's own edit. A branch that merged origin/main into itself has that
 * merged main commit as its merge base, so main's edits up to that merge are
 * in "before" and are not the session's — the intended reading. When the merge
 * base cannot be read, or the plan did not exist there, "before" falls back to
 * `origin/<base>`, main as it is now.
 *
 * A pull request stacked on a step still landing (ruling 30) is read against
 * that step's tip as well, since main does not have its plan edits yet. Either
 * reading passing is a pass: the recorded tip goes stale once the step below
 * merges main into itself, and a plan edit main brought with it is no more the
 * session's than one that landed on main directly.
 */
import { spawnSync } from 'node:child_process';

import { readPlanText, unauthorisedChanges, unmetCriteria, unmetWords } from './plan-schema.js';
import { stepForMerge } from './merge-step.js';
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

/**
 * The plan texts the branch may have started from, each a `git show` result:
 * `path` at the stacked step's tip when there is one, then `path` at the merge
 * base of the two refs, else on `origin/<base>`. Empty when none will show.
 */
function beforeTexts({ askGit, repoPath, base, head, path, from = null }) {
  const texts = [];
  if (from) {
    const atFrom = askGit(['show', `${from}:${path}`], { cwd: repoPath });
    if (atFrom.status === 0) texts.push(atFrom);
  }
  const mergeBase = askGit(['merge-base', `origin/${base}`, `origin/${head}`], { cwd: repoPath });
  const sha = mergeBase.status === 0 ? String(mergeBase.stdout || '').trim() : '';
  if (sha) {
    const atBase = askGit(['show', `${sha}:${path}`], { cwd: repoPath });
    if (atBase.status === 0) return [...texts, atBase];
  }
  const onMain = askGit(['show', `origin/${base}:${path}`], { cwd: repoPath });
  return onMain.status === 0 ? [...texts, onMain] : texts;
}

const notChecked = { checked: false, ok: true, problems: [] };

/**
 * `{ checked, ok, problems }` — `checked: false` means the question was never
 * asked (no project branch, or something could not be read); `ok: false`
 * means it was asked and the answer was a trespass.
 */
export async function planBoundary({ repoPath, pr, git, gh, from = null, index = null } = {}) {
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

  const befores = beforeTexts({ askGit, repoPath, base, head, path, from });
  if (befores.length === 0) return notChecked;
  const headShow = askGit(['show', `origin/${head}:${path}`], { cwd: repoPath });
  if (headShow.status !== 0) return notChecked;
  if (befores.some((show) => show.stdout === headShow.stdout)) return { checked: true, ok: true, problems: [] };

  const after = readPlanText(headShow.stdout);
  // The register knows which step this is; the plan on main often does not,
  // since a step's `pr` lives in the register, and `stepOfPr` then names the
  // first unfinished step — "changed by the session that ran step 1" (#13554).
  const step = Number.isInteger(index) ? index : (after.plan ? stepOfPr(after.plan, Number(pr)) : null);
  let verdict = null;
  for (const show of befores) {
    const before = readPlanText(show.stdout);
    if (!before.plan) continue;
    if (!after.plan) {
      return { checked: true, ok: false, problems: [`the plan no longer parses: ${after.problems[0]}`] };
    }
    const { ok, problems } = unauthorisedChanges(before.plan, after.plan, step);
    if (ok) return { checked: true, ok, problems };
    verdict ||= { checked: true, ok, problems };
  }
  return verdict || notChecked;
}

/**
 * The last step is where a plan becomes done, and done means its success
 * criteria met (Martin, 2026-10-18), so the last step's pull request does not
 * land while its plan leaves one `met: false`: the session measures, or fails
 * visibly (`mc step failed`). photo-analysis was archived on 2026-10-11 with
 * three criteria unmet on main.
 *
 * Its own function rather than part of `planBoundary`: that one passes a
 * byte-identical plan without reading it — exactly a last step that never
 * touched `met` — and a docs-only pull request, the usual close-out, never
 * reaches it. So `mc merge`, `mc merge --docs` and the runner's own queueing
 * each call this. The step is the one handed in (the register's), else the
 * one the pull request is (`stepForMerge`); nobody's step is not checked.
 * Fails open like `planBoundary` on anything it cannot read.
 *
 * `{ checked, ok, problems }`, and `unmet` (1-based) on a refusal.
 */
export async function criteriaDoor({ repoPath, pr, git, gh, step = undefined, env = process.env, entries = [] } = {}) {
  const askGit = git || run('git');
  const askGh = gh || run('gh');

  const asked = askGh(['pr', 'view', String(pr), '--json', 'headRefName,baseRefName'], { cwd: repoPath });
  if (asked?.status !== 0) return notChecked;
  let raw = null;
  try { raw = JSON.parse(asked.stdout); } catch { return notChecked; }
  const head = raw?.headRefName;
  const base = raw?.baseRefName;
  if (!head || !base) return notChecked;

  const target = step !== undefined ? step : stepForMerge({ env, head, entries });
  if (!target) return notChecked;

  const fetched = askGit(['fetch', 'origin', '--prune'], { cwd: repoPath });
  if (fetched?.status !== 0) return notChecked;
  const tree = askGit(['ls-tree', '-r', '--name-only', `origin/${base}`, '--', 'docs/project'], { cwd: repoPath });
  if (tree?.status !== 0) return notChecked;
  const project = target.project || projectForBranch(head, names(tree.stdout));
  if (!project) return notChecked;
  const path = String(tree.stdout || '').split('\n').find((p) => {
    const parts = p.split('/');
    return parts.length === 5 && parts[3] === project && parts[4] === 'PLAN.json';
  });
  if (!path) return notChecked;

  const headShow = askGit(['show', `origin/${head}:${path}`], { cwd: repoPath });
  if (headShow?.status !== 0) return notChecked;
  const { plan } = readPlanText(headShow.stdout);
  if (!plan || !Array.isArray(plan.steps)) return notChecked;
  if (target.index !== plan.steps.length - 1) return { checked: true, ok: true, problems: [] };
  const unmet = unmetCriteria(plan);
  if (!unmet.length) return { checked: true, ok: true, problems: [] };
  return {
    checked: true,
    ok: false,
    unmet,
    problems: [`step ${target.index + 1} is the plan's last, and ${unmetWords(unmet)} in this pull request — or mc step failed --reason "…" naming what could not be measured`],
  };
}
