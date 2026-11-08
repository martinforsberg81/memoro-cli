section: Fixed

- **Merge recovery counts failed merges.** The first two failures run mend,
  which returns the goal to merge/ready for another attempt. The third failure
  waits on Martin. Repair sessions and ready handoffs do not consume or reset
  the failure count, and a ready repair with no queued job is delivered again.
