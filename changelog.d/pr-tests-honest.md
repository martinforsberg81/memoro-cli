section: Fixed

- **The gate says what it cannot know about a PR's own tests, instead of
  guessing bare (D-0157 follow-up).** memoro's `scripts.test` became a
  wrapper (`node scripts/testing/ci.mjs`) and the flag harvester returned
  `[]` without a word: bare `node --test`, no loader, and every PR touching
  one of nine `/js/`-importing test files got red pr-tests that were the
  gate's own (measured 2026-08-24: 2 FAIL bare, 30/30 with the loader —
  the fault blocked a correct main-fix PR). Three repairs, one class:
  a wrapper test script with nothing declared is now a `pr-tests` stop
  naming the way in (declare `pr_tests_flags`), never a silent bare run;
  an override that shadows shipped declaration fields is said out loud
  ("DECLARATION SHADOWED — … an override states every field it wants",
  D-0135's hole, which ate `extra_gates` on the 22nd and `pr_tests_flags`
  on the 24th, same repository, same silence); and red own tests are
  counted by the summary's `# fail`, never by the number of red names —
  two failures carry three names, parents included, and the names stay
  but are said as names.
