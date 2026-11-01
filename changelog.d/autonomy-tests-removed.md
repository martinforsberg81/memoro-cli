section: Removed

- **The autonomy tests, as they were.** Martin, 2026-11-01: autonomy in mc is
  still being built, and tests written during that build are meaningless;
  they come when it is finished. Removed: 28 test files (`autonomous-*`,
  `autonomy-*`, `provider-observations`, `goal-followup`, `goal-contract`,
  `programme-plan/-recovery/-jobs/-status/-events/-phases/-cli-smoke`,
  `commands/goal`, `commands/programme`, `commands/autonomous-project`,
  `session-control`, `session-observation`) and the eleven fixtures only they
  used (`autonomous-*-fixture`, `autonomy-lifecycle-fixture`,
  `programme-jobs-fixture`, `goal-followup-fixture`,
  `fixtures/session-process`, `fixtures/programme-installation`,
  `fixtures/autonomous-review-recovery-process`); the two closing `describe`
  blocks of `merger.test.js` and `merge-command.test.js` that stood on the
  autonomy merge fixture (14 tests) go with them, the rest of both files
  stays. Measured before removal: these files were 6 900 of the suite's 7 300
  measured seconds and 17 000 of its git processes. `autonomy-fixtures.js`
  stays — `plan-schema`, `plan-source` and `session-handoff` use its sample
  documents. The per-test ceiling comes down from 300 s to 60 s with them:
  the slowest test left measures 29 s.
