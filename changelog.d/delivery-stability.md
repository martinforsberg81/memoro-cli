section: Fixed

- **Reserve test lanes atomically and verify affected code before publication.**
  Local gates and docs checks share the merge lanes; reservation failures stop
  execution. Local gates select tests and command gates from code changes,
  include untracked tests, and support whole project branches without a
  thirty-file limit. The bounded worker owns its reservation and subprocesses.
  Docs failures retain raw output, assertion details and rerun paths after
  candidate cleanup. Logs have unique names across simultaneous worktrees.
