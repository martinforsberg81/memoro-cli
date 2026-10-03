section: Fixed

- **`mc deploy` records the commit it shipped.** It fast-forwards the deploy
  worktree to `origin/main` as it is at the yes, which can be later than the sha
  the question showed — the runner lands and fetches continuously — but the row
  in `deploys.tsv` and the *fast-forwarded main … to* line both named the
  question's sha (2026-09-14, 2026-09-19). Now the worktree's `HEAD` after the
  fast-forward is what the row records, the script is handed and the line names,
  and when it moved since the question one line says *main moved to `<y>` since
  the question; deploying `<y>`*. The digest compares `/api/version` with the
  row's `live_commit` before its `sha`, so it no longer calls a deploy that
  verified itself *somebody deployed another way*.
