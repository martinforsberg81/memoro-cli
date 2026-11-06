section: Changed

- **A review never starts on a dirty goal worktree.** The runner checks each of the goal's worktrees with `git status --porcelain` before a review session; a dirty one starts no session and sets the goal `review · blocked`, naming the worktree and up to ten changed paths. A review that dies with its tree left dirty has those paths written into its LOG.md entry.
- **`mc publish` and `mc goal stage <goal> review|merge` refuse a branch that conflicts with origin/main.** Each fetches origin and asks `git merge-tree` whether the branch merges cleanly; a conflict is refused before anything is pushed, queued or staged, naming the paths. A branch merely behind main is not refused, and a failed fetch is a warning.
