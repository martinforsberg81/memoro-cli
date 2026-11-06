section: Fixed

- **Runner lanes recover promptly after reboot.** Simultaneous starts retry
  temporary disk admission contention within one second instead of sleeping
  for ten minutes. Allocation stays exclusive and rechecks disk space before
  launch; STOP and UPDATE cancel launches still preparing dependencies.
