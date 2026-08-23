section: Added

- **The watchers are on the board** (KP-08 point 1 — the last silent link).
  PM is woken by a file, queued wakes are retried by the session guard, the
  repository page is kept fresh by its watcher; if one of them quietly dies
  the chain breaks and the only trace is that nothing happens. `mc status`
  now carries a `watch` row under the header, one cell per watcher, each in
  its own words: *alive, last round 3m* · *alive but stale — no round in 2h*
  · *NOT RUNNING — stopped without telling anyone* (a pid file whose process
  is gone) · *never started*. Read from the same state the `status` verbs
  read. `--json` carries `watchers: { pm, sessions, repo }`. The first live
  run of the row said *watch sessions: never started* — the guard that
  flushes the wake queue had never been started on the machine.
