section: Fixed

- Linux runner and dev-server admission now use the host's available-memory
  percentage from `/proc/meminfo` (`MemAvailable / MemTotal`), including
  reclaimable memory. Invalid or unavailable readings remain unknown and keep
  the existing fail-open admission behavior.
