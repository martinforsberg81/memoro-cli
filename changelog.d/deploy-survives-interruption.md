section: Fixed

- **A stopped `mc deploy` no longer blocks the next one.** On 2026-10-05 a
  deploy was stopped while wrangler hung, between stamping and restoring.
  mc died with the signal. Its row stayed `running`, `src/version.js` and
  `public/sw.js` stayed stamped, and the next `mc deploy` refused the
  checkout as dirty. Now:
  - On ^C, a closed terminal or SIGTERM, mc passes the signal on and waits
    while `deploy.mjs` restores its stamps and prints what production runs.
    It then completes the row: `the deploy was stopped by SIGINT at
    wrangler deploy — production unchanged — …`.
  - A `main` whose only changes are a deploy's stamps is let through, and
    the reading says so. `leftoverStamps` checks the diff line by line, and
    `deploy.mjs` restores those stamps before it builds. Any other change
    is refused as before.
  - A row still `running` when the next deploy takes the lease is closed as
    `failed`, and its note says it never came back.
