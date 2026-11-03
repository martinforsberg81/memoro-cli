# mc goals

**Status:** current · 2026-11-03 · derived from `src/mc/goals.js`,
`src/mc/criteria.js`, `src/mc/goal-convert.js`, `src/mc/commands/goal.js`, `src/mc/run.js` (`goalPass`, `runGoal`,
`reviewRoute`, `settleReview`, `goalWithoutWord`, `releaseWaiting`, `planRoute`,
`settlePlan`), `src/mc/merger.js` (`landJob`, `tellGoal`), `canon/roles/build-session.md`
(its `goal` part), `canon/roles/review-session.md` (its `goal` part),
`canon/roles/plan-session.md` and `canon/roles/goal-verb.md`

A goal is two files and a worktree, beside projects: `GOAL.json`, the brief as
data, and `LOG.md`. It has no steps, no register and no owner. A build session
does the work, records each criterion it has checked as met, and publishes its
pull request; a review session on another model runs the checks and judges it;
a green review queues it for the merger; the goal is `done` when it lands, and
it lands only with every criterion met. A blocked goal wakes a plan
session, which reopens it, replaces it or asks Martin. Martin decided the process on
2026-11-02: *"Ingen review till build. Review skriver i LOG.md; plan öppnar som
har helhetsförståelsen."* and *"Grön till merge direkt."*

```
waiting  ── every after-goal landed (runner) ──────▶ open
waiting  ── an after-goal gone without landing ────▶ blocked
open     ── given an after not landed ─────────────▶ waiting
open     ── build session, every criterion met ────▶ review
review   ── review: red, or no verdict ─────────────▶ blocked
review   ── review: green, head unchanged ──────────▶ review, queued for the merger
queued   ── merger landed ──────────────────────────▶ done
queued   ── merger red ─────────────────────────────▶ blocked
queued   ── head moved past the reviewed one ───────▶ review, reviewed again
open     ── three sessions without a word (runner) ─▶ blocked
blocked  ── the runner wakes plan; plan sets it open ▶ open
blocked  ── plan leaves it blocked (runner entry) ──▶ blocked, waits on a person
blocked  ── a person sets it open ──────────────────▶ open
```

## Layout

```
~/mc/programs/<programme>/goals/<goal>/GOAL.json  the brief, its criteria and its status
~/mc/programs/<programme>/goals/<goal>/LOG.md     one entry per session, newest last
~/mc/programs/<programme>/goals/<goal>/<repo>/    a worktree on goal/<goal>, from origin/main
~/mc/programs/<programme>/goals/.archive/<goal>/  an archived goal (mc goal archive, or the runner 24 h after done or dropped), its worktrees gone
~/mc/programs/<programme>/goals/goal_log.md       one row per archived goal
```

One worktree per repository the goal names. Anyone may work in one: a person,
a plan session, or the runner's build and review sessions on the goal. `<programme>` must be a directory under
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
  "status": "open",
  "repos": ["memoro-cli", "memoro"],
  "class": "fast",
  "created": "2026-11-01T20:00:00Z",
  "after": ["mc/runner-sessions"],
  "prs": ["memoro#14761", "memoro-cli#1238"],
  "title": "Title",
  "goal": ["A paragraph.", "Another."],
  "contract": ["What may not change without Martin."],
  "out_of_scope": ["What this goal does not do."],
  "success_criteria": [{ "criterion": "What must be true", "check": "How it is checked", "met": false }],
  "documents": [{ "label": "What the reader is sent to", "path": "docs/technical/mc-goals.md" }]
}
```

- `status` — `open`, `waiting`, `review`, `blocked`, `done` or `dropped`. A
  goal starts `open`, or `waiting` when its `after` names a goal that has not
  landed.
- `repos` — repository names in order. The first is where a session starts,
  and the lane that serves it takes the goal.
- `class` — `fast` or `large`, routed as a step's class is (ruling 59).
- `created` — an ISO instant written by `mc goal new`, or null.
- `after` — the goals this one starts after, as `<programme>/<goal>`. Written
  by `mc goal new --after` and `mc goal after`. A goal waits on goals only —
  not on a project, a deploy or a time (projects have those).
- `prs` — the pull requests that carry the goal's work, as `<repo>#<n>`.
  `mc publish` writes the one it opens or updates (*Done when its work has
  landed*), and `mc goal pr` names others.
- `goal`, `contract`, `out_of_scope` — arrays of paragraphs, as PLAN.json's.
- `success_criteria` — `[{ criterion, check, met }]`, the same rules as
  PLAN.json's (`validateCriteria` in `src/mc/criteria.js`, which both schemas
  call): every criterion a `check`, `met` true or false, no other key, and at
  least one criterion. `mc goal new`'s skeleton has none yet, and parses as a
  draft: the runner starts no session on an `open` goal with no criterion, and
  it cannot go to review.
- `documents` — `[{ label, path }]`, as PLAN.json's (`validateDocuments`).

An unknown key, a wrong schema or version, or a bad field is a problem named
by its field. A GOAL.json that does not parse is listed by `mc goal list` with
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
## 2026-11-01T21:30Z · claude claude-haiku-5-5 · open

Done: what the session did
Comment: what a reader should know
Next: what the next session should do
```

- The heading is `## <at> · <tool> [<model>] · <status>`: `<at>` is UTC to the
  minute; `<tool>` is `MC_TOOL`, `person` or `runner`; `<model>` is `MC_MODEL`
  when set; `<status>` is the goal's status after the entry.
- The labels are `Done:`, `Comment:` and `Next:`, in English like the rest of
  the goal. A log written before 2026-11-03 has `Gjort:`, `Kommentar:` and
  `Nästa:`; the parser reads those as the same fields, so no log is rewritten.
  A label's text runs on until the next label or heading, so a field may take
  several paragraphs.
- A heading that does not match the form is skipped with its lines.
- `mc goal new` writes the first entry: `person`, `open`, `Done: created`.
- A session count is every entry whose tool is neither `runner` nor `person`.
- A review's entry is its verdict: `Done:` starts with `green` or `red`, then
  the head sha it judged (`verdictOf`). The **last build entry** is the last
  entry that is neither the runner's, a person's nor a verdict
  (`lastBuildEntry`); its `<tool> <model>` is the model a review may not run on.
- The runner writes `Done: queued #<pr> at <sha> for the merger` when it
  queues a green, and the merger `Done: landed #<pr> as <sha>` or
  `Done: merger answered red on #<pr>` when it answers.

## The verbs

Fifteen verbs; the status verbs are five words.

- **`new <p>/<g> --repo <r>[,<r>] --class fast|large --title "…" [--after <p>/<g>[,<p>/<g>]]`** — makes a
  goal, refused unless its flags are valid and its names are new. With
  `--after`, every name must be a goal (not the goal itself), and the goal
  starts `waiting` when one of them has not landed — its first entry says
  `waits on …`. Each
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
  GOAL.md*).
- **`after <p>/<g> [<p>/<g>…]`** — replaces the goal's `after`; none given
  clears it. A name that is not a goal, the goal itself, or a ring (a goal
  that already waits, through its own `after`, on this one) is refused, and so
  is a goal in `review` or `done`: it waits on nothing. An `open`, `blocked`
  or `waiting` goal becomes `waiting` while a name has not landed; a `waiting`
  one with nothing left is `open` again, its branches remade as `open` does.
  A `blocked` one with nothing left stays `blocked` — a person or plan blocked
  it, and `mc goal open` opens it; the line says so. `open` itself is refused
  while an `after` has not landed, whatever the goal's status is now.
  The change is an entry: `Done: after <names>` (or `after cleared`). It is a
  verb of its own, not a flag on `log` or a status verb, because it changes
  `after` and the status follows from it.
- **`log [<p>/<g>] [--done "…"] [--comment "…"] [--next "…"] [--status <s>]`** —
  appends one entry; at least one field is needed. `--status` also sets the
  status, except `waiting`: a goal waits by its `after`, never by a
  status. The goal is `MC_GOAL`'s when none is named.
- **`drop [<p>/<g>] --reason "…"`** — lets a goal go without landing: status
  `dropped`, never `done`, so a goal that starts after it does not start — it
  is blocked for plan, as after a goal that is gone (`afterOf`). The reason is
  required. Only a person or a plan session drops a goal.
- **`pr <p>/<g> <repo>#<n>…`** — the pull requests named carry the goal: each
  is added to `prs` once, with an entry `Done: carries <repo>#<n>`. For work
  published before `mc publish` wrote `prs`, or from where it could not tell
  the goal.
- **`archive <p>/<g>…`** or **`archive <p>`** (every done or dropped goal of the
  programme) — a finished goal leaves `mc goal list` and the page. Refused, by
  name and reason and with nothing touched, for a goal that is not `done` or
  `dropped`; that a goal not finished names in `after`; whose worktree has
  uncommitted changes; with an open pull request on `goal/<g>` or in `prs`;
  and, for a dropped one, whose branch has commits no remote holds. Otherwise
  each worktree is removed with `git worktree remove` and the local branch
  `goal/<g>` deleted, the directory moves to `goals/.archive/<g>/` (a
  dot-directory, so no reader lists it), and `goals/goal_log.md` gets a row:
  date, goal, status, pull requests, the last `Done:`. The runner does the same
  by itself for a goal that has been `done` or `dropped` for 24 hours, the hold
  a project under `~/mc/programs/` has (`ARCHIVE_HOLD_MS`, in the same chore),
  counted from the log entry that set the status. A refusal the runner gets is
  written once into the goal's LOG.md, as a runner entry, and not again at
  every pass. A programme is never archived by the runner.
- **`open|review|blocked|done [<p>/<g>] [--reason "…"]`** — sets the status and
  logs the reason as the entry's `Comment`. Going `open` (by `open` or
  `log --status open`) is refused, with nothing written, while the goal's
  `after` names a goal that has not landed or is gone: `mc: mc/headless-plan
  is not opened — it waits on mc/goal-waiting, not landed; …`.
- **A goal's branch is made when the goal can start.** A goal that waited got
  its branch at `new`, before what it waits for landed. When it goes `open` —
  by `open`, `log --status open`, `after`, or the runner releasing it — each
  worktree is fetched, and one whose branch has no commits past
  `origin/main` is moved to `origin/main` as it is now (`git reset --keep`) —
  that branch made again. A branch with commits of its own is never moved,
  nor one with uncommitted changes `--keep` will not carry; each repository
  says which (`remade from origin/main — it had no commits of its own, and
  main has 12 more`, `left as it is — 3 commits of its own`), and nothing
  here fails the status change (`remakeUnbuiltBranches`, `goals.js`).
- A plan session (`MC_ROLE=plan-session`) sets every status (Martin,
  2026-11-03: it drives the programme toward its aim, and may finish a goal
  itself). Any other session — `MC_GOAL` set and `MC_TOOL` not `person` — is
  refused `done` and `dropped`, by either verb: the merger sets `done` when the
  goal lands. A review session (`MC_ROLE=review-session:goal`) is refused
  `open` too: plan decides what comes after a red (`refusedStatus`). And a
  session other than plan is refused `review` while a criterion is not met, or
  while the goal has none: `mc: mc/g is not set review — criterion 2 is not
  met — run its check and record it with mc goal criterion met mc/g 2`
  (`unmetGoalWords`), with nothing written. A person is not refused; the
  merger refuses to land it anyway (*The merger*).
- **`show <p>/<g>`** — a status line (`<p>/<g> · status · repos · class ·
  criteria <met>/<all> · created …`, with `· after <names>` and `· prs …` when
  set), the goal as text (*Seen, not only stored*), the last three entries, and
  each worktree's changed files, commits past `origin/main` and last commit date.
- **`list [<p>]`** — one line per goal: `programme/goal · repos · status ·
  criteria <met>/<all> · n sessions · the last entry's Next` — `—` for a `done` or `dropped` goal,
  whose last next action is over. A goal blocked by a red review, a red
  merge or the runner reads `blocked, waits on plan` (`waitsOnPlan`); any other
  blocked goal `blocked, waits on a person` (`waitsOnPerson`); a waiting goal reads
  `waiting on <p>/<g>, …`, the names in its `after` that have not landed; an
  `open` goal with no criterion `open, no criteria — not started`.

## Converting a GOAL.md

Goals written before 2026-11-03 are a `GOAL.md`: front matter between `---`
lines, then Markdown. `mc goal convert [<programme>]` (`src/mc/goal-convert.js`,
the one reader of GOAL.md left) turns each one not under `goals/.archive/` into
GOAL.json and removes the GOAL.md:

- the front matter's `status`, `repos`, `class`, `created`, `after` and `prs`
  become fields; the `# ` line is the title;
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

## Waiting on another goal

Martin, 2026-11-02: *"Sedan behöver vi en status som heter waiting, det har vi
redan för project."* A goal that must start after another names it in
`after`, and is `waiting` until it has landed: the runner lets it go, as it
lets a project step blocked on a time, a deploy or another project go
(ruling 35). `blocked` keeps meaning a person or plan must act.

Each time a lane looks for work, before goals are picked, the runner settles
every goal's `after` (`releaseWaiting` in `run.js`, `waitingMoves` and
`afterOf` in `goals.js`), against the goals there are:

- **Landed** is `done`. When every goal in a `waiting` goal's `after` has
  landed, the runner sets it `open` with an entry `Done: <names> landed —
  starting`, remakes its branches from `origin/main` as it is now
  (`remakeUnbuiltBranches`), and the goal is a candidate in that same pick.
- **Pending** is any other status, `blocked` included: an after-goal that is
  blocked may still land, so the goal stays `waiting` and nothing is written.
- **Gone** is no goal by that name any more — its directory or GOAL.json
  removed, which is how a goal is discarded or archived without landing. The
  waiting goal goes `blocked` with the entry `Comment: <names> is gone
  without landing — waits on plan to change after`; `waitsOnPlan` counts it,
  so the list and the page say `waits on plan`.
- An `open` goal whose `after` has not landed — an `after` written by hand,
  say — is set `waiting` with an entry `waits on <names>`. A goal in `review`,
  `blocked` or `done` is not moved: a person or plan put it there.

A `waiting` goal is never picked for a session and never wakes plan. The page
draws it in the projects' waiting colour (yellow, `docs/technical/mc-ui.md`)
and leads its row's tail with `waits on <names>`; its row in `mc --json`
(`programmes[].goals[]`) carries `after` and `waiting_on`, and `mc status
<goal>` answers `<goal> is a goal · waiting on <names> — mc goal show …`.

## How the runner takes a goal

A goal is one more candidate for a free lane, beside project steps and
reviews: `pickWork` (`lane-pick.js`) orders them all, and a goal is not
waiting for the steps to run out ([mc-run.md](mc-run.md), *What a free lane
takes*). When the pick is a goal, `goalPass` in `src/mc/run.js` takes it:

1. **Pick.** After `after` is settled (*Waiting on another goal*), of the
   goals that parse and are `open` with a criterion, or due a review, and
   that are not held, on any repository (a lane serves them all), the one whose last
   entry is oldest. A goal in `review` is due a review unless its last entry is
   the runner's `queued` one, or one of its pull requests is in the merger's
   line (a plan session that fixed a red mechanically queued it with
   `mc publish`): then it waits for the merger. A review that
   cannot run now (step 3) is left out of the pick, so it does not stand in
   front of every other goal; why is said once in `runner.log`. No entry
   means oldest of all; a tie goes to the first listed. Held means a current
   file named `goal:<programme>/<goal>` exists, or the lane claimed it this
   tick. A goal keeps no slot between its sessions.
   A goal that waits on plan (`planDue`, *A blocked goal wakes plan*) is a
   candidate too, of kind `plan`.
2. **Worktrees.** A repository's worktree that has gone is made again on
   `goal/<goal>`, as `mc goal new` makes it.
3. **Launch.** An `open` goal gets a build session with the `build-session:goal`
   role (`canon/roles/build-session.md`, its `goal` and shared build parts), in
   the first repository's worktree, with the goal's class routing, model and
   billing as a step has them. A goal in `review` gets a review session with
   the `review-session:goal` role instead, on the review class's candidate
   (`mc model set review`), never routed. It never runs on the model of the
   goal's last build entry: when the review model is that model, the goal
   waits until `mc model set review` names another; it is never reviewed by
   its builder. The models are compared as the catalog spells them, which is
   how `MC_MODEL` writes them into the heading. The review is told its pull
   request and head: the open pull request on `goal/<goal>`, asked of GitHub
   before the launch. With none, the goal is set `blocked` with a runner entry.
   `MC_ROLE`, `MC_GOAL`, `MC_REPO`, `MC_WORKAREA` and `MC_TOOL` are set. If the
   role's file is missing on the machine, the goal is skipped.
4. **Silent exit.** A session that leaves no entry gets one from the runner:
   tool `runner`, status unchanged, `Comment: session ended without a log
   entry (exit <n>, <s> s)`. A worktree that could not be made gets one too.
5. **Three in a row.** When the last three entries are all the runner's and the
   status is `open` or `review`, the runner sets `blocked` and writes a runner
   entry saying so. That is the only guard against a session that fails the
   same way every time; there is no attempt counter.
6. **After a review.** The runner reads the verdict the review wrote
   (`settleReview`):
   - **No verdict:** `blocked`, with a runner entry.
   - **Red:** `blocked`. The review sets it; the runner does if it did not.
   - **Green:** the pull request is asked of GitHub again. When its head is the
     sha the review judged, the runner queues it for the merger as `mc merge`
     does, with the goal and that full sha on the job, and writes the `queued`
     entry; the goal stays `review`. When the head has moved, or the pull
     request is no longer open, nothing is queued and a runner entry says so;
     the goal stays `review`, and the new head gets a review of its own.

Each session is a row in `runs.tsv` named `goal:<p>/<g>`, of kind
`build-goal`, `review-goal` or `plan`; rows from before say `goal`, and are
read as the build they were. On the page it is a `BUILD`, `REVIEW` or `PLAN`
row in SESSIONS working on `<p>/<g>`. A build waits behind a project's build
and every review for a free lane; a plan session ranks with the reviews
([mc-run.md](mc-run.md) § *Lanes*).

## A blocked goal wakes plan

Martin, 2026-11-02: a red review goes to plan, *"plan öppnar som har
helhetsförståelsen"*; a red merge takes the same path. The runner starts one
headless plan session for a goal that waits on plan (`waitsOnPlan`,
`planDue` in `goals.js`): one that is `blocked`, parses, and whose last entry
is a review's `red` verdict or a runner entry of status `blocked` — a red merge
(`merger answered red on #<pr>`), three sessions in a row without a word, a
review that left no verdict or found no pull request, a green that could not
be queued, an `after` goal gone without landing. A goal blocked by a person or
by a build session's own `--status blocked` waits on a person and wakes
nothing; so does a `waiting` goal.

- **Where and on what.** The `plan-session` role (`canon/roles/plan-session.md`,
  its section *Headless, on a blocked goal*), on opus — the role's `fable`
  (ruling 6) until 2026-11-03, when the headless plan moved to opus — on
  claude at high effort, pinned as a review is (`planRoute`), with the billing
  any session has. It stands in the programme's directory
  (`~/mc/programs/<programme>/`), beside the goal's worktree: `MC_ROLE=plan-session`,
  `MC_GOAL`, `MC_PROGRAMME`, `MC_TOOL` and `MC_MODEL` are set, `MC_REPO` and
  `MC_WORKAREA` are not. Its prompt (`goalPlanPrompt` in `run-plan.js`) names
  the goal, the last entry's words and the worktree, which it may take over.
- **One at a time.** The session is named `goal:<p>/<g>` like the goal's other
  sessions, so the current file that holds a build or a review holds it too.
- **What it does.** It reads the goal (its prompt carries it, rendered),
  LOG.md, the pull request and its comments, the programme's README and the
  code, and does what moves the programme's aim most cheaply: finishes the
  work itself in the goal's worktree and publishes it (`--status review`),
  revises the goal with `mc goal set` and `mc goal criterion add` and sets it
  `open` with a `Next:`, replaces or drops a wrong goal, or leaves it
  `blocked` with the question for Martin. It never does Martin's acts —
  `mc deploy`, production data, credentials, `--admin`; work that needs one
  waits for an interactive session.
- **No loop** (`settlePlan`). A goal the session leaves `blocked` — with its
  own entry or none — gets the runner's entry `Done: plan session ended; the
  goal stays blocked — waits on Martin` (`planHeldText`). A goal whose last
  entry is that one is not `waitsOnPlan`, so it starts nothing until a person
  acts. A goal plan set `open` goes to its next build session; when it goes
  red again it is blocked by a fresh entry, and plan is woken again with the
  whole log to read.

## What a build session does

The role is `canon/roles/build-session.md`, started as `build-session:goal`:
what every headless build does is written once, in the part the goal and the
project start share, and the `goal` part keeps only what is a goal's — its
brief, LOG.md and the criterion verbs. It works on the branch as it is, never
fetching or merging `origin/main` to keep up: a conflict the merger reports
is the one time a build merges `origin/main`. It works item after item until
the criteria hold, and ends at a boundary between two only when the work is
done, when it is blocked, or when its turns cost more than a fresh session
reading the log would — a finished part that reads well is not a reason to
stop. It runs each criterion's check and records the ones that hold with
`mc goal criterion met <n>`. It runs `mc gate`, commits, and publishes with
`mc publish --no-merge`. It ends with `mc goal log`, adding `--status review`
when every criterion is met and the pull request carries them, or `--status blocked`
when it cannot go on. A build session publishes, and never merges or sets
`done`.

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

It writes one entry — `Done:` `green <sha>` or `red <sha>`; `Comment:` each
criterion met or not met with its evidence, then structure, then bugs — with
`--status review` for green and `--status blocked` for red, and posts the same
text on the pull request.

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
  (`job.goal`, a green review's), else the goal whose `prs` name it
  (`goalOfJob`, merger.js, over `programsGoals`). So a pull request a person
  queues with `mc merge`, or one `mc publish` queued, is the goal's too.
- **Done when all have landed.** Landed, and the goal carries no other pull
  request: `done`. Landed while it carries others: an entry with no status
  change (`… the goal carries memoro-cli#1238 too — done when every one has
  landed or closed`). The runner's `settleLanded` pass (run.js), at most every
  five minutes, asks GitHub for the state of each pull request of every goal
  that is not finished or waiting and carries any, and sets `done` when every
  one is merged or closed and at least one merged (`prsLanded`) — however each
  landed: the merger, `mc merge --docs`, `--admin`, or on GitHub. A pull
  request GitHub cannot say about leaves the goal as it is.
- **Review stays on the first repository.** A goal's review session is told
  the open pull request on `goal/<g>` in its first repository, as before; a
  second repository's pull request carries the goal and lands it, but is not
  reviewed by the goal's review. A goal across two repositories whose second
  half needs review publishes it from that repository's worktree, and plan or
  a person reads it.

## The merger

A goal's job carries the goal and the head its review judged (`merge-queue.js`
`goal`, `sha`); a job without one answers to the goal whose `prs` name it
(*Done when its work has landed*). The merger (`landJob`, `tellGoal`):

- **Lands only a goal whose criteria hold.** Before any round, a job whose goal
  has a criterion not met — or none — is answered red, `stopped_at:
  unmet-criteria`, with the criteria named (`unmetGoalWords`), as
  `criteriaDoor` (`merge-boundary.js`) refuses a plan's last step. The goal is
  `blocked` as on any red, and waits on plan. A goal the merger cannot read is
  not checked.
- **Lands only that head.** It asks GitHub for the head before the round; a
  head that has moved is answered `moved` with no round spent, and a push
  while the round runs is `moved` too. A moved job leaves the queue and the
  goal goes back to `review` with a runner entry.
- **Landed:** `done`, with a runner entry naming the pull request and the
  landed sha — when the goal carries no other pull request; else the landing
  is an entry and the runner sets `done` once the rest has landed.
- **Red:** `blocked`, with a runner entry giving the round's reason, which
  wakes plan (*A blocked goal wakes plan*). A red only under load is requeued
  as any job's is, and says nothing to the goal until it is answered.

`mc merge` on a red goal job queues it again as the goal's, with no reviewed
head; that is a person's act, and its landing still sets the goal `done`.

## Status

- `waiting` — its `after` names a goal that has not landed. Set by
  `mc goal new --after`, `mc goal after` and the runner, never by `--status`;
  never picked for a session, never woken for plan; `mc goal open` refuses it.
  The runner opens it when every after-goal has landed.
- `open` — picked for a build session. Only plan or a person sets a blocked
  goal open again, after reading the entry, revising the goal if needed and
  writing `Next:`.
- `review` — set by a build session; picked for a review session, or waiting
  for the merger once its green is queued.
- `blocked` — set by a session that cannot go on, by a red review, by the
  runner (steps 3, 5, 6) or by the merger on red. Nothing goes back to a build
  session by itself. One blocked by a red review, a red merge or the runner
  waits on plan, and the runner wakes a plan session for it: `mc goal list`
  says `waits on plan`, and the page leads its row's tail with `waits on plan`.
  Any other — a person's, a build session's question, one plan left blocked —
  waits on a person: the list says `waits on a person`, and the page leads its
  tail with `waits on a person` and the question (the last comment that is not
  the runner's). Both are in the colour of what waits on a person.
- `done` — set by the merger or the runner when every pull request the goal
  carries has landed, or by a person.
- `dropped` — let go without landing (`mc goal drop`), by a person or plan.
  Never picked, never woken; a goal after it is blocked for plan. Archived as
  a `done` goal is.

## What a goal does not have

- **No steps.** No `PLAN.json`, no `mc step`, no `mc project`. Criteria are
  data in GOAL.json, met when a session has run the check.
- **No register.** mc writes GOAL.json, LOG.md, the current file while a
  session runs, and the `runs.tsv` row. Nothing else.
- **No owner, lease, revision or capability report.** Anyone may work in the
  worktree; the last entry says what was done.
- **No review by its builder.** The review is a session of its own role on
  the review model, never the last build entry's.
- **No merge by a session.** A build session publishes with `--no-merge`; a
  review session publishes nothing. Only a green review, through the runner,
  queues a goal's pull request, and only the head it judged lands.
- **No close-out document.** `mc goal archive` moves a finished goal aside
  and writes one row; nothing is written into a repository.

Phases and programme-level goals are not built, and plan is woken only by a
blocked goal: not for projects, and not by a goal that landed.
