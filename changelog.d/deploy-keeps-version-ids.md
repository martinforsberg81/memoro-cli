section: Added

- **A deploy's row names the Worker versions it came from and made.** After a
  deploy, `deploys.tsv` has three new columns, `versions_before`,
  `versions_made` and `versions_why`: the Cloudflare Worker version `memoro`
  and `memoro-tail` served before the deploy, the one the deploy made, and why
  one of them is missing. They are read from the `Worker version before|made:`
  lines `scripts/deploy.mjs` now prints and repeats in its closing block, so a
  take-back can return each Worker to the version it had. `mc deploy --json`
  carries them as `versions`; a deploy that failed or was interrupted records
  what it knew, and a script that printed none says so in `versions_why`. Older
  rows read as before, and the progress bar places the new `Read live Worker
  versions` step in the Publish phase.
