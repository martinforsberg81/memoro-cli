section: Fixed


- **A retried goal reaches its build.** The starting gate waits for its verdict
  instead of counting an unfinished gate as a failure, bounded by the session's
  total awake time rather than the tool wait. A retried tree that touches what
  main touched is committed and goes through integration, where git used to
  refuse the merge. `mc programme status` no longer draws a build that stopped
  before its session started as running or in flight.
