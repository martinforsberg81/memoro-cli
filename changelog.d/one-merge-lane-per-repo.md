section: Changed

- **One merge lane per repository, and no session waits for a gate.** `heavy`,
  `light` and the session lane are gone: two rounds of one repository exclude
  each other, two repositories run side by side. `mc gate` starts at once at low
  priority, and an unnamed gate leaves test files that cost too much, by
  measured time, to the merge round, which runs them all. It says which, and the
  tests the change touches always run.
