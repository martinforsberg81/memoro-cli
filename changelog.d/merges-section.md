section: Changed

- **MERGES is two repository queues, STEPS is the runner.** Each repository
  keeps one row, with landing phase and queue age, waiting PRs, inline reds,
  mends and fixes, its last landing and its own 24-hour merge count. The
  heading shows actual deploy/gate/lease pauses and a stopped merger in red;
  normal work is plain, detail grey and successful merge counts green.
  `mc --json` exposes the same queues as `merges.repos[]`.
