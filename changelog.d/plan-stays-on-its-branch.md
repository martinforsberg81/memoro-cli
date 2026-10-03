section: Changed

- **The planning role says its checkouts stay on `plan/<programme>`.** It said
  only that a plan session creates neither a project's branch nor its
  workarea, and on 2026-09-26 a planning session wrote a plan on a local branch
  named after the project and stayed on it: the runner's `addWorktree` could
  not check that branch out into the workarea, and the step went `blocked` on
  `worktree-missing` until a person detached the planning tree. The role now
  says it outright — never check out or create a branch named after a project.
