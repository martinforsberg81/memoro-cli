section: Changed

- **`mc status <name>` is now the project of that name, not a session.** It
  prints what the project's PLAN.md says right now — read from the workarea's
  working copy when there is one, since a step is written and pushed before it
  is merged, and marked when that copy differs from origin/main — the
  decisions that belong to it and whether each is answered, its last three
  runner steps from `runs.tsv`, and the open PR on its branch. No model, no
  writes; `--json` for the same as one object and `--offline` to skip `git
  fetch` and `gh`. The pre-V1 session behind a name still answers, now as `mc
  status --sessions <name>`.
