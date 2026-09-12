section: Changed

- **`mc merge` waits its turn instead of refusing.** A second `mc merge` that
  meets a busy gate or a held repository lease no longer stops at `busy` or
  `lease` and hands the refusal to the runner's merge lane — it writes itself
  into `~/mc/runner/merges.json` as a waiter and polls every 15 s, taking the
  gate when it is the oldest live waiter and both the lock and its own
  repository's lease are free. Past eight minutes it prints one `run this
  again` line, keeps its place in the queue and exits 3, rather than looping
  past a session's own ten-minute command ceiling. `busy` and `lease` are gone
  from `QUEUEABLE_STOPS`: a call that already waited cannot also be queued for
  the runner to retry.
- **A pull request from a project branch is checked against its plan before
  the gate.** A branch naming a project's `PLAN.json` is compared, main's copy
  against the pull request's head, and a change outside a step session's
  writable fields — `status`, `pr`, `comments`, `blocked_by`, and `met` on the
  criteria it met — stops the merge at `plan-trespass` with every problem
  printed, before a suite ever runs. A branch naming no project, or a head
  byte-identical to main's, is never checked at all.
