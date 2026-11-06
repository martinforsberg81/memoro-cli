## `mc goal`

A goal is a directory, `~/mc/programs/<programme>/goals/<goal>/`: `GOAL.json`
(the goal, contract, out of scope, documents, and success criteria, each with a
check and a `met`) and `LOG.md` (one entry per session). A worktree per
repository on branch `goal/<goal>` is made at the goal's first use: the runner
makes it before the first session that needs it (a build, review, or plan
session on the goal), and `mc tidy` releases it when no session can use it. Its
branch stays, and the next use re-adds it as it was. `mc goal --help` is the
reference; `mc goal show <programme>/<goal>` renders one goal, each criterion
with ✓/✗ and its check, and each worktree's state.

- **Written by verbs.** Never edit GOAL.json by hand. `mc goal set <p>/<g>
  title|goal|contract|out-of-scope --text "…"` (a blank line parts paragraphs),
  `mc goal document add <p>/<g> --label "…" --path "…"`, `mc goal criterion add
  <p>/<g> --criterion "…" --check "…"`. A session that ran a criterion's check
  and saw it hold records `mc goal criterion met [<p>/<g>] <n>`; `unmet` takes
  it back. Every write is validated; an invalid one is refused and not written.

- **Entries.** A session writes to its goal with `mc goal log --done "…"
  --comment "…" --next "…" [--stage …] [--status …]`; `MC_GOAL` names the
  goal. The next session starts from the last entry's `Next`. Text with
  backticks, `$( )` or quotes goes through `--done-file`, `--comment-file` or
  `--next-file` (`-` is stdin) instead of its inline flag: read verbatim, never
  both. Pass a quoted heredoc, so the shell leaves the text alone:
  ```sh
  mc goal log --done-file - <<'EOF'
  gate: `mc gate tests/mc/commands/goal.test.js` — green, $(date) as run
  EOF
  mc goal show <programme>/<goal>
  ```
  Read the entry back with `mc goal show` before moving the stage.
- **Stage and status.** A goal is `<stage> · <status>`: stage `plan → build
  → review → finish → merge → done` (or `dropped`), status `ready`, `blocked` or `Martin`. The stage only moves forward, each stage with one owner: a plan
  session writes it in `plan` and moves it to `build`; a build session moves
  it to `review` or sets `blocked`; a review session moves it to `merge`
  (`mc goal stage merge` sends all registered PRs to merge) or `finish` (with
  REVIEW.md); a plan session finishes it to `merge`; the merger sets `done`.
  `blocked`, in any stage, wakes plan to resolve the obstacle and retry.
  `Martin` waits on Martin and wakes nothing; `mc goal martin --reason "…"`
  records his question and the recommendation. `mc goal ready` keeps the stage.
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
  In `finish` and a red `merge`, the plan session owns technical decisions,
  brief/check repairs and bounded test commissioning within the promised
  outcome and Martin's explicit constraints. Missing planning detail alone
  does not require a person; acceptance and gate requirements still hold.
  In a headless session, follow the assigned role; a build or review that
  cannot resolve its obstacle sets blocked for plan. If plan needs a person's decision or an act outside that role's authority, set
  `mc goal martin --reason "…"` in its current stage and record exactly what is needed.
- **Refused.** mc refuses every session a backward move, naming both stages
  — only a person (`MC_TOOL=person`, or none) moves a stage back, and that is
  logged. It refuses `done` and `dropped` from a build or review session,
  any move but `build → review` from a build session, any but `review →
  merge|finish` from a review, `finish` without REVIEW.md, and `review` from
  a session other than plan while a criterion is not met. The runner starts no
  session on `plan · ready`, on `Martin`, or a build session on a goal with no criterion, and the
  merger does not land a goal with one unmet.
- **New and gone.** `mc goal new <programme>/<goal> --repo … --class
  fast|large --title "…" [--stage plan|build]` makes one: GOAL.json and
  LOG.md, and no worktree (the runner makes it at first use). `mc goal drop
  --reason "…"` lets one go without landing.
