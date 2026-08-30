section: Added

- **`mc run start`, `mc run stop [--force]` and `mc run --update` — a switch
  for the runner.** Turning it on meant a terminal to hold it in; turning it
  off meant `touch ~/mc/runner/STOP` and remembering to remove the file again.
  All three are now verbs, and all three are the same shape: a file under
  `~/mc/runner/` read at a **round boundary**, so an order reaches a runner
  ninety minutes into a headless step without that step being interrupted.
  `start` spawns the runner detached with its output appended to `runner.log`,
  carries the run's own flags through, and removes the `STOP` the last stop
  wrote — start and stop are one switch. `stop` writes `STOP`; `stop --force`
  does that and then ends the runner now, `SIGTERM` to its process group and
  `SIGKILL` two seconds later, taking the headless session under it — the group
  and not the pid, because killing the runner alone leaves `claude` running for
  another eighty minutes with nobody to read it — and clears the `runner.json`
  and `current-<repo>.json` a killed runner never gets to remove itself, which
  the page would otherwise draw as a step still in flight.
  `--update` makes the runner fast-forward the checkout mc runs from at the
  next round boundary, hand over to a fresh `mc run` on that code, and exit.
  It has to exist because Node reads its whole module graph at process start:
  the runner merges pull requests that change the runner, so one that has been
  up all day is running the code it started with. Measured 2026-08-29, four
  merged improvements to `mc run` sat unused for two hours; measured
  2026-08-30, the round that could first have closed a finished workarea ran
  for eighteen hours in a process started ninety minutes before the closing
  code was merged, so nothing was closed and no line said why.
