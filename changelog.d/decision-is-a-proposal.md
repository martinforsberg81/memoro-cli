section: Changed

- **A decision put to Martin is one proposal he says GO to, never a menu.**
  Five role overlays agreed on a shape — "the options one line each, and a
  `## Rekommendation` section" — that produced its own failure: a brief on
  2026-08-29 opened with six unrelated three-option menus, and two of the six
  questions belonged to projects that no longer had a plan on main
  (`org-update`, closed by #11036; `test-architecture-2`, referenced by
  nothing). Martin could not take a position on any of it. `brief.md`,
  `worker.md`, `plan.md`, `triage.md` and `step.md` now ask for what the code
  says, what it costs, and the one thing the session would do — alternatives
  only where a real trade-off survived the reading. A question that is unclear,
  or that reading further would answer, gets no file at all: the session reads
  instead. `step.md` additionally writes an answered decision **into PLAN.md**
  rather than only "applying" it, because the plan is where a decision lives
  once the file is gone. `tests/mc/roles-decisions.test.js` holds all five
  overlays to both halves.
