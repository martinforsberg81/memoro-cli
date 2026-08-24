section: Changed

- **`mc doctor` folds identical findings into one counted line.** Twenty-
  eight identical `dev-server-session-unbound` rows stood in every
  heartbeat for a day and nobody read them, PM included — a diagnostic
  that repeats one line twenty-eight times is a counter, not information
  (2026-08-24), and it had drowned itself long before the `NOT IN FORCE`
  section arrived above it. Now a crowd of identical (scope, reason)
  findings is one line — `! session dev-server-session-unbound × 28
  (first: <id>)` — and one of a kind keeps its id and its row. `--json`
  is untouched: the folding is in the rendering, never in the data.
