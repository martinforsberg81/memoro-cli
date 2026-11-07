# mc goals

**Status:** current · 2026-11-03 · derived from `src/mc/goals.js`,
`src/mc/criteria.js`, `src/mc/goal-convert.js`, `src/mc/project-convert.js`, `src/mc/commands/goal.js` (`refusedMove`,
`queueGoal`), `src/mc/run.js` (`goalPass`, `runGoal`, `goalWork`,
`reviewRoute`, `afterReview`, `afterPlan`, `goalWithoutWord`, `convertAfter`,
`planRoute`), `src/mc/goal-archive.js`, `src/mc/merger.js` (`landJob`, `tellGoal`),
`src/mc/hooks.js` (`reviewStopDecision`), `canon/roles/build-session.md`
(its `goal` part), `canon/roles/review-session.md` (its `goal` part),
`canon/roles/plan-session.md` and `canon/roles/goal-verb.md`

A goal is mc's one unit of work, two files and a worktree: `GOAL.json`, the brief as
data, and `LOG.md`. It has no steps, no register and no owner. A build session
does the work, records each criterion it has checked as met, and publishes its
pull request; a review session on another model runs the checks and decides;
OK queues it for the merger, not OK sends it to a plan session that finishes
it; the goal is `done` when it lands, and it lands only with every criterion
met.

A goal has two fields where it had one status (Martin, 2026-11-03: *"Status
måste innehålla även processen så att den inte går tillbaka."* *"Det kan
aldrig gå bakåt i ordningen."*): its **stage**, where in the process it is,
which only moves forward, and its **status**, whether that stage can run now.
A goal passes each stage once, so the sessions a goal can start are bounded:
planning, builds while they make progress, reviews and finish, then merge.
Blocked stages receive planning recovery with a bounded retry budget.

```
stage:  plan → build → review → finish → merge → done      (and dropped, from any)
status: ready | blocked | Martin

plan     ── a plan session moves it ──────────────────────────▶ build
build    ── build session: done with the task ────────────────▶ review
build    ── build session: cannot solve it ───────────────────▶ build · blocked
build    ── three sessions without a word (runner) ───────────▶ finish
review   ── review: OK, mc goal stage merge (queues its head) ▶ merge
review   ── review: not OK, REVIEW.md, mc goal stage finish ──▶ finish
review   ── no open pull request (runner) ────────────────────▶ finish
review   ── the review died (runner) ─────────────────────────▶ review · ready, reviewed again
review   ── a second review died (runner) ────────────────────▶ review · blocked
finish   ── plan session: fixed, published ───────────────────▶ merge
finish   ── plan session ended still in finish (runner) ──────▶ finish · blocked
merge  ── merger landed ────────────────────────────────────▶ done
merge  ── merger red, or the head moved ────────────────────▶ merge · blocked, plan recovery
any      ── blocked wakes plan; Martin waits; ready keeps the stage ─▶ the same stage
any      ── only a person moves a stage backward, logged ─────▶ an earlier stage
```

## Layout

```
~/mc/programs/<programme>/goals/<goal>/GOAL.json  the brief, its criteria, its stage and status
~/mc/programs/<programme>/goals/<goal>/REVIEW.md  what a review that sent it to finish found, for the finish session
~/mc/programs/<programme>/goals/<goal>/LOG.md     one entry per session, newest last
~/mc/programs/<programme>/goals/<goal>/<repo>/    a worktree on goal/<goal>, from origin/main
~/mc/programs/<programme>/goals/.archive/<goal>/  an archived goal (mc goal archive, or the runner 24 h after done or dropped), its worktrees gone
~/mc/programs/<programme>/goals/goal_log.md       one row per archived goal
```

One worktree per repository the goal names, made at the goal's first use: the
runner makes it before the first session on the goal that needs it (build,
review, or plan), and `mc goal new` makes none. `mc tidy` releases a checkout no
session can use; its branch stays, and the next use re-adds it on that branch.
Anyone may work in one: a person, a plan session, or the runner's build and
review sessions on the goal. `<programme>` must be a directory under
`~/mc/programs/`; `<programme>` and `<goal>` are lower-case letters, digits and
hyphens. mc keeps nothing else for a goal.

## GOAL.json

One JSON object, written only by the `mc goal` verbs (*The verbs*) and checked
by `validateGoal` (`goals.js`) at every write: an invalid GOAL.json is never
written, and a write that would make one is refused with the field named.

```json
{
  "schema": "mc-goal",
  "version": 1,
  "stage": "build",
  "status": "ready",
  "phase": 2,
  "repos": ["memoro-cli", "memoro"],
  "class": "fast",
  "created": "2026-11-01T20:00:00Z",
  "prs": ["memoro#14761", "memoro-cli#1238"],
  "title": "Title",
  "goal": ["A paragraph.", "Another."],
  "contract": ["What may not change without Martin."],
  "out_of_scope": ["What this goal does not do."],
  "success_criteria": [{ "criterion": "What must be true", "check": "How it is checked", "met": false }],
  "documents": [{ "label": "What the reader is sent to", "path": "docs/technical/mc-goals.md" }]
}
```

- `stage` — `plan`, `build`, `review`, `finish`, `merge`, `done` or
  `dropped` (*Stages*). A goal starts in `plan`, or `build` with `mc goal new
  --stage build`.
- `status` — `ready`, `blocked` (planning recovery), or `Martin` (waiting for Martin). An unknown stage or status is refused with
  its field named. A GOAL.json from before stages has one `status` (`open`,
  `review`, `blocked`, …) and no `stage`; it does not parse, and says `mc
  goal convert` gives it one (*Converting a status into a stage*).
- `phase` — a whole number from 1 (*Phases*). A GOAL.json without one is in
  phase 1; `renderGoal` always writes it.
- `repos` — repository names in order. The first is where a session starts,
  and the lane that serves it takes the goal.
- `class` — `fast` or `large`, routed through the model catalog (ruling 59).
- `created` — an ISO instant written by `mc goal new`, or null.
- `prs` — the pull requests that carry the goal's work, as `<repo>#<n>`.
  `mc publish` writes the one it opens or updates (*Done when its work has
  landed*), and `mc goal pr` names others.
- `goal`, `contract`, `out_of_scope` — arrays of paragraphs.
- `success_criteria` — `[{ criterion, check, met }]` (`validateCriteria` in
  `src/mc/criteria.js`): every criterion a `check`, `met` true or false, no other key, and at
  least one criterion. `mc goal new`'s skeleton has none yet, and parses as a
  draft: the runner starts no session on a goal in `build` with no criterion,
  and it cannot go to review.
- `documents` — `[{ label, path }]` (`validateDocuments`).

An unknown key, a wrong schema or version, or a bad field is a problem named
by its field; an `after` (from before phases) is named with `mc goal convert`,
which gives the goal its phase (*Phases*). A GOAL.json that does not parse is listed by `mc goal list` with
its problems, and the runner never starts it.

**Seen, not only stored.** `mc goal show` renders a goal as text
(`renderGoalText`): the title, then GOAL, CONTRACT, OUT OF SCOPE and DOCUMENTS,
then `CRITERIA <met>/<all>` with each criterion numbered, ✓ or ✗, and its
check. That text is the brief the runner gives a goal's build, review and plan
session, after the lines that say where the goal is (`goalPrompt`,
`goalReviewPrompt`, `goalPlanPrompt` in `run-plan.js`). `mc goal list` and the
goal rows on the page say `criteria <met>/<all>`; the page's is green when all
are met.

## LOG.md

Each session adds one entry, newest last:

```
## 2026-11-01T21:30Z · claude claude-haiku-5-5 · build · ready

Done: what the session did
Comment: what a reader should know
Next: what the next session should do
```

- The heading is `## <at> · <tool> [<model>] · <stage> · <status>[ · by <role>]`: `<at>` is UTC to the
  minute; `<tool>` is `MC_TOOL`, `person` or `runner`; `<model>` is `MC_MODEL`
  when set; `<stage> · <status>` is where the goal is after the entry. An entry
  written before stages has `· <status>` alone, and is read with no stage.
  `· by <role>` names the session that wrote it, from `MC_ROLE`: `build`, `review`,
  `plan`, `manager`, else the role's name before its `:`. A person's entry, or one
  with no `MC_ROLE`, has none; so does a runner's. It is not the stage: a build
  session that moves a goal to `review` writes `· review · ready · by build`.
- The labels are `Done:`, `Comment:` and `Next:`, in English like the rest of
  the goal. A log written before 2026-11-03 has `Gjort:`, `Kommentar:` and
  `Nästa:`; the parser reads those as the same fields, so no log is rewritten.
  A label's text runs on until the next label or heading, so a field may take
  several paragraphs.
- A heading that does not match the form is skipped with its lines.
- `mc goal new` writes the first entry: `plan · ready` (or `build · ready`), `Done: created`.
- A session count is every entry whose tool is neither `runner` nor `person`.
- The **last build entry** is the last entry a session wrote in `build`, or
  the one that moved the goal to `review` (`lastBuildEntry`); a review's own
  entry names `merge` or `finish`. Its `<tool> <model>` is the model a
  review may not run on.
- A review's entry is one line, naming the stage and the files it wrote.
  The merger writes `Done: landed #<pr> as <sha>`, or `Done: merger answered
  red on #<pr>` (`moved` for a head past the judged one, `redMergeText`).

## The verbs

Seventeen verbs: `stage` moves the stage; `blocked`, `ready`, `done` and
`drop` set one field each.

- **`new <p>/<g> --repo <r>[,<r>] --class fast|large --title "…" [--phase <n>] [--stage plan|build]`** — makes a
  goal, refused unless its flags are valid and its names are new. It is in
  stage `plan` (nothing happens to it there; the runner never takes it), or
  `build` with `--stage build`, and in phase `<n>`, 1 by default; a phase more than one past the programme's
  highest is refused (`phase 4 would leave a hole — mc's phases run to 2, so 3
  is the highest a goal may take`). Each
  repository is fetched first; then GOAL.json — a skeleton with the title and
  no criterion — LOG.md, and a worktree of each on
  `goal/<g>` from `origin/main` (or that branch as it stands, when it exists).
  **One branch, built to the end**: the goal is built on this branch, and
  whether `main` moves meanwhile is not the build's concern — the merger
  brings the candidate up to date when it lands it.
- **`set <p>/<g> title|goal|contract|out-of-scope --text "…"`** — replaces that
  field. A prose field takes a paragraph per block between blank lines, and an
  empty text clears it; an empty title is refused.
- **`document add <p>/<g> --label "…" --path "…"`** — appends a document.
- **`criterion add <p>/<g> --criterion "…" --check "…"`** — appends a criterion,
  not met. Both flags are required: a criterion without a check is refused.
- **`criterion met|unmet [<p>/<g>] <n>`** — records criterion `<n>` (1-based)
  as holding, after its check was run, or takes it back. A number the goal
  has no criterion for is refused.
- **`convert [<p>]`** — turns every goal of the programme (of every programme
  when none is named) still written as GOAL.md into GOAL.json (*Converting a
  GOAL.md*), then gives every goal still written with `after` its phase
  (*Converting after into phases*) and every goal written with one status its
  stage (*Converting a status into a stage*).
- **`from-project <p>/<project>`** — turns a live project into goals, once
  (*From a project*).
- **`phase [<p>/<g>] <n>`** — moves the goal to phase `<n>`, at most one past
  the highest of its programme's other goals, with an entry `Done: phase <n>`;
  then the programme's phases are renumbered (`renumberPhases`), so a phase
  the move left empty closes up and the line names each goal that moved.
- **`log [<p>/<g>] [--done "…"] [--comment "…"] [--next "…"] [--stage <s>] [--status ready|blocked|Martin]`** —
  appends one entry; at least one field is needed. `--stage` and `--status`
  also set them. The goal is `MC_GOAL`'s when none is named.
- **`stage [<p>/<g>] <stage> [--reason "…"]`** — moves the stage
  (`log --stage <stage> --comment <reason>`); a stage moved to is `ready`.
  `merge` records the review or plan session's decision and queues every
  registered PR, without head or criteria checks. A queue failure preserves
  the decision for retry and runner recovery. Existing `merging` records and
  log entries are read as `merge`; new writes use `merge`.
- **`blocked|martin|ready [<p>/<g>] [--reason "…"]`** — sets the status; the stage stays.
- **`done [<p>/<g>] [--reason "…"]`** — stage `done`, a person's (or plan's) act;
  the merger sets it when the pull request lands.
- **`drop [<p>/<g>] --reason "…"`** — lets a goal go without landing: stage
  `dropped`, never `done`; it is finished as a `done` goal is, so it holds no
  later phase back. The reason is required. Only a person or a plan session
  drops a goal.
- **`pr <p>/<g> <repo>#<n>…`** — the pull requests named carry the goal: each
  is added to `prs` once, with an entry `Done: carries <repo>#<n>`. For work
  published before `mc publish` wrote `prs`, or from where it could not tell
  the goal.
- **`archive <p>/<g>…`** or **`archive <p>`** (every done or dropped goal of the
  programme) — a finished goal leaves `mc goal list` and the page. Refused, by
  name and reason and with nothing touched, for a goal that is not `done` or
  `dropped`; whose worktree has
  uncommitted changes; with an open pull request on `goal/<g>` or in `prs`;
  and, for a dropped one, whose branch has commits no remote holds. Otherwise
  each worktree is removed with `git worktree remove` and the local branch
  `goal/<g>` deleted, the directory moves to `goals/.archive/<g>/` (a
  dot-directory, so no reader lists it), and `goals/goal_log.md` gets a row:
  date, goal, status, pull requests, the last `Done:`. Then the programme's
  phases are renumbered (*Phases*): when the goal was the last of the lowest
  phase, every goal left moves one phase down, and the line names each. The runner does the same
  by itself for a goal that has been `done` or `dropped` for 24 hours
  (`ARCHIVE_HOLD_MS`, in its chores),
  counted from the log entry that set the stage (`stageSince`). A refusal the runner gets is
  written once into the goal's LOG.md, as a runner entry, and not again at
  every pass. A programme is never archived by the runner.
- **A goal's branch is made when the goal can start.** A goal in a later phase
  got its branch at `new`, before the phases ahead of it landed. Before the
  runner starts its first build session (no build entry in its log yet), and
  when it goes to `build` by `stage build` or `log --stage build`, each
  worktree is fetched, and one whose branch has no commits past
  `origin/main` is moved to `origin/main` as it is now (`git reset --keep`) —
  that branch made again. A branch with commits of its own is never moved,
  nor one with uncommitted changes `--keep` will not carry; each repository
  says which (`remade from origin/main — it had no commits of its own, and
  main has 12 more`, `left as it is — 3 commits of its own`), and nothing
  here fails the move (`remakeUnbuiltBranches`, `goals.js`).
- **Forward only, each stage its owner** (`refusedMove`). A session is a
  caller with `MC_GOAL` set and `MC_TOOL` not `person`. No session moves a
  stage backward: `mc: a session does not move a goal back — merge → review;
  only a person does (mc goal stage <programme>/<goal> review, MC_TOOL=person)`,
  with nothing written. A person may, and the entry says `moved back from
  merge to review by a person`. A plan session (`MC_ROLE=plan`)
  makes any forward move and sets any status. A build session
  (`build-session:goal`) moves `build` to `review` or sets `blocked`, and is
  refused anything else — `done`, `dropped`, `ready`, another stage. A review
  session (`review-session:goal`) moves a goal in `review` to `merge` or
  `finish` and sets no status; `finish` is refused until `REVIEW.md` is in
  the goal's directory. A session other than plan is refused `review` while a
  criterion is not met, or while the goal has none: `mc: mc/g is not moved to
  review — criterion 2 is not met — run its check and record it with mc goal
  criterion met mc/g 2` (`unmetGoalWords`). The session decides when to merge.
- **`show <p>/<g>`** — a status line (`<p>/<g> · stage · status · phase <n> · repos · class ·
  criteria <met>/<all> · created …`, with `· prs …` when set), the goal as text (*Seen, not only stored*), the last three entries, and
  each worktree's changed files, commits past `origin/main` and last commit date.
- **`list [<p>]`** — each programme's goals under a line per phase,
  `<p> · phase <n> · in progress` for the phase the programme is in, `· done`
  for one before it and `· after phase <n-1>` for one after it; under it,
  indented, one line per goal: `programme/goal · repos · stage · status ·
  criteria <met>/<all> · n sessions · the last entry's Next` — `—` for a `done` or `dropped` goal,
  whose last next action is over. A goal waiting for Martin reads `<stage> · Martin,
  waits on a person` (`waitsOnPerson`); a goal in `build` with no criterion
  `build · ready, no criteria — not started`. A goal that
  does not parse has no phase and is listed last, with its problems.

## Converting a GOAL.md

Goals written before 2026-11-03 are a `GOAL.md`: front matter between `---`
lines, then Markdown. `mc goal convert [<programme>]` (`src/mc/goal-convert.js`,
the one reader of GOAL.md left) turns each one not under `goals/.archive/` into
GOAL.json and removes the GOAL.md:

- the front matter's `repos`, `class`, `created` and `prs` become
  fields, and its `status` a stage (*Converting a status into a stage*); the `# ` line is the title;
- `## Goal` is `goal`, `## Contract` is `contract` and `## Out of scope` is
  `out_of_scope`, a paragraph per block between blank lines;
- each top-level bullet or numbered item of `## Criteria` is a criterion, whose check is the
  text after its `*Check:*`, or the whole bullet when it has none;
- any other section is kept as paragraphs of `goal`, after its heading;
- a goal in `review` or `done` has every criterion `met: true` — a session has
  judged them — and any other `met: false`.

A GOAL.md whose front matter does not read, or one beside a GOAL.json, is
left as it is and named on stderr (exit 1). The plan session in `mc` runs the
conversion for every programme once, then rewrites the checks and translates
the Swedish prose by hand.

## From a project

Until 2026-11-03 mc had a second unit of work, the project: a `PLAN.json` of
steps under `~/mc/programs/<programme>/<project>/`, with its state in a
`STATE.json` beside it. A goal carries everything a plan did; a plan's steps
are goals in consecutive phases. `mc goal from-project <programme>/<project>`
(`src/mc/project-convert.js`, the one reader of PLAN.json and STATE.json left)
turns a live project into goals:

- one goal per step not `done` (STATE.json's status laid over the plan's),
  named `<project>-<n>` after the step's number. The first is in the phase its
  programme is in now (`currentPhase`; 1 when no goal of it is left to
  finish), and each after it one phase later, so the steps still run one after
  the other — and a later step waits on every goal of its programme in the
  phase before it, not only on its own project's (*Phases*); `mc goal phase`
  moves one;
- a step blocked on another project of the same programme goes one phase past
  that project's last goal, which must be converted first (until then the
  conversion is refused); on a project that is finished, or whose last goal
  is done or dropped, it waits on nothing. One blocked on a project converted
  in another programme is `build · blocked`, its first entry naming that goal:
  a phase waits only on its own programme's goals;
- the step's `title` is the goal's title, its `instruction` the goal, its
  `done_when` a criterion — the title, checked by `done_when`. The project's
  contract, out of scope and documents go to every goal, its success criteria
  to the last, `met` as STATE.json held them. `class` is the step's work class,
  or the plan's, or `large`;
- a `built` or `landing` step with a pull request is a goal in `review ·
  ready` carrying it, its criterion met; a `blocked` step is `build · blocked`,
  its first LOG.md entry the blocker; any other is `build · ready`. The first
  entry says the step and the phase, `Done: converted from project <p>/<project>,
  step <n>, phase <m>`;
- a step with a branch of its own in STATE.json has its goal's worktree on
  that branch — the local one, or a local branch of that name from origin's —
  so its pull request stays the goal's; any other goal's worktree is
  `goal/<name>` from `origin/main`. The runner's review, `mc goal stage
  merge` and `mc goal archive` read a goal's branch from its worktree
  (`goalBranch`), and the page finds its pull request by the ones GOAL.json
  says carry it as well as by `goal/<name>`;
- a branch-flow project — its last step `kind: review` — is one goal, named
  after the project, on the project's branch: the project's goal and every
  remaining step's instruction as its text, every remaining step's criterion,
  in `review · ready` with the pull request when every step before the review
  is built, else `build`.

A project with every step done, or archived (a `CLOSEOUT.json` beside its
plan), is refused and left as it is on disk; nothing else in mc reads it. So
is a project whose goals already exist, and one whose branch is checked out in
another worktree — with nothing written. The answer names each goal made with
its stage, status, phase, branch and pull request:
`mc: mc/mixed-2 · review · ready · phase 1 · mixed-2 · carries memoro-cli#41`.

## Phases

Martin, 2026-11-03: *"GOAL ska också kunna delas in i faser: En fas innebär en
grupp mål som ska vara samtliga 'done' innan goals i fas 2 kan påbörjas."* and
*"Vi använder phases alltså behövs inte waiting."* A goal's `phase` says when
it may start; its stage does not change for it.

- **Gated by phase** (`currentPhase`, `phaseOpen` in `goals.js`). The phase a
  programme is in is the lowest phase of its goals that parse and are neither
  `done` nor `dropped`. The runner picks no goal in a higher phase — not for a
  build, a review or plan — until every goal of the programme in a lower phase
  is done or dropped. The goals of one phase run side by side. A goal that does
  not parse has no phase and holds nothing back.
- **No holes, lowest is 1** (`phaseMoves`, `renumberPhases`). `mc goal new
  --phase` and `mc goal phase` take at most one past the programme's highest.
  When a goal is archived — by `mc goal archive` or by the runner — and when
  `mc goal phase` moves one, the programme's phases are renumbered so they run
  1, 2, … in the order they had: when the last goal of phase 1 leaves, phase 2
  is phase 1 and phase 3 phase 2 (Martin: *"när goals/faser arkiveras så får
  n+1 n istället"*). A renumbering writes GOAL.json only, no log entry.
- **Seen.** `mc goal list` groups by phase and names the phase in progress;
  `mc goal show` gives the goal's phase. On the page a goal in a phase not yet
  reached is in the waiting colour (yellow, `docs/technical/mc-ui.md`)
  and leads its tail with `phase <n> — after phase <n-1>`; its row in `mc
  --json` (`programmes[].goals[]`) carries `phase` and `held`.

### Converting after into phases

Until 2026-11-03 a goal named the goals it started after in `after`, and was
`waiting` until they landed. `phaseGoals` (`goal-convert.js`, the one reader of
`after` left) turns each goal still written so into a phase by the depth of its
chain: a goal whose `after` has all landed — `done`, `dropped`, or no goal any
more — keeps its phase (1 when it had none), and a goal after one that has not
is one phase past the latest of them; so a chain a ← b ← c of goals not yet
landed is phases 1, 2, 3. `after` is removed, a `waiting` goal is `build ·
ready`, and a goal whose phase or stage changed gets an entry `Done: build ·
ready, from waiting; phase <n>, from after <names>`. The programmes touched are then renumbered. `mc goal convert` runs it
(as `person`), and the runner runs it before it picks goals and before it
archives (`convertAfter` in `run.js`, as `runner`), so a GOAL.json with `after`
never stays one; with nothing to convert nothing is written.

### Converting a status into a stage

A goal written before stages has one `status`. The same pass (`phaseGoals`,
`stageOfLegacy` in `goal-convert.js`) gives it `stage` and `status` from that
status and its log, with an entry `Done: <stage> · <status>, from <old>`:

- `open` and `waiting` → `build · ready`;
- `review` → `review · ready`, or `merge · ready` when the runner's last word
  was `queued #<pr> at <sha> for the merger`;
- `blocked` → the stage its log says it was blocked in, `· blocked`: a red
  review's verdict is `finish`; the merger's red or a queued green is
  `merge`; the runner's word on a review (no verdict, no pull request, a
  moved head) or an entry in `review` is `review`; anything else — a build
  session's question, three sessions without a word, an entry in `open` — is
  `build`. The runner's `plan session ended …` entry and a person's block are
  read past;
- `done` and `dropped` stay as they are, `· ready`.

## How the runner takes a goal

A free lane takes a goal's session: `pickWork` (`lane-pick.js`) orders the
candidates ([mc-run.md](mc-run.md), *What a free lane takes*), and
`goalPass` in `src/mc/run.js` takes the pick:

1. **Pick.** After goals written with `after` or one status are converted
   (*Converting …*), of the goals the runner starts a session on
   (`goalSession`, `goals.js`) — `build · ready` with a criterion (a build),
   `review · ready` (a review), `finish · ready` (a plan session), and
   legacy `merge · ready` whose last entry is the merger's red and none of whose
   pull requests is in the merger's line (a plan session) — never `plan · ready` or `Martin`. Blocked goals wake plan in their
   current stage; eligible work is in the phase their programme is in or an earlier one
   (*Phases*), and not held, on any repository (a lane serves them all), the
   one whose last entry is oldest. A review that cannot run now (step 3) is
   left out of the pick, so it does not stand in front of every other goal;
   why is said once in `runner.log`. No entry means oldest of all; a tie goes
   to the first listed. Held means a current file named
   `goal:<programme>/<goal>` exists, or the lane claimed it this tick. A goal
   keeps no slot between its sessions.
2. **Worktrees.** A repository's worktree that has gone is made again on
   `goal/<goal>`, as `mc goal new` makes it. Before a goal's first build
   session, a branch with no commits of its own is remade from `origin/main`
   (`remakeUnbuiltBranches`).
3. **Launch.** A goal in `build` gets a build session with the `build-session:goal`
   role (`canon/roles/build-session.md`, its `goal` and shared build parts), in
   the first repository's worktree, with the goal's class routing, model and
   billing as any headless session has them. A goal in `review` gets a review session with
   the `review-session:goal` role instead, on a review candidate (`mc
   model`). Review ranks usable subscriptions by provider priority, then headroom; ties avoid the build model, then follow catalog order. Build-model diversity is a tie rule, not a reason to abandon a preferred provider or roomier subscription. With no
   candidate on its plan it uses the API
   reserve as a class does (`docs/technical/mc-run.md`, *Work classes and
   capacity*). The models are compared as the catalog spells them, which is
   how `MC_MODEL` writes them into the heading. The review is told its pull
   request and head: the open pull request on `goal/<goal>`, asked of GitHub
   before the launch, and `MC_REVIEW_HEAD`, `MC_REVIEW_PR` and
   `MC_SESSION_STARTED` are set for it. With none, the goal goes to
   `finish · ready` with a runner entry. A goal in `finish`, or in `merge`
   after a red, gets a headless plan session (*Finish and a red merge: a plan
   session*). `MC_ROLE`, `MC_GOAL`, `MC_REPO`, `MC_WORKAREA` and `MC_TOOL` are
   set. If the role's file is missing on the machine, the goal is skipped.
4. **Silent build.** A build session that leaves no entry gets one from the
   runner: tool `runner`, stage and status unchanged, `Comment: session ended
   without a log entry (exit <n>, <s> s)`. A worktree that could not be made
   gets one too. When the last three entries in `build` are all the runner's,
   the goal goes to `finish · ready`, for a plan session to finish or let go.
   That is the guard against a session that fails the same way every time;
   there is no attempt counter.
5. **After a review** (`afterReview`). The review decides, with `mc goal stage
   merge` or `finish`; the runner reads neither its words nor REVIEW.md nor
   any verdict, and queues nothing. A review that ended with the goal still in
   `review` died (a crash, a limit): the runner writes `the review ended with
   the goal still in review — a review runs again`, and the goal stays
   `review · ready`. A second that dies in the same `review` sets `review ·
   blocked`, for planning recovery.
6. **After a plan session** (`afterPlan`). In `finish`: one that ends with the
   goal still `finish · ready` sets it `finish · blocked`. In `merge`: one
   whose pull request is in the merger's line again gets the runner's entry
   `plan session took the red; the pull request is in the merger's line
   again`, so the red wakes nothing again; one whose is not sets `merge ·
   Martin` after unsuccessful blocked recovery.

Each session is a row in `runs.tsv` named `goal:<p>/<g>`, of kind
`build-goal`, `review-goal` or `plan`; rows from before say `goal`, and are
read as the build they were. On the page it is a `BUILD`, `REVIEW` or `PLAN`
row in SESSIONS working on `<p>/<g>`. A build waits behind every review for a
free lane; a plan session ranks with the reviews
([mc-run.md](mc-run.md) § *Lanes*).

## Headless plan sessions

The unified plan role is `MC_ROLE=plan`, read from
`canon/roles/plan-session.md`. It runs beside the goals in the programme's
directory, on the available Opus/Sol medium candidate with most headroom.
`MC_PLAN_REASON` distinguishes finishing work, recovering blocked work, and
choosing the next programme step. See *Headless planning reasons* below for
the triggers, authority, retry guards and persistent completion receipt.
No headless session performs Martin's acts: deploy, production data,
credentials or admin override.

## What a build session does

The role is `canon/roles/build-session.md`, started as `build-session:goal`:
what every headless build does is written once, in the shared part, and the
`goal` part keeps only what is a goal's — its
brief, LOG.md and the criterion verbs. It works on the branch as it is, never
fetching or merge `origin/main` to keep up: a conflict the merger reports
is the one time a build merges `origin/main`. It works item after item until
the criteria hold, and ends at a boundary between two only when the work is
done, when it is blocked, or when its turns cost more than a fresh session
reading the log would — a finished part that reads well is not a reason to
stop. It runs each criterion's check and records the ones that hold with
`mc goal criterion met <n>`. It runs `mc gate`, commits, and publishes with
`mc publish --no-merge`. It ends with `mc goal log` and does one of two things:
`--stage review` when every criterion is met and the pull request carries
them, or `--status blocked` when it cannot solve it. A build session
publishes, and never merges, sets `done` or moves the goal anywhere else.

## What a review session does

The role (`canon/roles/review-session.md`, its `goal` part) judges and never builds: it does not
edit, commit, push or comment-fix. It reads the goal (its prompt carries it,
rendered), LOG.md and the pull request's diff against `origin/main`, and
checks, in order:

- **Goal** — each criterion: it runs the criterion's check itself (`mc gate`,
  `mc`, `mc shot`, the code) and answers red when one does not hold, whatever
  its `met` says. A builder's claim — `met` included — is not evidence.
- **Structure** — the change fits where it sits, no duplication, the right
  altitude, readable names, the documents the goal names updated.
- **Bugs** — edge cases, error paths and regressions in what the diff touches.

Martin, 2026-11-03: *"Vi ska utnyttja reviewen till input utan att betala för
output som ingen läser."* Its output is exactly three things:

- **The stage, always one of two.** OK: `mc goal stage merge`, which directly
  lands all registered pull requests. Before authorizing it, the review or
  finish session must complete GREEN `mc gate --whole-selection` on the judged
  worktrees; landing adds no gate or head validation. See the canonical
  [publication and direct landing procedure](../../canon/tasks/publish-and-merge.md).
  Not OK: `REVIEW.md` in
  the goal's directory — the head sha judged, what is wrong and where — then
  `mc goal stage finish`. Nobody reads a review that went to `merge`, so it
  writes no REVIEW.md then.
- **One proposal, always** — whichever stage, one file in
  `~/mc/programs/<programme>/proposals/` with what it noticed beyond the goal.
  The programme's plan session takes a stand on it.
- **One line in LOG.md**, the stage verb's `--reason`, naming the files it wrote.

Nothing else: no comment on the pull request, no long entry. **A review never
ends in `review`.** Claude Code's Stop hook runs `mc hook stop`
(`reviewStopDecision`, `hooks.js`): for a session with `MC_ROLE=review-session:goal`
it refuses the end — `{ "decision": "block", "reason": … }` — while the goal is in
`review` or no `.md` has been written in the programme's `proposals/` since
`MC_SESSION_STARTED`, naming what is missing. Any other session ends as it
will. A review that dies anyway leaves the goal `review · ready` (*How the
runner takes a goal*, step 5).

## Done when its work has landed

Martin, 2026-11-03: *"När ett goal steg landas så måste status uppdateras
automatiskt till 'done'"*. Until then only a landing of the goal's own
`goal/<g>` pull request, queued by its green review, set `done`; work landed
from other branches — `ios-release/mc-asc` landed in six pull requests across
memoro and memoro-cli — left the goal for a person to close by hand.

- **A pull request carries its goal.** `mc publish` writes the pull request
  into the goal's `prs`, with an entry `Done: published <repo>#<n>`, when it
  knows the goal: `--goal <p>/<g>`, else `MC_GOAL`, else the goal whose
  worktree it stands in (`goalOfPath`), else the one goal named as a
  `goal/<g>` branch is. A `--goal` that is no goal is refused before the push;
  found any other way, a goal that is not there is none. `mc goal pr` adds one
  by hand.
- **The merger tells the goal whoever queued it.** A job's goal is its own
  (`job.goal`, the review's `mc goal stage merge`), else the goal whose `prs` name it
  (`goalOfJob`, merger.js, over `programsGoals`). So a pull request a person
  queues with `mc merge`, or one `mc publish` queued, is the goal's too.
- **Done when all have landed.** Landed, and the goal carries no other pull
  request: stage `done`. Landed while it carries others: an entry with no
  change (`… the goal carries memoro-cli#1238 too — done when every one has
  landed or closed`). The runner's `settleLanded` pass (run.js), at most every
  five minutes, asks GitHub for the state of each pull request of every goal
  that is not finished and carries any, and sets `done` when every
  one is merged (`prsLanded`) — however each
  landed: the merger, `mc merge --docs`, `--admin`, or on GitHub. A pull
  request GitHub cannot say about leaves the goal as it is.
- **Review stays on the first repository.** A goal's review session is told
  the open pull request on `goal/<g>` in its first repository, as before; a
  second repository's pull request carries the goal and lands it, but is not
  reviewed by the goal's review. A goal across two repositories whose second
  half needs review publishes it from that repository's worktree, and plan or
  a person reads it.

## The merger

A session sends a goal to `merge`. Every registered PR is merged directly,
without another gate, criterion check or reviewed-head check. Each landing is
recorded in LOG.md under the shared lock; when the last PR lands the goal is
`done`. The first failure sets `merge · blocked` and wakes plan recovery.
An unresolved recovery waits on Martin under the normal recovery guards.
The merger does not resolve content conflicts.
The runner recovers missing queue entries after interruption; it executes the
existing decision and does not move a goal to `merge` on its own.

## Stages

Each stage has one owner, and a goal passes each once:

- `plan` — a plan session writes the goal; nothing happens to it, and the
  runner never takes it. The plan session moves it to `build` when it is
  ready to be built.
- `build` — the runner's build sessions, while it is `ready`.
- `review` — one review session decides; one that dies is run again once.
- `finish` — one headless plan session finishes it to `merge`.
- `merge` — the merger's; the runner starts no session, except one plan
  session for blocked merge recovery.
- `done` — set by the merger or the runner when every pull request the goal
  carries has landed, or by a person. Final.
- `dropped` — let go without landing (`mc goal drop`), by a person or plan,
  from any stage. Final; it holds no later phase back, and is archived as a
  `done` goal is.

`Martin`, in any stage, waits on Martin and wakes nothing: `mc goal list` says `<stage> · Martin, waits on
a person`, and the page leads the row's tail with `waits on a person` and the
last entry's comment, in the colour of what waits on a person. `mc goal ready`
sets it ready in the same stage. Only a person moves a stage backward. The
page's goal rows, `mc goal show`, `mc goal list` and `mc --json`
(`programmes[].goals[]`, with `stage` and `status`) all say `stage · status`.

## What a goal does not have

- **Criteria, not tasks inside the goal.** Criteria are data in GOAL.json,
  met when a session has run the check. Split ordered work into goals in phases.
- **No register.** mc writes GOAL.json, LOG.md, the current file while a
  session runs, and the `runs.tsv` row. Nothing else.
- **No owner, lease, revision or capability report.** Anyone may work in the
  worktree; the last entry says what was done.
- **Another model reviews, when one can.** The review is a session of its own
  role on a review candidate; the last build entry's model only when no other
  candidate can run on its plan.
- **No merge by a build session.** A build session publishes with
  `--no-merge`; a review session publishes nothing. A review's `mc goal stage
  merge` executes its decision for all registered PRs; plan uses the same verb.
- **No close-out document.** `mc goal archive` moves a finished goal aside
  and writes one row; nothing is written into a repository.

Programme planning runs separately from goal builds: low remaining work and
daily open proposals can wake a plan session without assigning MC_GOAL.


## Headless planning reasons (2026-11-05)

The plan identity is `MC_ROLE=plan`, for both interactive and headless
sessions. Its canonical file remains `canon/roles/plan-session.md`; the old
`plan-session` identity is accepted for sessions already running.
`MC_PLAN_REASON` carries the runner's reason:

- `finish`: `finish · ready`, to finish the work and authorize merge.
- `blocked`: any unfinished goal with status blocked, or a merge failure
  handed back ready by an older merger. Diagnose, repair and retry the same stage
  (`mc goal ready`; `mc goal stage merge` re-executes merge). A review may
  report an obstacle with blocked without pretending to have judged the work.
- `no_goals_remaining`: reconsider next work and previously unmet dependencies
  when no unfinished goal remains. Done and dropped both count as finished.
- `daily_proposals`: review direct open `.md` proposals at most once per rolling
  24 hours. Nested/archive proposals and directories are not open proposals.

The last two are programme sessions with no MC_GOAL. Their prompt lists all
simultaneously due triggers, remaining goals and open proposals. Read README,
PLAN.md, current/completed goal evidence and proposals, inspect dependencies,
commission justified work within the approved direction and record the decision
or named waiting condition in PLAN.md. Preserve Martin decisions and existing
work ownership; do not interpret a top-up as permission to clear them.

`mc goal martin --reason "…"` is plan's escalation to Martin: the exact
question or reserved act, attempted remedies and recommendation. It is not
runnable. Build and review report blocked to plan rather than setting Martin.
An unresolved recovery waits on Martin; three recoveries in the same stage
also wait rather than loop. A person's ready resets that recovery budget.
A finish session left ready first becomes blocked, allowing recovery.

The runner serializes planning per programme, including live foreground plan
sessions and draining runners, and uses the ordinary provider, lane and
admission policy. Programme replenishment/review yields to already commissioned
recovery, finish, review and build work; it is not blocked recovery.

`runner/programme-plan/<programme>.json` records the low-work identity,
proposal-review start, trigger list and session outcome. Low-work identity
includes goal creation identities and finished-stage entries, with active and
archived goals reconciled together. Archive moves, phase renumbering and ordinary
unfinished stage/status/log changes do not wake another session. Newly completed
or dropped work can re-arm the one/zero checkpoint. Empty programmes qualify
once; invalid goals suppress automatic programme planning. Existing all-done
`next_step` receipts suppress repeating that same completion after upgrade.

The receipt is written after admission succeeds, immediately before provider
invocation. Refused admission/capacity leaves the trigger available. Failures
and interrupted/unknown outcomes stay consumed and inspectable, avoiding an
immediate unattended retry loop. A later genuinely new low-work event or the
next due proposal review can still run. Coalesced low-work/proposal reviews
consume both reasons in one launch. Changing/adding proposals within the
24-hour period does not bypass the cadence. README changes alone do not wake
planning. These triggers run programme plan sessions, never Manager sessions.
