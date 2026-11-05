section: Added

- **Programme priorities and finish-first scheduling.** `mc programs priority
  <programme>... --set <n>` sets one or several programme preferences, read
  live and shown on the page and programme list. The page prompt also accepts
  `priority <programme>... --set <n>`. Blocked recovery precedes finish/merge,
  review, build and next-step planning; repository fairness then higher
  programme priority decide within each stage. Continuing a build no longer
  jumps ahead of recovery or review. Zero restores the default.
