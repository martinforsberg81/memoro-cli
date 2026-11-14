section: Changed

- **`mc deploy` ships only a commit measured whole and exercised, and a headless
  session cannot deploy.** Before its one question it reads the history for a
  completed full run of exactly the commit that would ship, starts one when none
  exists (`--dry-run` only says one is needed), and runs the suites declared in
  memoro's `.mc/test.json` against a local server of that commit. A red or
  stalled run, a failed suite or one that cannot run refuses, naming the red
  files, the mend and the suite's last lines; a suite exiting with the skip code
  is named as skipped. The suites run on the shared checkout's server, which
  must be clean and on main at that commit: uncommitted changes there refuse.
  `--accept-red "<reason>"` is the only way past a red; the
  reason is required, shown in the question and kept. `deploys.tsv` gains
  `full_commit`, `full_verdict`, `suites` and `accepted_red`. The deployer
  fast-forwards to the measured sha and refuses when main stands elsewhere.
  `MC_HEADLESS=1` refuses before any fetch, full run or suite.
