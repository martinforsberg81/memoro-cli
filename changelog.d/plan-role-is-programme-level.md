section: Changed

- **The `plan` role is written for a programme.** `canon/roles/plan.md` opened
  "You are the planning session for one workarea" and sent the session to read
  `../HANDOFF.md` and `../inbox/` — a project workarea's filing, which a
  planning session no longer has and never should have had. It now says what a
  programme is and what a project is, where the session stands
  (`~/mc/plan/<programme>/`, both repositories, not a workarea), and that the
  workarea a project eventually gets is the runner's to make: choosing the
  project's directory name is the whole of the planning session's part in it.
  What it reads instead is `docs/project/<programme>/` in each checkout, the
  open `Plan:` PRs in both repositories, the programme's rulings, and
  `~/mc/intake/proposals/` — where work nobody has planned yet arrives.
  The deliverable is a programme's worth of plans rather than one: the
  programme document when the programme is new or its shape changed, plus one
  `PLAN.json` per project that can start *against the code as it stands* — not
  every state the programme will ever pass through, because a state that
  depends on an earlier one finishing is written when that one has finished.
  Decision files are named where they now live,
  `~/mc/plan/<programme>/decisions/`, and the role carries the existing rule
  that a ruling is carried into the repository before its file is retired.
