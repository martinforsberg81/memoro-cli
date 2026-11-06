section: Fixed

- **Start automatic disk cleanup below 30 GB while admitting work at 20 GB.**
  Separate the cleanup trigger from the admission floor, retain the 40 GB
  recovery target, preserve cleanup cooldowns while work is admitted, and show
  cleanup-only pressure without a false session-pause banner.
