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
