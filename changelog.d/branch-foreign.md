section: Fixed

- **The runner uses a project branch only when it is its own.** On 2026-10-14
  `morning-calls` step 1 went `blocked` on `worktree-missing` four minutes after
  its plan landed, on git's raw `'morning-calls' is already used by worktree at
  '…/scratchpad/wt3'`: the planning session had opened its pull request from a
  branch named after the project and kept it checked out in its scratchpad,
  which `freePlanBranch` does not free because it is not under `~/mc/plan/`.
  Under it was a second fault: with no holder, `addWorktree` would have checked
  the existing branch out — the pre-squash head, behind main, with no
  `PLAN.json` — and started the step there. Now `claimProjectBranch`
  (`plan-branch.js`) is asked before the worktree is made. A branch held by a
  worktree the runner did not free, or one ahead of origin/main (or that cannot
  be told) that no register step names, blocks the step as `branch-foreign`
  and names the holder. A landed one that no worktree holds and no register
  step names is a leftover: it is deleted, the workarea starts from
  origin/main, and runner.log says so in one line. The plan role and `mc plan`'s
  launch prompt name a plan's pull request branch `plan/<project>`.
