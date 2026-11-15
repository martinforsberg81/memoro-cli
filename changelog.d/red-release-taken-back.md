section: Added

- **A release whose check is red is taken back at once.** When the check after a
  deploy is red and the release's reading says it can be taken back, the runner
  puts every Worker it changed back to the version recorded before it (memoro's
  `scripts/release/take-back.mjs`, run from the release's own sha), and the check
  runs again on the take-back row. The commit taken back, and what comes before
  it, is no pick until a later commit is green, also under `--accept-red`. Every
  red opens a main-red repair, one member `check:<part>@<started>` per red part.
  A release that cannot be taken back is never taken back by itself: it comes to
  `mc martin get` as a `take-back` item with exact steps, from the red ledger
  `~/mc/runner/check-red.json`. `mc deploy take-back [--dry-run] [--despite
  "<reason>"]` is the same take-back by a person, and `--end <started> --reason`
  ends a desk entry. `deploys.tsv` gains `takes_back`, `takes_back_sha` and
  `takes_back_why`; a session is refused `take-back-run.js` and the provider
  script.
