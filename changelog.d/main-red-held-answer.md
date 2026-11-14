section: Added

- **A goal-less main-red repair that waits on Martin can now be answered:
  `mc repo mend <repo> <id> requeue|drop --reason "<text>"`.** A repair that
  failed twice sat at `Martin` with no verb to move it, and the desk item
  could be closed over it while the repair stayed held. `requeue` makes the
  entry `queued` with its failures reset and keeps its branch, worktree and
  pull request, so the runner offers it again and the mend prompt carries
  your reason. `drop` finishes it: an open pull request only that repair
  carried is closed with a comment, confirmed and taken out of the merge
  queue first, and a new red for the same file queues a fresh repair. The
  person and the `martin` and `decision` roles may answer; every other role
  is refused. `mc martin item <id> close` on a main-red item is refused
  while the entry still reads Martin, and a repair that reaches Martin again
  after an answer opens a new desk item. A finished repair's worktree is now
  removed by one function that keeps a tree anything unfinished still names.
