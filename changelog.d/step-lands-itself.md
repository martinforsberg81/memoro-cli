section: Changed

- **The step session lands its own pull request** (ruling 21). The step role
  and prompt end in `mc merge <repo> <pr>` run by the session, with `done`
  and `pr` in the pull request beside the code; a red comes back to the same
  session, which fixes it and runs `mc merge` again; giving up is
  `mc step failed --reason "…"`. The runner lands nothing of a step session's
  any more and reads the outcome off the register: `success,merged` when
  `mc merge` wrote `done`, `<exit>,failed` when the session gave up or ended
  with its pull request unlanded.
- **`mc merge` waits for its turn, checks the plan boundary at the door, and
  writes the register.** A gate held by another round is polled for up to
  eight minutes, then `run this again` and exit 3; nothing is queued for a
  merge lane. A step's pull request whose plan changed outside the step's own
  fields stops at `plan-trespass` before any suite. On green the step is
  `done` in the register and the session that called is ended; on red the
  attempt is counted and the reason kept.
