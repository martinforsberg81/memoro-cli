section: Fixed

- **`mc status` reads a killed merge the way the runner does.** `runStepClaimed`
  aborts a merge of origin/main left in progress before its dirty check, but
  `machineState` read the merge's rows as `a merge stopped in <path>`, reason
  `dirty` — so the page's NEXT and `mc status <name>` said a project waited on
  a person while the lane would have aborted the merge and run it. With
  `MERGE_HEAD` present the worktree now reads clean when every row is
  unmerged or has a blank second column (what main changed, staged); a
  worktree change or an untracked file beside the merge still reads `dirty`.
  The `RUN_REFUSALS` agreement test holds both cases against the round.
