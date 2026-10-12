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
