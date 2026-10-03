section: Fixed

- **The digest no longer counts a lingered successful step as an anomaly.**
  `runs.tsv` records exit 143 for a step the runner grace-killed after it had
  answered, about three quarters of all step rows since 2026-09-25, and the
  memoro-cli digest skipped a `success` row only at exit 0, so every newly
  started project opened as new fingerprints. `success` with 0 or 143 is now
  normal; any other exit is still named.

- **A failed admin script is named by its exit code and first meaningful
  line.** The digest reported the last line of the script's stderr, which was
  `}` closing wrangler's JSON dump or Node's `Node.js v24.10.0` banner, so the
  AI-provider section read `_could not read: }_` from 2026-08-30 on. It now
  reads `exit 1: wrangler d1 execute failed (1)`, or an uncaught exception's
  `Error: …` line.

- **A digest gathered without a network says so instead of raising
  `d1-unreachable`.** When every request to production goes unanswered in one
  run, the memoro digest now opens with one line saying this machine could not
  reach the network and leaves `d1-unreachable` out of the alarm list and the
  state block. On 2026-09-15, 09-29 and 10-02 every request said
  `fetch failed` and the digest raised `! d1-unreachable` over a healthy
  production. A refusal or a 5xx still counts as an answer.
