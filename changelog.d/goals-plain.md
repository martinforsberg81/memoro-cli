section: Added

- **A goal is two text files and a worktree.** `GOAL.md`, `LOG.md` and a
  worktree per repository on `goal/<goal>`, under
  `~/mc/programs/<programme>/goals/<goal>/`, made by `mc goal new` and read by
  `mc goal show` and `list`; anyone may work in the worktree. When a lane has no
  project step, the runner starts a headless session on the open goal whose last
  log entry is oldest. The session works, pushes with `mc publish --no-merge` and
  ends with `mc goal log`; three sessions in a row that say nothing block the
  goal. Goals are drawn under their programme after the project rows, and a
  goal's number opens `mc goal show`. See `docs/technical/mc-goals.md`.
