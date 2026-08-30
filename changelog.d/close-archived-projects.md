section: Fixed

- **A workarea whose plan an earlier round archived is closed, not orphaned.**
  The plan goes off main first and the folder second, and until now both had to
  happen in the same round: the closing tested `status: done`, so a plan an
  earlier round had already archived read as "no plan on main" — the one state
  no machine ever acts on. Measured 2026-08-30, the closing had never once run.
  The only round that reached the archive took three projects off main and was
  then cut short by STOP before step 6; the next round found three folders it
  could no longer explain and filed them with the fifty-seven nobody can.
  `closable` now asks the record the archive itself writes:
  `docs/project/project_log.md` names every project the runner has ever taken
  off main, read straight from `origin/main` at the end of the round, so a round
  cut short is finished by the next one. The other two facts are unchanged and
  are what keep the widening honest — a clean worktree and a last runner step
  ending `merged` — so a folder somebody made by hand that happens to share a
  name with an archived project has no step to point at and stays. What is
  written to `~/mc/intake/unplanned-workareas.md`, and the heading it carries,
  is now *no project on main*: no plan **and** no row in the log.
