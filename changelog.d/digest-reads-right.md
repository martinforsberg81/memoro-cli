section: Fixed

- **The digest no longer counts a lingered successful step as an anomaly.**
  `runs.tsv` records exit 143 for a step the runner grace-killed after it had
  answered, about three quarters of all step rows since 2026-09-25, and the
  memoro-cli digest skipped a `success` row only at exit 0, so every newly
  started project opened as new fingerprints. `success` with 0 or 143 is now
  normal; any other exit is still named.
