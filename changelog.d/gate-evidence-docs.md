section: Fixed

- **Clarify local gate ownership and safe scratch initialization.** Distinguish
  worktree exclusion, detached child lifecycle and merger-lane reservations;
  allocate one temporary root when `MC_SCRATCH` is unset and reuse it for replay
  artifacts. Scheduling, evidence runtime and protection remain unchanged.
