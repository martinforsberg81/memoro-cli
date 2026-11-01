section: Changed

- **Every git call a test makes is counted, and every test has a time ceiling.**
  Martin, 2026-11-01: tests run locally against local files and make no git
  call at all, and a test over one second is misbuilt. Measured on origin/main
  the same day: 64 of 248 test files reach git, 99 % of the suite's measured
  time, one autonomy test ~380 git processes at ≥47 ms each. Two meters on the
  way there: `tests/_isolate-home.mjs` puts a `git` first on PATH that logs
  each call with the test file that made it and prints the count on exit
  (`MC_GIT_CALLS_STOP` turns the report into a red exit, for the day the count
  is zero); and the test script and the shipped declaration carry
  `--test-timeout=300000`, green today, lowered by every change that rebuilds
  a file until it reads 1000. Also: `realSuite` called a `noteTimes` it never
  defined (#1195), so a whole-suite round died on its close event; it now
  records the test times as `realTests` does.
