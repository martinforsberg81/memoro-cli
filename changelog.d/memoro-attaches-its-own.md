section: Changed

- **A worktree `mc` adds is attached to memoro's dependency cache.** `addWorktree` ran no install for memoro, so 16 memoro checkouts held a full `npm ci` of their own, about 510 MB each. It now runs the repository's `scripts/ensure-worktree-deps.mjs` when the repository has one, which links the checkout into the per-lockfile cache as `package-links`. The attach is reported, never fatal, and the runner passes `attach: false` because it attaches before each step itself.
