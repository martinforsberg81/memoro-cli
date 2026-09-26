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
- **`mc dev reap [--dry-run] [--json] [--min-age-seconds <n>]`** removes the
  dev processes nobody owns any more, and the runner's chore pass runs it
  every pass: an unregistered static-server, measure-server or `scripts/dev.mjs`
  whose parent is pid 1 (older than 600 s by default), an esbuild `--service`
  or `workerd serve` whose parent is pid 1 (older than 120 s), and a
  registration whose worktree is gone. SIGTERM, 5 s, then SIGKILL; each is
  logged as `dev-server-reaped`. It is the only time mc signals a process
  itself (`docs/dev-server-protocol.md` § Safety contract).
