section: Added

- **A dev server no longer outlives the worktree that wanted it.** `mc work
  remove` and the runner's close of a finished workarea now stop every
  registered dev server whose `worktree_path` is inside the worktree — through
  the manifest's own `control.stop.argv`, never a signal — before removing it.
  `mc work remove` used to refuse such a worktree with `in use by node`; it now
  stops the server, waits up to 5 s for it to leave, and removes the worktree.
  A stop that fails does not stop the runner's close: `git worktree remove`
  decides, as before. Each stop is logged as `dev-server-stopped` with its
  reason (`workarea-closed`, `worktree-removed`, `asked`).
- **`mc dev stop <instance_id>`** stops one live server through its own stop
  command and logs it. Measured on 2026-09-26: seven registered servers and
  several orphans across worktrees, swap at 6.8–8.2 GB on an 8 GB machine.
