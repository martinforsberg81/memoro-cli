section: Added

- **Every deploy is checked afterwards, with nobody present.** The runner's chore
  pass starts a detached check for each deployed row: production's `/api/version`
  and `/ping-d1`, the gating suites of `mc test prod` as the seeded test account,
  and the error fingerprints new since the deploy, read 30 minutes after it. The
  verdict — `green`, `red` or `could-not-run`, with `check_at` and `check_why` —
  is in the deploy's row in `deploys.tsv`, on the page's RECORDED line, in
  `mc deploy`'s plan and `--json`, and in the helper's digest. A red does nothing
  else. `mc test prod` is the same round and still runs only when typed.
