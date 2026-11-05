section: Changed

- **PROGRAMMES is a phase tree: programme → phase → goal → PR.** The current
  phase groups parallel goals; future phases and finished goals fold by default
  and expand with `a`. Blockers, malformed goals and open PRs remain visible.
  Goal rows have a stable menu number, title, stage and state; the obsolete kind
  column, session column and repeated phase-wait comments are gone. PRs have
  their own child rows, and standalone programme PRs have an explicit group.
- **Count phase-eligible work separately from waits.** The summary distinguishes
  work that can start, running work, later phases, planning, missing criteria,
  merge, blockers and finished goals. Running and finished goals, future phases,
  planning and builds without criteria no longer inflate the ready count.
