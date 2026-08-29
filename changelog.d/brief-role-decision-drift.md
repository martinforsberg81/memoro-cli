section: Changed

- **The brief role's overlay no longer says the runner deletes an answered
  decision file.** Since 2026-08-29 the runner runs `ready` plans and nothing
  else — it does not read decisions at all — and `retireDecisions` runs from
  `mc brief --collect`. The overlay still described the old trigger, and the
  test that guarded it asserted the stale sentence word for word.
