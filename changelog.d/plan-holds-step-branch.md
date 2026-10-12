section: Fixed

- **A plan directory no longer blocks its project's first step.** `mc plan`
  writes a plan on a branch named after the project, and the planning
  session stays on it after the pull request lands; the runner then asked
  git for the step's workarea on the same branch and was refused, and the
  step was blocked on `worktree-missing` (`voice-session-resume` and
  `week-focus-rows`, 2026-10-12). Before adding the workarea the runner now
  detaches a plan directory that holds the branch — only when it is under
  `~/mc/plan/`, clean, and the branch has landed — and deletes the branch, so
  the step starts from origin/main (`plan-branch.js`).
