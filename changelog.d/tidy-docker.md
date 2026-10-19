section: Added

- **`mc tidy` prunes Docker images and build cache unused for three days.**
  The prune runs only when the runtime is already up, including in the
  runner's daily tidy and its tidy after a lane skipped for disk, and it
  never starts OrbStack. `mc tidy --docker` tidies Docker and nothing else:
  the dry run shows what is reclaimable, and `--apply` starts the runtime if
  it is down, prunes, and releases its lease.
