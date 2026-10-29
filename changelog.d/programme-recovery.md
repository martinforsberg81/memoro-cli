section: Added

- **Programme-owned autonomous recovery (inactive).** Keep failures with plan,
  preserve diagnoses and no-progress exceptions, coalesce shared-main incidents
  into one ordinary repair project, and release selected dependencies only after
  confirmation. External/planner retries are bounded and reached stops fence
  recovery. Existing v1 behavior and gate requirements remain unchanged.
- **Fence recovery boundaries.** Successor programme agreements return stale
  ready/reviewed work to plan, planned stops wait for builder claims, and an
  ordinary shared-main repair never depends on its own confirmation.
