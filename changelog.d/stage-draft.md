section: Changed

- **Stage `plan` is renamed `draft`**: `draft → build → review → finish →
  merge → done` (or `dropped`). The stage names the goal's state; plan is the
  interactive session that writes drafts (Martin, 2026-11-07). `mc goal new
  --stage draft|build`, `mc goal stage draft`, the page, `mc goal list` and
  every text say `draft`. A GOAL.json or a LOG.md heading written with `plan`
  reads as `draft` (`readStage` in `goals.js`, which also reads the older
  `merging` as `merge`); `mc goal convert`, and the runner's `convertAfter` on
  its next pass, rewrite such a GOAL.json once with an entry `stage draft,
  from plan (the stage was renamed 2026-11-07)`. LOG.md history stays as
  written. `--stage plan` on a new goal is refused like any other word.
