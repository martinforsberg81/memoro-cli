## `mc goal`

A goal is a directory, `~/mc/programs/<programme>/goals/<goal>/`: `GOAL.md`
(the goal, its criteria, out of scope), `LOG.md` (one entry per session), and
a worktree per repository on branch `goal/<goal>`. `mc goal --help` is the
reference; `mc goal show <programme>/<goal>` is one goal's state.

- **Entries.** A session writes to its goal with `mc goal log --done "…"
  --comment "…" --next "…" [--status …]`; `MC_GOAL` names the goal. The next
  session starts from the last entry's `Nästa`.
- **Statuses.** A build session ends in `review` (the criteria hold and the
  pull request carries it all), `blocked` (a question) or `open`. A review
  session keeps `review` on green and sets `blocked` on red. A plan session
  sets any status. The merger sets `done` when every pull request the goal
  carries has landed.
- **Refused.** mc refuses `done` and `dropped` from a build or review
  session, and `open` from a review session.
- **New and gone.** `mc goal new <programme>/<goal> --repo … --class
  fast|large --title "…"` makes one; `mc goal drop --reason "…"` lets one go
  without landing.
