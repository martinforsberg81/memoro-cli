/**
 * A project's branch, still checked out in the plan directory that wrote it.
 *
 * `mc plan` writes a project's plan on a branch named after the project and
 * lands it through a pull request; the planning session stays open in
 * `~/mc/plan/<programme>/<repo>`, on that branch, after the merge. When the
 * runner then makes the step's workarea it asks git for a worktree on the
 * same branch name, and git refuses: a branch is checked out in one place.
 * `voice-session-resume` and `week-focus-rows` were both blocked on
 * `worktree-missing` for it on 2026-10-12, each with a merged plan pull
 * request and a clean plan directory, and each was freed by hand the same
 * way: the plan directory detached where it stood, the branch deleted.
 *
 * That is what this does, and only when all of it holds: the worktree
 * holding the branch is under the plan home, it has nothing uncommitted, and
 * the branch has landed — by content (`branchLanded`), or, when that cannot
 * tell, by a merged pull request whose head is the branch's tip
 * (`mergedPullAtTip`). Detaching leaves every file where it is, so a planning
 * session still open there reads the same tree. Anything else is left alone
 * and the refusal git gives stays the runner's to report.
 *
 * `git(cwd, args)` and `gh(cwd, args)` return `{ ok, stdout }`, the shape
 * `deps.git` and `deps.gh` have in run.js.
 *
 * Returns `{ freed, holder, why }`: `holder` is the plan directory that held
 * the branch, `why` says why it was not freed (null when no worktree held it).
 *
 * What is left after that is `claimProjectBranch`'s: whether the branch is the
 * runner's to use at all.
 */
import { sep } from 'node:path';

import { branchLanded, mergedPullAtTip } from './branch-landed.js';

export function freePlanBranch({ repo, branch, planRoot, git, gh }) {
  const out = (cwd, args) => {
    const r = git(cwd, args);
    return r?.ok ? String(r.stdout ?? '').trimEnd() : null;
  };
  const holder = holderOf(out(repo, ['worktree', 'list', '--porcelain']), branch);
  if (!holder) return { freed: false, holder: null, why: null };
  if (!holder.startsWith(planRoot + sep)) return { freed: false, holder, why: 'not a plan directory' };
  const status = out(holder, ['status', '--porcelain']);
  if (status === null) return { freed: false, holder, why: 'git status failed' };
  if (status) return { freed: false, holder, why: 'uncommitted changes' };
  const landed = branchLanded(holder, branch, { run: (args) => out(holder, args) });
  if (landed === 'ahead') return { freed: false, holder, why: 'not landed' };
  if (landed === 'unknown' && !mergedPullAtTip(holder, branch, { gh: (args) => gh(holder, args), tip: out(holder, ['rev-parse', branch]) })) {
    return { freed: false, holder, why: 'not landed' };
  }
  if (!git(holder, ['checkout', '-q', '--detach'])?.ok) return { freed: false, holder, why: 'could not detach' };
  if (!git(repo, ['branch', '-D', branch])?.ok) return { freed: false, holder, why: 'could not delete the branch' };
  return { freed: true, holder, why: null };
}

/**
 * A project's branch name is the runner's. Asked after `freePlanBranch`, before
 * the runner makes the step's workarea, and answers one of four verdicts:
 * `absent` (no such local branch), `own` (a register step names it as its
 * `branch`), `recreated` (it had landed and no worktree held it, so it was
 * deleted) and `foreign` (anything else, with the `holder` and `why`).
 *
 * A landed leftover is replaced rather than checked out: its head is the
 * pre-squash commit, behind main and without the plan, and `morning-calls`
 * step 1 would have started on it on 2026-10-14 had no worktree held it. An
 * `ahead` or `unknown` one is never touched, because it may be someone's work.
 */
export function claimProjectBranch({ repo, branch, plan = null, registered = false, git }) {
  const out = (cwd, args) => {
    const r = git(cwd, args);
    return r?.ok ? String(r.stdout ?? '').trimEnd() : null;
  };
  if (!git(repo, ['rev-parse', '-q', '--verify', `refs/heads/${branch}`])?.ok) return { verdict: 'absent', holder: null, why: null };
  if (plan?.holder && !plan.freed) return { verdict: 'foreign', holder: plan.holder, why: plan.why || 'checked out there' };
  if (registered) return { verdict: 'own', holder: null, why: null };
  const landed = branchLanded(repo, branch, { run: (args) => out(repo, args) });
  if (landed === 'landed') {
    if (!git(repo, ['branch', '-D', branch])?.ok) return { verdict: 'foreign', holder: null, why: 'it has landed and could not be deleted' };
    return { verdict: 'recreated', holder: null, why: null };
  }
  return { verdict: 'foreign', holder: null, why: landed === 'ahead' ? 'it has commits that are not on origin/main' : 'whether it has landed could not be told' };
}

/** The worktree `git worktree list --porcelain` shows on `refs/heads/<branch>`. */
function holderOf(porcelain, branch) {
  if (!porcelain) return null;
  for (const block of porcelain.split('\n\n')) {
    const lines = block.split('\n');
    if (!lines.includes(`branch refs/heads/${branch}`)) continue;
    const path = lines.find((line) => line.startsWith('worktree '));
    return path ? path.slice('worktree '.length) : null;
  }
  return null;
}
