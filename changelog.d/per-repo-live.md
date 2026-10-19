section: Changed

- **A new lane count takes effect without `mc run --update`.**
  `mc run lanes <n>` used to wait for the next start of the runner, so changing
  a number cost a handover. The runner now reads `per_repo` on every poll: a
  raised count starts the new lanes within half a minute, and a lowered one
  lets each lane above it finish the step it is in and then end, starting
  nothing more. `mc run lanes` says both numbers apply now.
