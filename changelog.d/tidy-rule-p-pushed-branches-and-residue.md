section: Changed

- **`mc tidy` releases two more goal checkouts.** Rule P now releases a clean,
  inactive goal checkout whose commits beyond `origin/main` are all on its
  pushed branch `origin/goal/<goal>`, after one fetch of origin in the owning
  repository, and a checkout whose only ignored entries are the attached
  dependency link and memoro's rebuildable dev residue (`.wrangler/`,
  `public/dist/`, `scripts/dev/local-schema.sql`, `.venv-<name>/`,
  `__pycache__/`). Any other ignored entry, and any commit not on the pushed
  branch, still keeps a checkout; so does a failed fetch. The released branch
  keeps every commit, and the runner re-adds the checkout at the same HEAD when
  the goal next starts.
