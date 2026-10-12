section: Changed

- **A step with workers leads and the workers write it.** `_step-workers.md`
  now makes delegation the default: the step session keeps the design, what a
  test must show, thresholds, the plan, a gate's red and every `mc`, commit
  and push, and briefs `step-worker` for the rest, including writing and
  running tests. A third file opened or a second edit of the same kind is the
  cue to brief a worker; the check is `git diff --stat` and the hunks that
  decide something. The worker's own prompt and description follow: it may
  write the tests its brief describes, never weakens one it was not given, and
  answers short. Seven steps with workers on (2026-10-11..12, three under the
  #891 text, one with 108 Read and Grep calls) called none (Martin,
  2026-10-12).
