section: Fixed

- **Merge measurements reuse the existing branch checkout.** PR gates, docs
  gates and branch freshening borrow a clean, idle checkout instead of creating
  another worktree. They restore the branch, retain unexpected changes and
  refuse unsafe or missing checkouts.
