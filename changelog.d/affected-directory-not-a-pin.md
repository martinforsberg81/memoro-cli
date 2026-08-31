section: Fixed

- **One new plan document ran a quarter of the suite; now it runs nine files.**
  `scripts/affected-tests.js` treated any quoted string resolving to a tracked
  directory as a claim on every file underneath it, at any depth, and then let
  that claim travel the import graph. `src/mc/run.js` spells the project tree
  to build a plan's path, so adding one document under it selected **58 of 250**
  test files — every one of them for the same reason, and none of them a reader
  of that document.
  A directory literal says one of two things and depth tells them apart. The
  files **directly in** it are an open — `canon/roles/<kind>.md` is a join away
  from a literal, and the module opens the file on behalf of everything that
  calls it, so that edge still travels the closure exactly like a pin. The tree
  **under** it is a walk, and a walk stops at whoever spelled it: building or
  scanning a tree gives a caller no dependency on any one file in it.
  The walk edge also stops believing one-segment literals, for the reason
  `PIN_TOKEN` already refuses `'index.js'` — `'docs'` is a segment handed to
  `join()` far more often than a tree anybody reads, and it was worth 5 of the
  58. The open edge still honours them, so a new `changelog.d/` fragment stays
  explained rather than falling back to the whole suite.
  Measured 2026-08-31 for the same one-document diff: **58 of 250 before, 9 of
  250 after**, and the nine are the tests that spell a path under the project
  tree themselves — `plan-file-shape`, `archive-live`, `brief-collect`, `page`,
  `page-cache`, `plan-schema`, `retire-decisions`, `run`, `status-collect`.
