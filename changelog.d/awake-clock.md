section: Added

- **The runner has an awake clock that excludes machine suspend.** Node's
  monotonic clock counts suspend, so `awake_ms` had no source that could stand
  in for it. `src/mc/awake-clock.js` reads `CLOCK_UPTIME_RAW`, keeps counting
  across reboots, and never falls back to a clock that counts suspend: when the
  probe fails, the clock refuses to exist.
