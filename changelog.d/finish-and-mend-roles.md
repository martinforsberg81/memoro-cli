section: Changed

- **Plan is interactive only; finish and mend are the runner's roles after
  review.** Headless plan did not work as one overarching role the runner
  woke at different moments (Martin, 2026-11-07). The runner never starts a
  session with `MC_ROLE=plan` now. Two roles with one job each take what it
  did on a goal: a **finish session** (`canon/roles/finish-session.md`,
  `MC_ROLE=finish-session`) takes a goal in `finish · ready`, fixes what
  review found, gates, publishes and sends it to merge; a **mend session**
  (`canon/roles/mend-session.md`, `MC_ROLE=mend-session`) takes every
  `blocked` goal, in any stage, and every red or blocked merge, resolves the
  obstacle and retries the stage (`mc goal ready`; in merge `mc goal stage
  merge` requeues). Neither changes the goal's text, contract or product
  scope: `mc goal criterion set|remove` refuse them as they refuse build and
  review, and a change to the goal is `mc goal martin`. The recovery guards
  carry over: a mend left blocked becomes `Martin`, three mends in one stage
  become `Martin`, a person's `ready` restarts the budget. Both run in the
  goal's worktree on the goal's class routing, like a build; the runner no
  longer makes `plan/<programme>` checkouts. `refusedMove` has rows for each
  (`FINISH_ROLE`, `MEND_ROLE` in `goals.js`), `goalSession` answers `finish`
  and `mend`, the page and `runs.tsv` know the kinds (`finish` blue, `mend`
  yellow), and every role text, the goal verb file, `mc goal --help`,
  `mc run --help` and `docs/technical/mc-goals.md`, `mc-run.md`,
  `mc-roles.md` say who takes what.
- **Programme turns are disabled.** `no_goals_remaining` and
  `daily_proposals` start no session: their instructions were too poor to
  use, and the foundation has to work first (Martin, 2026-11-07). Disabled,
  not redesigned: `src/mc/programme-plan.js` and its receipts under
  `runner/programme-plan/` are gone with their tests; a later goal may bring
  programme planning back with new instructions. `MC_PLAN_REASON` is gone
  with them.
