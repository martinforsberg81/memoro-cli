# mc goals

**Status:** current · 2026-11-02 · derived from `src/mc/goals.js`,
`src/mc/commands/goal.js`, `src/mc/run.js` (`goalPass`, `runGoal`,
`reviewRoute`, `settleReview`, `goalWithoutWord`, `releaseWaiting`), `src/mc/merger.js`
(`tellGoal`), `canon/roles/build-goal.md` (with `_build.md`) and
`canon/roles/goal-review.md`

A goal is two text files and a worktree, beside projects. It has no steps, no
register and no owner. A build session does the work and publishes its pull
request; a review session on another model judges it; a green review queues it
for the merger; the goal is `done` when it lands. Martin decided the process on
2026-11-02: *"Ingen review till build. Review skriver i LOG.md; plan öppnar som
har helhetsförståelsen."* and *"Grön till merge direkt."*

```
waiting  ── every after-goal landed (runner) ──────▶ open
waiting  ── an after-goal gone without landing ────▶ blocked
open     ── given an after not landed ─────────────▶ waiting
open     ── build session holds the criteria met ──▶ review
review   ── review: red, or no verdict ─────────────▶ blocked
review   ── review: green, head unchanged ──────────▶ review, queued for the merger
queued   ── merger landed ──────────────────────────▶ done
queued   ── merger red ─────────────────────────────▶ blocked
queued   ── head moved past the reviewed one ───────▶ review, reviewed again
blocked  ── plan sets it open ──────────────────────▶ open
```

## Layout

```
~/mc/programs/<programme>/goals/<goal>/GOAL.md    the brief and its status
~/mc/programs/<programme>/goals/<goal>/LOG.md     one entry per session, newest last
~/mc/programs/<programme>/goals/<goal>/<repo>/    a worktree on goal/<goal>, from origin/main
```

One worktree per repository the goal names. Anyone may work in one: a person,
a plan session, or the runner's build and review sessions on the goal. `<programme>` must be a directory under
`~/mc/programs/`; `<programme>` and `<goal>` are lower-case letters, digits and
hyphens. mc keeps nothing else for a goal.

## GOAL.md

Front matter between two `---` lines, then Markdown:

```
---
status: open
repos: memoro-cli, memoro
class: fast
created: 2026-11-01T20:00:00Z
after: mc/runner-sessions, mc/agent-skills-text
---
# Title

## Goal

## Criteria

## Out of scope
```

- `status` — `open`, `waiting`, `review`, `blocked` or `done`. A goal starts
  `open`, or `waiting` when its `after` names a goal that has not landed.
- `repos` — comma-separated repository names. The first is where a session
  starts, and the lane that serves it takes the goal.
- `class` — `fast` or `large`, routed as a step's class is (ruling 59).
- `created` — optional; written by `mc goal new`.
- `after` — optional; the goals this one starts after, comma-separated
  `<programme>/<goal>` names. Written by `mc goal new --after` and
  `mc goal after`; absent is none. A goal waits on goals only — not on a
  project, a deploy or a time (projects have those).

The body is Markdown, written by a person or a session. mc rewrites only the
`status` and `after` lines. A GOAL.md whose front matter does not parse is listed by
`mc goal list` with its problems, and the runner never starts it.

## LOG.md

Each session adds one entry, newest last:

```
## 2026-11-01T21:30Z · claude claude-haiku-5-5 · open

Gjort: what the session did
Kommentar: what a reader should know
Nästa: what the next session should do
```

- The heading is `## <at> · <tool> [<model>] · <status>`: `<at>` is UTC to the
  minute; `<tool>` is `MC_TOOL`, `person` or `runner`; `<model>` is `MC_MODEL`
  when set; `<status>` is the goal's status after the entry.
- The labels are `Gjort:`, `Kommentar:` and `Nästa:`. A label's text runs on
  until the next label or heading, so a field may take several paragraphs.
- A heading that does not match the form is skipped with its lines.
- `mc goal new` writes the first entry: `person`, `open`, `Gjort: skapat`.
- A session count is every entry whose tool is neither `runner` nor `person`.
- A review's entry is its verdict: `Gjort:` starts with `green` or `red`, then
  the head sha it judged (`verdictOf`). The **last build entry** is the last
  entry that is neither the runner's, a person's nor a verdict
  (`lastBuildEntry`); its `<tool> <model>` is the model a review may not run on.
- The runner writes `Gjort: queued #<pr> at <sha> for the merger` when it
  queues a green, and the merger `Gjort: landed #<pr> as <sha>` or
  `Gjort: merger answered red on #<pr>` when it answers.

## The verbs

Six verbs; the status verbs are four words.

- **`new <p>/<g> --repo <r>[,<r>] --class fast|large --title "…" [--after <p>/<g>[,<p>/<g>]]`** — makes a
  goal, refused unless its flags are valid and its names are new. With
  `--after`, every name must be a goal (not the goal itself), and the goal
  starts `waiting` when one of them has not landed — its first entry says
  `waits on …`. Each
  repository is fetched first; then GOAL.md, LOG.md, and a worktree of each on
  `goal/<g>` from `origin/main` (or that branch as it stands, when it exists).
  **One branch, built to the end**: the goal is built on this branch, and
  whether `main` moves meanwhile is not the build's concern — the merger
  brings the candidate up to date when it lands it.
- **`after <p>/<g> [<p>/<g>…]`** — replaces the goal's `after`; none given
  clears it. A name that is not a goal, the goal itself, or a ring (a goal
  that already waits, through its own `after`, on this one) is refused, and so
  is a goal in `review` or `done`: it waits on nothing. An `open`, `blocked`
  or `waiting` goal becomes `waiting` while a name has not landed; a `waiting`
  one with nothing left is `open` again, its branches remade as `open` does.
  A `blocked` one with nothing left stays `blocked` — a person or plan blocked
  it, and `mc goal open` opens it; the line says so. `open` itself is refused
  while an `after` has not landed, whatever the goal's status is now.
  The change is an entry: `Gjort: after <names>` (or `after cleared`). It is a
  verb of its own, not a flag on `log` or a status verb, because it changes
  the `after` line and the status follows from it.
- **`log [<p>/<g>] [--done "…"] [--comment "…"] [--next "…"] [--status <s>]`** —
  appends one entry; at least one field is needed. `--status` also sets the
  status line, except `waiting`: a goal waits by its `after`, never by a
  status. The goal is `MC_GOAL`'s when none is named.
- **`open|review|blocked|done [<p>/<g>] [--reason "…"]`** — sets the status and
  logs the reason as the entry's `Kommentar`. Going `open` (by `open` or
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
- A session — `MC_GOAL` set and `MC_TOOL` not `person` — is refused `done`,
  by either verb: only the merger and a person set it. A review session
  (`MC_ROLE=goal-review`) is refused `open` too: plan sets a goal open again.
- **`show <p>/<g>`** — the front matter (with `· after <names>` when set), the body, the last three entries, and
  each worktree's changed files, commits past `origin/main` and last commit date.
- **`list [<p>]`** — one line per goal: `programme/goal · repos · status ·
  n sessions · the last entry's Nästa`. A goal blocked by a red review or a red
  merge reads `blocked, waits on plan` (`waitsOnPlan`); a waiting goal reads
  `waiting on <p>/<g>, …`, the names in its `after` that have not landed.

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
  landed, the runner sets it `open` with an entry `Gjort: <names> landed —
  starting`, remakes its branches from `origin/main` as it is now
  (`remakeUnbuiltBranches`), and the goal is a candidate in that same pick.
- **Pending** is any other status, `blocked` included: an after-goal that is
  blocked may still land, so the goal stays `waiting` and nothing is written.
- **Gone** is no goal by that name any more — its directory or GOAL.md
  removed, which is how a goal is discarded or archived without landing. The
  waiting goal goes `blocked` with the entry `Kommentar: <names> is gone
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
   goals that parse and are `open` or due a review and
   that are not held, on any repository (a lane serves them all), the one whose last
   entry is oldest. A goal in `review` is due a review unless its last entry is
   the runner's `queued` one: then it waits for the merger. A review that
   cannot run now (step 3) is left out of the pick, so it does not stand in
   front of every other goal; why is said once in `runner.log`. No entry
   means oldest of all; a tie goes to the first listed. Held means a current
   file named `goal:<programme>/<goal>` exists, or the lane claimed it this
   tick. A goal keeps no slot between its sessions.
2. **Worktrees.** A repository's worktree that has gone is made again on
   `goal/<goal>`, as `mc goal new` makes it.
3. **Launch.** An `open` goal gets a build session with the `build-goal` role
   (`canon/roles/build-goal.md`, which includes `_build.md`), in
   the first repository's worktree, with the goal's class routing, model and
   billing as a step has them. A goal in `review` gets a review session with
   the `goal-review` role instead, on the review class's candidate
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
   tool `runner`, status unchanged, `Kommentar: session ended without a log
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
`build-goal` or `review-goal`; rows from before say `goal`, and are read as
the build they were. On the page it is a `BUILD` or `REVIEW` row in
SESSIONS working on `<p>/<g>`, and it waits behind a project's build and
every review for a free lane ([mc-run.md](mc-run.md) § *Lanes*).

## What a build session does

The role is `canon/roles/build-goal.md`, one of the two variants of the
build role: what every build does is written once in `canon/roles/_build.md`,
which it and `build-project.md` both `@include`, and the variant keeps only
what is a goal's — GOAL.md and LOG.md. It works on the branch as it is, never
fetching or merging `origin/main` to keep up: a conflict the merger reports
is the one time a build merges `origin/main`. It works item after item until
the criteria hold, and ends at a boundary between two only when the work is
done, when it is blocked, or when its turns cost more than a fresh session
reading the log would — a finished part that reads well is not a reason to
stop. It runs `mc gate`, commits, and publishes with `mc publish --no-merge`. It ends with `mc goal log`, adding `--status review`
when the criteria hold and the pull request carries them, or `--status blocked`
when it cannot go on. A build session publishes, and never merges or sets
`done`.

## What a review session does

The role (`canon/roles/goal-review.md`) judges and never builds: it does not
edit, commit, push or comment-fix. It reads GOAL.md, LOG.md and the pull
request's diff against `origin/main`, and checks, in order:

- **Goal** — each criterion, with evidence it saw itself (`mc gate`, `mc`,
  `mc shot`, the code). A builder's claim is not evidence.
- **Structure** — the change fits where it sits, no duplication, the right
  altitude, readable names, the documents the goal names updated.
- **Bugs** — edge cases, error paths and regressions in what the diff touches.

It writes one entry — `Gjort:` `green <sha>` or `red <sha>`; `Kommentar:` each
criterion met or not met with its evidence, then structure, then bugs — with
`--status review` for green and `--status blocked` for red, and posts the same
text on the pull request.

## The merger

A goal's job carries the goal and the head its review judged (`merge-queue.js`
`goal`, `sha`). The merger (`tellGoal`):

- **Lands only that head.** It asks GitHub for the head before the round; a
  head that has moved is answered `moved` with no round spent, and a push
  while the round runs is `moved` too. A moved job leaves the queue and the
  goal goes back to `review` with a runner entry.
- **Landed:** `done`, with a runner entry naming the pull request and the
  landed sha.
- **Red:** `blocked`, with a runner entry giving the round's reason. A goal's
  job gets no mend: the mend's push would be a head no review read. A red only
  under load is requeued as any job's is, and says nothing to the goal until
  it is answered.

`mc merge` on a red goal job queues it again as the goal's, with no reviewed
head; that is a person's act, and its landing still sets the goal `done`.

## Status

- `waiting` — its `after` names a goal that has not landed. Set by
  `mc goal new --after`, `mc goal after` and the runner, never by `--status`;
  never picked for a session, never woken for plan; `mc goal open` refuses it.
  The runner opens it when every after-goal has landed.
- `open` — picked for a build session. Only plan or a person sets a blocked
  goal open again, after reading the entry, revising GOAL.md if needed and
  writing `Nästa:`.
- `review` — set by a build session; picked for a review session, or waiting
  for the merger once its green is queued.
- `blocked` — set by a session that cannot go on, by a red review, by the
  runner (steps 3, 5, 6) or by the merger on red. Nothing goes back to a build
  session by itself. One blocked by a red review or a red merge waits on plan:
  `mc goal list` says so, and the page leads its row's tail with
  `waits on plan` in the colour of what waits on a person.
- `done` — set by the merger when the pull request lands, or by a person.

## What a goal does not have

- **No steps.** No `PLAN.json`, no `mc step`, no `mc project`. Criteria are text
  in GOAL.md.
- **No register.** mc writes the status line, LOG.md, the current file while a
  session runs, and the `runs.tsv` row. Nothing else.
- **No owner, lease, revision or capability report.** Anyone may work in the
  worktree; the last entry says what was done.
- **No review by its builder.** The review is a session of its own role on
  the review model, never the last build entry's.
- **No merge by a session.** A build session publishes with `--no-merge`; a
  review session publishes nothing. Only a green review, through the runner,
  queues a goal's pull request, and only the head it judged lands.
- **No close-out.** No archive verb; a `done` goal stays where it is.

The headless plan session (`autonomy on`) and phases are not built; they wait
until goal sessions have run for real. The page draws a `PLAN` row already,
from the lane file's `kind`; the runner starts no plan session (goal
`headless-plan`).
