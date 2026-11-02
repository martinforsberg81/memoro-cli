section: Fixed

- **The open threads of the one-total runner (#1226), closed.** An old
  `lanes.json` of `per_repo 8` and no total migrates to the sixteen it ran,
  not a clamped eight (`mc run lanes` takes 1 to 16). Every write keeps
  `per_repo` and `total` beside `lanes`, so a runner older than the total —
  one finishing its steps through a handover — reads the same number instead
  of one lane per repository. `run-control.js` reads the count under the
  `MC_HOME` of the env it is handed, and every role is told to set `MC_HOME`
  and `MC_WORK_ROOT` under `$MC_SCRATCH` before probing mc's code. A session
  row fits its pull requests inside the terminal (`#14709 +3`) instead of
  running past it. A test pins the fix for the deadlock of 2026-11-02 — a lane
  that picks another project lets its carried slot go before it waits — and
  fails without it. The lane, goal-pick and build-role descriptions in
  `mc-run.md`, `mc-goals.md` and `mc-roles.md` say what the runner does now.
