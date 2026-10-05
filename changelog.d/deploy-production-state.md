section: Changed

- **A failed `mc deploy` says what production runs, instead of "may be
  part-way".** memoro's `deploy.mjs` now ends a failure with a summary whose
  `Production` line says how far it got — `unchanged — no new Worker version
  was uploaded`, a new version live with its triggers not deployed, or live
  with a later step failed — and retries wrangler's network faults (DNS,
  timeouts, `fetch failed`) before giving up. `readScriptOutput` reads that
  line, the `Cause` beside it and the `↻` retry lines; the closing line and
  the `deploys.tsv` note carry the production state, and a green deploy that
  needed retries says so (`went through after 1 retry on network faults`).
  Output from a script without the summary keeps the old warning.
