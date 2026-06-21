# TODO

## MC broker and recovery hardening

- [ ] Make `mc setup` / `mc broker start` self-heal or clearly diagnose missing runtime dependencies such as `node-pty`, especially when the global `mc` install is symlinked to a local development worktree.
- [ ] Make `mc resume` robust after a broker crash: if the broker is down, dependencies are missing, or a stale socket/pid exists, it should recover or print a direct fix instead of failing or falling back into confusing state.
- [ ] Never let `mc resume` silently become a contextless fresh start. If the previous PTY is gone, resume must relaunch the same provider-native session by id (`tool_session_id`, discovered from registry/transcript) or refuse with a clear error. Transcript-derived briefs may only be an explicit emergency command, never the normal `resume` path.
- [ ] Reconcile stale registry session states after a machine shutdown: `mc list`, `mc status`, and `mc resume` should not present old sessions as live when the broker has no attachable PTYs.
- [ ] Add server/cloud tombstone support for stale coding sessions when the broker machine is offline. `mc sessions stop/remove` can now control connected brokers, but cloud also needs an explicit expire/delete path for entries whose machine will not reconnect.
- [ ] Add an explicit cloud-initiated worktree cleanup flow that maps to `mc end <name>` safety semantics. It must be separate from broker `remove_session`, surface dirty/ahead/live verdicts, and require confirmation before deleting a worktree or branch.
- [ ] Detect registry entries whose worktree path no longer exists, and offer a safe repair/relink flow instead of reporting them as resumable live sessions.
- [ ] Add a one-command recovery path for interrupted multi-worktree days that reports dirty worktrees, stale broker sessions, missing dependencies, and the exact `mc resume <name>` commands needed to restart.
- [ ] Cover broker startup dependency checks and stale-session recovery with tests so users do not need ad hoc filesystem or log inspection after a crash.
