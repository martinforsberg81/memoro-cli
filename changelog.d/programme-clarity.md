section: Fixed

- **Keep programme PRs under their programme once.** Goal and standalone
  programme PRs no longer repeat in PULL REQUESTS or inflate its nobody-owned
  count. A `plan/<programme>` branch stays attached when checked out in a
  scratch worktree. Unassigned PRs remain visible.
- **Make programme groups easier to scan.** Cyan rules separate programmes,
  column labels are bold, and goal counts, names and repositories use the
  terminal foreground. Finished goals keep readable names; their state and
  history stay grey. Planning stages are cyan.
