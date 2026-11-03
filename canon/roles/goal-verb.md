## `mc goal`

A goal is a directory, `~/mc/programs/<programme>/goals/<goal>/`: `GOAL.json`
(the goal, contract, out of scope, documents, and success criteria, each with a
check and a `met`), `LOG.md` (one entry per session), and a worktree per
repository on branch `goal/<goal>`. `mc goal --help` is the reference; `mc goal
show <programme>/<goal>` renders one goal, each criterion with ✓/✗ and its check.

- **Written by verbs.** Never edit GOAL.json by hand. `mc goal set <p>/<g>
  title|goal|contract|out-of-scope --text "…"` (a blank line parts paragraphs),
  `mc goal document add <p>/<g> --label "…" --path "…"`, `mc goal criterion add
  <p>/<g> --criterion "…" --check "…"`. A session that ran a criterion's check
  and saw it hold records `mc goal criterion met [<p>/<g>] <n>`; `unmet` takes
  it back. Every write is validated; an invalid one is refused and not written.

- **Entries.** A session writes to its goal with `mc goal log --done "…"
  --comment "…" --next "…" [--status …]`; `MC_GOAL` names the goal. The next
  session starts from the last entry's `Next`.
- **Statuses.** A build session ends in `review` (the criteria hold and the
  pull request carries it all), `blocked` (a question) or `open`. A review
  session keeps `review` on green and sets `blocked` on red. A plan session
  sets any status. The merger sets `done` when every pull request the goal
  carries has landed.
- **Refused.** mc refuses `done` and `dropped` from a build or review
  session, `open` from a review session, and `review` from a session other
  than plan while a criterion is not met. The runner starts no session on a
  goal with no criterion, and the merger does not land a goal with one unmet.
- **New and gone.** `mc goal new <programme>/<goal> --repo … --class
  fast|large --title "…"` makes one; `mc goal drop --reason "…"` lets one go
  without landing.
