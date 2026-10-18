section: Changed

- **`mc gate` stops running the whole gate when it does not have to.** Before,
  every bare `mc gate` ran the repository's full gate, even for a diff of
  documents only, a tree it had just measured green, or one fix after a red.
  Now it checks four cases first (`gate-fast.js`). If nothing changed against
  the merge-base, or every changed path is a document under `docs/` with no
  script, it answers `GREEN` at once. It starts no child and records nothing.
  If the last whole gate here measured this exact tree green, it answers
  `GREEN (unchanged since …)`. If that gate was red, it runs only the red test
  files (`redFiles`, read off the log) plus what the declared `select` picks
  for each path changed since (`--changed-path`), marked `INCREMENTAL`. It is
  never recorded as a green for the merger. When anything is in doubt the
  whole gate runs, and `--full` always runs it. The whole gate's child gets
  `MC_GATE_FAIL_FAST=1`. `scripts/affected-tests.js` takes `--changed-path`
  as memoro's `ci.mjs --list` does.
- **`mc merge <repo> <pr>` lands a docs-only pull request without `--docs`.**
  Before, such a pull request was queued for the merger. Now, when GitHub's
  file list passes the `--docs` rule, it is routed to that form, which says so
  in one line and lands in the call. `canon/roles/_common.md` no longer says
  that `mc merge` always queues.
