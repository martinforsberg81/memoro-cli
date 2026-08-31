section: Removed

- **The decision concept.** mc had one: `<area>/decisions/*.md`, a
  `**Beslut:**` line Martin appended that `ANSWER_LINE` regexed back out, a
  scan, a page section, a brief agenda, a retirement rule keyed on which plans
  still waited, and a `waiting-decision` step status. All of it is gone —
  `parseDecision`, `scanDecisions`, `retireDecisions`, `decisionsBlock`,
  `decisionsSection`, `decisionsForProject`, the DECISIONS block on `mc` and in
  `mc status <name>`, and the "Waiting on Martin" section of the brief. A step
  that cannot go on is `blocked` with `blocked_by`, which is all
  `waiting-decision` ever meant to the runner: it hands out `ready` steps and
  never read a decision file. What Martin decides is written into the plan it
  is about, by whoever next opens that plan, and carried into `rulings.md`.
  The merge ledger at `pm/decisions/merge-log.md` is untouched — it lives in a
  `decisions/` directory and is not a decision.
