section: Added

- **`mc repo nightly start|stop|status` — the whole suite of every repository,
  on an interval, with nobody asking.** memoro's full suite ran when a person
  typed `npm run test:full` and at no other time; every workflow under its
  `.github/workflows/` is `workflow_dispatch:` and Actions has been
  billing-blocked since 2026-08-04. #10529 is what that produces: four days of
  merges left 31 tests red on `main` while every pull request's
  affected-selection passed, because nothing ever looked at the whole.

  So a second meter beside the watcher — a detached process, a pid file checked
  against the process table *and* against the runner's own command line, a log
  capped at a megabyte, everything atomic and everything under mc's home. Its
  tick is `mc test <repo> --full` for every repository mc knows, and it is the
  same `runGate` a person's `--full` calls rather than a copy of it, so the
  scheduled reading and the asked-for reading cannot disagree about what a
  repository's whole suite is.

  It is a meter and nothing more (ruled by Martin, 2026-09-02): what it finds
  refuses no merge, delays no round and changes no verdict. It never commits,
  never pushes, never writes inside a repository. A tick that finds
  `gate-lock.js` held by a live round **skips and says whose round it was** —
  it never queues behind a merge round and never makes one wait 300 s, because
  that lock has no expiry on purpose. There is no queue, no backoff and no
  notion of a run that is "overdue": a missed night is a missed night and the
  next tick runs. The cadence is measured from the last completed tick rather
  than from a wall-clock hour, so a laptop that slept through 03:00 gets one
  tick on waking and not a catch-up burst.

  Default once a day; `--interval <seconds>` is the watcher's flag with the
  watcher's unit. Measured 2026-09-03: a tick that met a running `mc test
  memoro-cli --full` skipped it by pid in 9 s, and the ticks after it measured
  memoro (2,021 files) and memoro-cli whole, each logged with its start, its
  duration, the commit of `main` it measured and its result.

  **Stopping it stops the suite too, and that is not what a plain kill does.**
  Measured 2026-09-03: `mc test memoro-cli --full` killed 8 s into its suite
  left two `node --test-concurrency=0` workers at `ppid 1`, still burning cores
  after the round that started them was gone — the pre-existing behaviour of any
  killed gate round, survivable when a person did the killing and can see what
  is left, not survivable in a process that runs unattended every night. The
  scheduler is spawned detached, so it is its own process-group leader and
  `mc repo nightly stop` signals the group: the round in flight, its `npm run
  test:full`, and the seven workers under it. Verified with a full memoro suite
  in flight — after the stop, no `npm`, no `run.mjs`, no worker, no pid file,
  and the round gave back its lease and the round lock on the way out.
