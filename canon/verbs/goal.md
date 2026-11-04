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
  → review → finish → merge → done` (or `dropped`), status `ready` or
  `blocked`. The stage only moves forward, each stage with one owner: a plan
  session writes it in `plan` and moves it to `build`; a build session moves
  it to `review` or sets `blocked`; a review session moves it to `merge`
  (`mc goal stage merge` sends all registered PRs to merge) or `finish` (with
  REVIEW.md); a plan session finishes it to `merge`; the merger sets `done`.
  `blocked`, in any stage, waits on a person; `mc goal ready` keeps the stage.
- **Taking over a blocked goal.** In an interactive session, always read the
  goal's current stage, its blocking reason in LOG.md (and REVIEW.md when
  present), and the instructions for that stage before acting: `plan` and
  `finish` use [plan-session](../roles/plan-session.md), `build` uses
  [build-session](../roles/build-session.md), and `review` uses
  [review-session](../roles/review-session.md). For `merge`, read
  [publish-and-merge](../tasks/publish-and-merge.md). Do this on every takeover,
  even in an existing conversation. Resolve the blocker yourself within the
  current stage, including implementation, checks and publication when needed;
  then follow that stage's normal transition. Merely clearing `blocked` or
  moving the goal back to hand the work to the runner does not resolve it.
  In a headless session, follow the assigned role; if resolving the blocker
  requires a person's decision or an act outside that role's authority, leave
  the goal blocked in its current stage and record exactly what is needed.
- **Refused.** mc refuses every session a backward move, naming both stages
  — only a person (`MC_TOOL=person`, or none) moves a stage back, and that is
  logged. It refuses `done` and `dropped` from a build or review session,
  any move but `build → review` from a build session, any but `review →
  merge|finish` from a review, `finish` without REVIEW.md, and `review` from
  a session other than plan while a criterion is not met. The runner starts no
  session on `plan`, on `blocked`, or on a goal with no criterion, and the
  merger does not land a goal with one unmet.
- **New and gone.** `mc goal new <programme>/<goal> --repo … --class
  fast|large --title "…" [--stage plan|build]` makes one; `mc goal drop
  --reason "…"` lets one go without landing.
