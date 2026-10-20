section: Removed

- **The plan boundary and `plan-trespass` are gone** (ruling 48). `mc merge`,
  `mc merge --docs` and the runner's queueing of a session's pull request no
  longer compare a step session's edit of its plan with the plan it started
  from: `planBoundary`, `unauthorisedChanges`, the `plan-trespass` stop and
  `SESSION_STEP_FIELDS` / `PLAN_FROZEN_FIELDS` are deleted. A plan is read from
  `~/mc/programs/`, and nothing checks what a step session wrote into it; what
  stays at the door is `criteriaDoor`, which refuses the last step's pull
  request while a success criterion is not `met`.
