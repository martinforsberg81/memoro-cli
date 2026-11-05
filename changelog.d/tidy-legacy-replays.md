section: Added

- **`mc tidy` reclaims completed runner replay worktrees (rule S).** Clean,
  registered marker-owned trees retain the existing completion checks, while
  marker-less legacy trees need matching finalized `.json.err` and `.jsonl`
  runner logs, no process or open files in their scratch session, and a clean
  worktree. Detached replay commits are retained under
  `refs/mc/retained-replay/<full-sha>` at apply before `git worktree remove`;
  logs, patches, receipts, memory and other scratch contents stay.
