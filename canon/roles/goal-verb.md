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
  --comment "…" --next "…" [--stage …] [--status …]`; `MC_GOAL` names the
  goal. The next session starts from the last entry's `Next`.
- **Stage and status.** A goal is `<stage> · <status>`: stage `plan → build
  → review → finish → merging → done` (or `dropped`), status `ready` or
  `blocked`. The stage only moves forward, each stage with one owner: a plan
  session writes it in `plan` and moves it to `build`; a build session moves
  it to `review` or sets `blocked`; a review session moves it to `merging`
  (`mc goal stage merging` queues the head it judged) or `finish` (with
  REVIEW.md); a plan session finishes it to `merging`; the merger sets `done`.
  `blocked`, in any stage, waits on a person; `mc goal ready` keeps the stage.
- **Refused.** mc refuses every session a backward move, naming both stages
  — only a person (`MC_TOOL=person`, or none) moves a stage back, and that is
  logged. It refuses `done` and `dropped` from a build or review session,
  any move but `build → review` from a build session, any but `review →
  merging|finish` from a review, `finish` without REVIEW.md, and `review` from
  a session other than plan while a criterion is not met. The runner starts no
  session on `plan`, on `blocked`, or on a goal with no criterion, and the
  merger does not land a goal with one unmet.
- **New and gone.** `mc goal new <programme>/<goal> --repo … --class
  fast|large --title "…" [--stage plan|build]` makes one; `mc goal drop
  --reason "…"` lets one go without landing.
