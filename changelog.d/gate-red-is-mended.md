section: Changed

- **A red or stuck full run before a deploy says exactly why and is repaired by mend.**
  Each gate suite's and command's whole output is kept in
  `~/mc/runner/deploy-prepare/<started>/<suite>.log` as it runs, until the stop
  is settled and while a queued repair names it. A refusal gives what the suite
  stated (its closing `verdict: ` lines, at most ten) and `whole output: <path>`,
  also in the row's new `output_path` cell, `deploy-prepare.json`, the page and
  `--follow`; a red suite that states none is refused as stating none. A red gate
  suite is a main-red member `suite:<name>`, and a red or stalled full run that
  no mend holds is queued by the preparation, once per stop. A full run that
  cannot start (worktree held, lease, reservation) is a deploy-mend request of
  origin `full-run`, said on the page and never retried as a deploy; the full run
  ends the processes its own round started, and every suite of a round runs with
  `MC_TEST_MODE=1`. The 10-minute hold refusal of the deploy gate is a wait said
  each minute, and a deploy or a merge never makes time a verdict: a slow test is
  recorded.
