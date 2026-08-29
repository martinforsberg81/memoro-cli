section: Changed

- **The runner runs `ready` plans and nothing else.** Two jobs it had taken on
  are gone (Martin, 2026-08-29). It no longer **writes plans**: a workarea with
  no PLAN.md used to get a headless `triage` session that invented one and
  landed it on main by itself, so work could begin on a plan nobody had agreed
  to. It is now a skip that says `take it through mc plan <name>`, and
  `canon/roles/triage.md` is deleted. And it no longer **reads decisions**:
  `waiting-decision` is simply not ready, no `**Beslut:**` line anywhere starts
  a project, and a plan comes back only by being set `ready`. `chooseKind` lost
  its `answered` parameter, `stepPrompt` its answered-decisions block,
  `answeredDecisions()` and `isAnswered()` are gone from `mc run`, and
  `~/mc/bin/runner.sh` — still the runner that runs the nights — lost the same
  two branches. Retiring answered decision files moved out of the runner's
  round and into `mc brief --collect`, which tidies before it builds the
  agenda; `retireDecisions()` now lives in `brief-collect.js` beside the rest
  of the decision reading.

- **A queued name with no plan on main is dropped, not skipped.** The runner
  used to take `queue.md` literally and log a skip line every round for
  whatever it named that had no plan. Nobody reads that line (Martin,
  2026-08-29: "Ingen skip-rad: vem ska läsa den!?"), so `assembleQueue` filters
  the queue against the plans on main and `chooseKind` returns a `skip` of
  `null` in the mid-round race. An unplanned workarea shows in `mc status`'s
  WORKAREAS WITHOUT A PROJECT block, where somebody actually looks.

- **`~/mc/bin/` is deleted** — `runner.sh`, `runner-stop.sh` and the backup.
  `mc run` had already taken over the nights (the live tmux `runner` session
  was `mc run` when this landed), and keeping a second implementation of the
  queue and the step rules meant every change had to be made twice. ("Ta bort
  gammal shell-runner. Inget att hålla kvar.")
