section: Fixed

- **The push guard no longer renames a tracked hook it reaches from another
  worktree.** With an absolute `core.hooksPath` in the bare repository's
  config, every worktree points at `~/mc/self/memoro/.githooks`; asked from
  another worktree whether `pre-push` was tracked, git said "outside
  repository", which read as untracked — so the guard moved memoro's hook to
  `pre-push.before-mc` and wrote its own, and `mc deploy` refused the dirty
  tree. Tracking is now asked from the hook's own directory, and a hook that
  already runs `mc repo push-check` is left as the guard in force.
