section: Fixed

- **The plan door compares against the plan the branch started from.**
  `planBoundary` read its `before` plan from `origin/<base>` as it stands, so
  a planning commit that landed on main while a step ran made main differ
  from the head at steps the session never touched, and the door reported
  them as the session's (memoro #11603, 2026-09-08: `steps[30]: changed by
  the session that ran step 7`). `before` is now the plan at `git merge-base
  origin/<base> origin/<head>`; `origin/<base>` is the fallback only when the
  merge base cannot be read or the plan did not exist there.
