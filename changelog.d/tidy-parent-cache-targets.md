section: Fixed

- **Count and remove nested tidy caches once.** When tidy already selects a
  containing worktree or area, its rebuildable bundle is omitted as a separate
  target so a successful parent removal does not produce a false cache error.
