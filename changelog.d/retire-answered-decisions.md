section: Added

- **`mc run` retires an answered decision once its plan carries it.**
  `~/mc/*/decisions/` was append-only by accident: nothing had ever deleted a
  decision file, so on 2026-08-29 it held 51 of them, 42 answered — every
  reader had to sort 51 to find the 6 that were live. At the end of each round
  the runner now removes an answered file whose owning plans have all left
  `waiting-decision`, and says so in `runner.log`. The test is deliberately
  not "has a `**Beslut:**` line": measured against `~/mc`, eight answered files
  were still needed by a plan that had not absorbed them yet
  (`avatar-image-animation` with seven, `mc-utredning/mc-2.md` which
  `mc/mc-helper` was waiting on), and deleting on the answer alone would have
  taken those answers away before the sessions that apply them ever ran. A
  file no plan on main owns is an **orphan** — reported, never deleted by a
  machine. `retireDecisions()` in `run-plan.js` is the rule; `tests/mc/retire-decisions.test.js`
  and four cases in `tests/mc/run.test.js` cover it.
