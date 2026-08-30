section: Fixed

- **The test selector follows data, so a documented change stops running the
  whole suite.** `scripts/affected-tests.js` failed closed on any changed path
  that was not `.js` under `src/`, `tests/` or `scripts/` — and this
  repository's own protocol requires every pull request to add a
  `changelog.d/` fragment and a `docs/mc-command-matrix.md` row. So every
  protocol-following change ran all 250 test files twice, ~160 s of gate round
  spent to measure two lines. Measured 2026-08-30 over the last twenty merges
  to `main`: **17 of 20 ran the whole suite**, and 51 of the 63 paths that
  forced them were under `docs/` — each one named by the very test that checks
  it.
  A third edge reads that: a changed file under `docs/`, `canon/`,
  `changelog.d/`, `.claude/` or `.mc/` reaches the modules that name it, or
  that name a directory above it — which is the only written-down link to a
  file whose name is built at run time, as `readCanonRole` builds
  `canon/roles/<kind>.md`. A test is then selected when its own closure
  contains one of those readers. Over the same twenty merges the fallback drops
  to **0 of 20**, and a typical change selects 59 of 250 files.
  The widening is a list, not a rule: everything outside those five directories
  still runs the whole suite, because a manifest changes what every test runs
  *inside* and whoever happens to name it understates its reach. The selector
  also excludes itself from the naming map — `DATA_DIRS` spells `docs/` as a
  classification, not as a place it opens, and counting it would have made this
  one file a reader of every document in the repository.
