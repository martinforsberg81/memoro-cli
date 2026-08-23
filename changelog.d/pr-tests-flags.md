section: Changed

- The pull request's own tests run with **declared** node flags
  (`pr_tests_flags` in the gate declaration), not flags inferred from the
  repository's `test` script. Measured 2026-08-23: memoro's runner adds
  `--import ./tests/_helpers/browser-paths.mjs` and the gate ran bare; the 14
  test files from one night's merged pull requests gave 123/123 either way,
  so the night's verdicts stood — but 3 of 1962 memoro test files import
  `/js/…` and would have failed the gate for environment reasons. memoro and
  memoro-cli ship their flags with the reason beside them; the round says
  which flags it ran with; the test-script heuristic remains the fallback
  for a repository that declares none.
