## `mc goal`

A goal is a directory, `~/mc/programs/<programme>/goals/<goal>/`: `GOAL.json`
(the goal, contract, out of scope, documents, and success criteria, each with a
check and a `met`) and `LOG.md` (one entry per session). A worktree per
repository on branch `goal/<goal>` is made at the goal's first use: the runner
makes it before the first session on the goal (a plan, build, review, finish or mend
session), and `mc tidy` releases it when no session can use it. Its
branch stays, and the next use re-adds it as it was. `mc goal --help` is the
reference; `mc goal show <programme>/<goal>` renders one goal, each criterion
with ✓/✗ and its check, and each worktree's state.

- **Written by verbs.** Never edit GOAL.json by hand. `mc goal set <p>/<g>
  title|goal|contract|out-of-scope --text "…"` (a blank line parts paragraphs),
  `mc goal document add <p>/<g> --label "…" --path "…"`, `mc goal criterion add
  <p>/<g> --criterion "…" --check "…"`. A session that ran a criterion's check
  and saw it hold records `mc goal criterion met [<p>/<g>] <n>`; `unmet` takes
  it back. Every write is validated; an invalid one is refused and not written.
  `mc goal criterion set [<p>/<g>] <n> [--criterion "…"] [--check "…"]`
  rewrites a criterion's text or check and leaves it unmet, logged with the old
  and new text; a goal session (build, review, finish, mend) cannot, but interactive Martin may.
  `mc goal criterion remove [<p>/<g>] <n> --reason "…"` takes criterion `n`
  out, the later ones move up one number, and the removed text, check, met state
  and reason are logged; a goal session cannot, but interactive Martin may.

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
- **Stage and status.** A goal is `<stage> · <status>`: stage `draft → build
  → review → finish → merge → done` (or `dropped`), status `ready`, `blocked` or `Martin`. The stage only moves forward, each stage with one owner: the
  plan session writes it in `draft` and moves it to `build`; a build
  session moves it to `review` or may set Martin; a review session moves it to
  `merge` (`mc goal stage merge` sends all registered PRs to merge) or `finish`
  (with REVIEW.md); a finish session moves `finish` to `merge`; the merger sets
  `done`. Legacy `blocked` outside merge is reconciled to Martin with prior evidence retained; only a merge failure wakes mend, which repairs and returns merge to ready. The first two failed merges run mend; the third sets Martin. `Martin` waits on Martin and wakes nothing. `mc goal martin` asks jev once; session callers require `--kind technical|product`, while a person may omit it:
  `mc goal martin --kind technical|product --reason "<the question>" --option "<key>: <text>"
  --option "<key>: <text>" --recommend <key> [--evidence "…"] [--document
  <repo>/<path>] [--reserved <act>]` — 2 to 4 options, keys
  `^[a-z][a-z0-9_]{0,31}$`, the recommendation one of them. A call without them is refused with a return
  instruction (exit 2, nothing written): fix it and call again. When jev
  settles the question it prints `mc: jev answered <key> … — continue with:
  <option text>`, the status stays, and the session continues with that answer.
  Every unsettled technical call, whatever jev reads or if jev is unavailable,
  logs and continues with the session's recommendation, without changing
  stage/status. Unresolved product calls reach Martin; a goal-bound product escalation
  exits 1. `mc decisions` lists answered and
  session-decided records read-only. A reserved
  act (`--reserved deploy|production-data|credentials|admin`) and a person's
  call never go to jev. Interactive Martin may use `mc ask` for a newly
  synthesized question after investigating the standards; do not repeat jev for
  the same recorded live question. `mc goal log --status Martin` is refused: use
  `mc goal martin` (docs/technical/mc-jev.md). `mc goal ready` keeps the stage.
- **Taking over a goal interactively.** Always read the goal's current stage,
  its last entry in LOG.md (the blocking reason, or Martin's question, and
  REVIEW.md when present), and the instructions for that stage before acting:
  `draft` uses [plan-session](../roles/plan-session.md), `build` uses
  [build-session](../roles/build-session.md), `review` uses
  [review-session](../roles/review-session.md), `finish` uses
  [finish-session](../roles/finish-session.md), and a red
  `merge` (a merge failure, the only case mend takes) uses [mend-session](../roles/mend-session.md) with
  [publish-and-merge](../tasks/publish-and-merge.md). Do this on every
  takeover, even in an existing conversation. Resolve the blocker yourself
  within the current stage, including implementation, checks and publication
  when needed; then follow that stage's normal transition. Merely clearing
  `blocked` or moving the goal back to hand the work to the runner does not
  resolve it. A goal in `Martin` carries the source question for Martin's
  interactive decision desk. That role investigates it against technical and
  programme design, resolves settled details, records actual decisions
  canonically, reconciles the goal, then finishes or explicitly returns/hands it off.
  In a headless session, follow the assigned role: build/review/finish resolve their own acceptance obstacles; only merge failure uses mend. An actual choice uses goal-bound `mc ask` (or compatible `mc goal martin`) with its kind. An unsettled technical call continues on the session's recommendation; product choices and reserved acts reach Martin. Continue if jev answers. A product choice must name the missing rule and proposed technical amendment. The compatible call is `mc goal martin --kind technical|product --reason "…" --option "<key>: <text>"… --recommend
  <key>` in its current stage with exactly what is needed; when jev answers, it
  continues with jev's answer instead of ending.
- **Refused.** mc refuses every session except the interactive Martin role a backward move, naming both stages
  — a person (`MC_TOOL=person`, or none) and interactive Martin may move a stage back, with truthful attribution. It refuses `done` from every session but plan, and also refuses Martin's administrative `done`; `dropped` is allowed for plan or interactive Martin, any
  move but `build → review` from a build session, any but `review →
  merge|finish` from a review, `finish` without REVIEW.md, any but `finish →
  merge` from a finish session, every stage move from a mend session, and
  `review` from a session other than plan while a criterion is not met. The
  runner starts no delivery session on `draft · ready`, no session on `Martin`, or a build session
  on a goal with no criterion, and the merger does not land a goal with one
  unmet.
- **New and gone.** `mc goal new <programme>/<goal> --repo … --class
  fast|large --title "…" [--stage draft|build]` makes one: GOAL.json and
  LOG.md, and no worktree (the runner makes it at first use). `mc goal drop
  --reason "…"` abandons delivery; only plan, interactive Martin or a person may drop. The stage is
  persisted before cleanup. Exclusive open PRs are closed, their merge rows
  cancelled, and the goal is archived immediately when safe. Shared PRs stay
  open and queued. Failed or unsafe cleanup stays visible and retries through
  the runner without starting a mend/build session.

- **Next draft planning.** With at least one draft and all programme goals in
  draft, done or dropped, the runner may plan its next draft (lowest phase,
  oldest creation time, name). Unreadable goal data or a first draft waiting
  on Martin prevents that launch. One session completes only that draft into
  build using its goal worktrees. Interactive mc plan remains the person's
  entrance; empty programmes and proposals alone start no plan turn.
