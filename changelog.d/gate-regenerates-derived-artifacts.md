section: Fixed

- **The gate regenerates derived artifacts after it merges main in.** memoro's
  SQL snapshot under `docs/plans/sql/` is a function of the whole tree, and the
  gate merges `origin/main` into the candidate before it measures — so the
  moment main gained a file under `scripts/` or `src/`, the candidate's
  snapshot was wrong, however recently the branch had regenerated it. The step
  could not win that race from its side; five attempts in one round proved it.
  A gate declaration can now carry `derived: [{ command, paths }]`. The gate
  runs the commands in the candidate after the merge: a clean tree changes
  nothing, dirt inside the declared paths is committed and measured, and dirt
  anywhere else is a red verdict (`derived-outside`) that names the files.
  Because main has to land byte-identical to the measured tree, `mc merge`
  freshens the branch with the same regeneration before its squash whenever
  the gate had to regenerate — and `freshenBranchForLanding` does it between
  the landings of a batch. memoro ships `npm run sql:inventory -- --write` and
  `npm run sql:coverage -- --write`, both on `docs/plans/sql/`.
