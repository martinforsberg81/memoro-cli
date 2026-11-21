## `mc goal`

A goal is a directory, `~/mc/programs/<programme>/goals/<goal>/`: `GOAL.json`
(the goal's numbered parts, its documents, and success criteria, each with a
check and a `met`) and `LOG.md` (one entry per session). A worktree per
repository on branch `goal/<goal>` is made at the goal's first use: the runner
makes it before the first session on the goal (a plan, build, review or
mend session), and `mc tidy` releases it when no session can use it. Its branch
stays, and the next use re-adds it as it was. `mc goal --help` is the reference;
`mc goal show <programme>/<goal>` renders one goal, each criterion with ✓/✗ and
its check, and each worktree's state.

- **Written by verbs.** Never edit GOAL.json by hand. A goal has numbered
  parts: `mc goal set <p>/<g> title|aim|outcome|latitude|protection --text "…"`
  (a blank line parts paragraphs), `mc goal item add|set|remove <p>/<g> problem|premise|decision|change|preserve|risk|out-of-scope …`
  (it prints the item's id, B, P, D, C, V, R or X and a number, never given
  twice), `mc goal obligation set|remove <p>/<g> <area> …` (an area is `<repo>/<id>` where the repository declares areas; `mc goal areas <repo>|<p>/<g> [--at <rev>]` lists them),
  `mc goal document add <p>/<g> --label "…" --path "…"` (a goal cut from a
  programme names its part by adding the programme's README.md with the label
  `Part <n>`, several as `Part 1; Part 2`), `mc goal criterion add
  <p>/<g> --criterion "…" --check "…"`, and `--evidence "…"`
  on `criterion add|set`. A build, review or mend
  session cannot write the parts. A session that ran a criterion's check
  at a committed head and saw it hold records `mc goal criterion met [<p>/<g>] <n>
  --evidence "…"` (or `--evidence-file <path|->`); `unmet` takes it back. A preserve
  item or touched obligation is recorded with `mc goal evidence [<p>/<g>] <id> --text "…"`
  (or `--file <path|->`). The records are in `.evidence.json` in the goal's directory and
  are read with `mc goal show`. Every write is validated; an invalid one is refused and not written.
  `mc goal criterion set [<p>/<g>] <n> [--criterion "…"] [--check "…"]`
  rewrites a criterion's text or check and leaves it unmet, logged with the old
  and new text; a goal session (build, review, mend) cannot, but interactive Martin or unattended decision may.
  `mc goal criterion remove [<p>/<g>] <n> --reason "…"` takes criterion `n`
  out, the later ones move up one number, and the removed text, check, met state
  and reason are logged; a goal session cannot, but interactive Martin or unattended decision may.

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
  → review → merge → done` (or `dropped`), status `ready`, `blocked` or `Martin`. The stage only moves forward, but for a review's move from review to build, each stage with one owner: the
  plan session writes it in `draft` and moves it to `build`; a build
  session moves it to `review` or may set Martin; a review session moves it to
  `merge` (`mc goal stage merge` sends all registered PRs to merge, when every
  line of REVIEW.md is OK) or back to `build` (`mc goal stage build`, when a line
  is NOT OK; a repair build session takes it). After two automatic repairs a
  failed verdict holds the goal for the decision pass. The merger sets
  `done`. Legacy `blocked` outside merge is reconciled to Martin with prior evidence retained; only a merge failure wakes mend, which repairs and returns merge to ready. The first two failed merges run mend; the third sets Martin. `Martin` waits on Martin and wakes nothing, and only a reserved act (`mc ask --reserved <act>`) or a reader's finding that the goal is wrong (`mc goal defect`) sets it. `mc goal martin` is gone: it exits 2 and prints the `mc ask` call to make. A question goes through `mc ask [<programme>/<goal>] --reason "<the question>" --option "<key>: <text>" --option "<key>: <text>" --recommend <key> [--evidence "…"] [--document <repo>/<path>] [--reserved <act>]` — 2 to 4 options, keys `^[a-z][a-z0-9_]{0,31}$`, the recommendation one of them. A call without them is refused with a return instruction (exit 2, nothing written): fix it and call again. jev reads it first; when jev does not settle it a fresh read-only reader answers inside the same call, and the call prints which of four answers it is (continue with an option, a goal defect, a text of Martin's that would change, or unread), so the session continues without a wait on Martin. What each answer means is in [asking-martin](../tasks/asking-martin.md). `mc decisions` lists the answers read-only, with who answered. A call with `--reserved deploy|production-data|credentials|admin` never goes to jev or a reader. `mc goal log --status Martin` is refused: use `mc ask` (docs/technical/mc-jev.md). `mc goal ready` keeps the stage.
- **A wrong goal.** `mc goal defect [<programme>/<goal>] --part "<the part or
  criterion that is wrong>" --found "<what is wrong, with the file and line or
  the command and output>" [--evidence "…"] [--next "…"]` is how a build,
  review session in its own stage reports that the goal itself is
  wrong: one entry whose first line is `goal defect: <part> — <found>`,
  status `Martin`, no options, no jev; the session's last act. Without `--part`
  or `--found` it exits 2 and writes nothing; a finished goal, a stage that is
  not the session's own, and a mend session are refused. The desk labels the
  item by that first line (sort `technical`); it amends the goal with the verbs
  and `mc goal ready`. A build that makes no progress three sessions in a row,
  or that has had five build sessions since it began building or was last set
  ready after a stop, is stopped by the runner with one `Martin` entry whose
  comment begins `no progress:` (sort `mechanical`).
- **Taking over a goal interactively.** Always read the goal's current stage,
  its last entry in LOG.md (the blocking reason, or Martin's question, and
  REVIEW.md when present), and the instructions for that stage before acting:
  `draft` uses [plan-session](../roles/plan-session.md), `build` uses
  [build-session](../roles/build-session.md), `review` uses
  [review-session](../roles/review-session.md), and a red
  `merge` (a merge failure, the only case mend takes) uses [mend-session](../roles/mend-session.md) with
  [publish-and-merge](../tasks/publish-and-merge.md). Do this on every
  takeover, even in an existing conversation. Hold the goal first with
  `mc goal hold --reason "…"`: the runner starts no session on a held goal, and
  `mc goal release` hands it back with the worktree's state in the log.
  Resolve the blocker yourself
  within the current stage, including implementation, checks and publication
  when needed; then follow that stage's normal transition. Merely clearing
  `blocked` or moving the goal back to hand the work to the runner does not
  resolve it. A goal in `Martin` carries the source question for Martin's
  interactive decision desk. That role investigates it against technical and
  programme design, resolves settled details, records actual decisions
  canonically, reconciles the goal, then finishes or explicitly returns/hands it off.
  In a headless session, follow the assigned role: build/review resolve their own acceptance obstacles and report a wrong goal with `mc goal defect`; only merge failure uses mend. An actual choice uses goal-bound `mc ask` in its current stage with exactly what is needed (the one way to ask, `mc goal martin` being gone); the call answers inside itself and the session continues with the answer. What reaches Martin is in [asking-martin](../tasks/asking-martin.md).
- **Refused.** mc refuses every session except the interactive Martin and unattended decision roles a backward move, naming both stages
  — a person (`MC_TOOL=person`, or none) and interactive Martin or decision may move a stage back, with truthful attribution. It refuses `done` from every session but plan, and also refuses Martin's administrative `done`; `dropped` is allowed for plan or interactive Martin or decision, any
  move but `build → review` from a build session, any but `review →
  merge|build` from a review, `merge` or `build` from a review without a REVIEW.md in its fixed form,
  `finish` from everyone (a name kept for old records), every stage move from a mend session, and
  `review` from a session other than plan while a criterion is not met. The
  runner starts no delivery session on `draft · ready`, no session on `Martin`, or a build session
  on a goal with no criterion, and the merger does not land a goal with one
  unmet.
- **Programme readers.** `mc programs review <programme>` commissions an
  advisory document reading for interactive Martin. The assigned repair
  author may instead commission a reading of a repair-owned draft's fixed
  inputs; only a valid, current review receipt with no unresolved findings
  authorises repair release. The reader writes only PROGRAMME-REVIEW.md
  at the path supplied by the call and cannot mutate goals.
- **Programme state.** `new` refuses draft records (exit 1), naming
  `mc programs show <programme>`. Headless creation without a record refuses
  (exit 1): a goal there is made at the desk. Both happen before fetch/write.
  An ordinary programme Martin has set ready enables goal new. For repair,
  the planner may create goals while reconciling the current release, or
  interactive Martin may create them in a taken-over draft.

- **New and gone.** `mc goal new <programme>/<goal> --repo … --title "…"` makes one, always in draft: GOAL.json and
  LOG.md, and no worktree (the runner makes it at first use). A draft made without `MC_HEADLESS=1` is held from creation: `mc goal stage` to `build` frees it, and `mc goal release` hands the draft to headless planning. `mc goal drop
  --reason "…"` abandons delivery; only plan, interactive Martin, decision or a person may drop. The stage is
  persisted before cleanup. Exclusive open PRs are closed, their merge rows
  cancelled, and the goal is archived immediately when safe. Shared PRs stay
  open and queued. Failed or unsafe cleanup stays visible and retries through
  the runner without starting a mend/build session.

- **Next draft planning.** With at least one draft and all programme goals in
  draft, done or dropped, the runner may plan its next draft (lowest phase,
  oldest creation time, name). Unreadable goal data, or a first draft that waits on Martin or is held, prevents that launch. One session completes only that draft into
  build using its goal worktrees. Interactive mc plan remains the person's
  entrance; an empty programme without a valid open record, and proposals alone, start no plan turn.
  A recorded open programme signed and not yet cut gets the programme planning turn
  (`mc-run.md#Programme planning turn`).
  In a programme whose record states its phases each phase offers its oldest
  draft when it is open, none of its goals is in build, review or merge, and the
  draft is ready, not held and not decision-claimed; the lowest phase that offers
  one gives the next draft, and one plan session runs in the programme at a time.

The unattended `decision` desk role has Martin's goal mutation authority,
including backward moves, ready, goal/criterion rewrites and dropping, but
never administrative done. It logs `by decision`, runs criteria before marking
them met, and preserves gate, review, publication and merger evidence. The
interactive Martin role remains refused with `MC_HEADLESS=1`. The headless
refusals of reserved acts still hold for decision; what waits on one becomes a
Swedish brief rather than an act ([mc-martin.md](../../docs/technical/mc-martin.md)).
