# mc brief — the evaluation and decision session

`mc brief` is the hour Martin sits down. Everything else in mc runs without
him: the runner takes `ready` plans off `queue.md`, opens PRs and merges
them, archives what is done and closes the workarea behind it. None of that
asks a question. The questions pile up anyway — a decision file a step
session could not answer, a project archived with no note, a folder under
`~/mc` no plan explains, a proposal the helper wrote — and until they are
put to the one person who can answer them, they are invisible.

This verb puts them. It is two halves that share nothing but a file:

- **`mc brief --collect`** — a script, no model, that gathers the ground
  into `~/mc/brief/<ISO timestamp>.md`.
- **`mc brief`** — that, and then a fresh foreground session whose first
  words are the file.

It replaced the resident PM and the pm-helper (`~/mc/mc-utredning/utredning-2026-08-24.md`
§9–13, D-0218). Nothing in it is resident: no daemon, no watcher, no inbox,
nothing to wake. The runner does not know it exists and runs whether or not
it is ever called. The code is
[`src/mc/brief-collect.js`](../../src/mc/brief-collect.js) — pure builders
plus one `collectBrief` that touches the machine — and
[`src/mc/commands/brief.js`](../../src/mc/commands/brief.js), which is fifty
lines: collect, then hand the file to `openInWorkArea`.

## What it reads

Thirteen sections, in this order, each from a file something else already
writes:

| section | source |
|---|---|
| Merged since last brief | `gh pr list --state merged --search merged:>=<since>`, per repository |
| Opened, not merged | `gh pr list --state open` |
| Proposals | `~/mc/proposals/*.md`, what `mc helper`'s turn wrote |
| Plan status | every `docs/project/*/*/PLAN.json` on `origin/main` of both repositories |
| Archived without a note | `~/mc/runner/undocumented-closures.md` |
| Workareas with no project on main | `~/mc/runner/unplanned-workareas.md` |
| Plans that do not parse | `~/mc/runner/unreadable-plans.md` |
| Runner | the last 24 h of `~/mc/runner/log/runs.tsv` |
| Production | the last `deployed` row of `~/mc/runner/log/deploys.tsv`, `git rev-list --count <it>..origin/main` in `~/memoro`, the nightly's last measurement, and the `/api/version` in `~/mc/runner/version.json` |
| Held before merge | `~/mc/runner/held.json`, the entries at `repairs >= 1` |
| Ready, and the runner cannot start it | `machineState` (`src/mc/status-collect.js`) over every non-legacy plan: the workarea's `git status --porcelain`, `held.json` whole, `unmergeable.json` whole, the open pull requests, the STOP file — less what `current-<repo>.json` says is running |
| Blocked | the `blocked` steps of the same plans *Plan status* already parsed, plus `staleBlockers` (`src/mc/stale-blockers.js`) |
| Queue | `~/mc/queue.md` |

The two repositories are `~/memoro` and `~/memoro-cli` (`MC_REPOS_HOME`
moves them, `MC_WORK_ROOT` moves `~/mc`). Plans are read off the ref, never
out of a checkout: one `ls-tree` for the names and one `git cat-file
--batch` for every plan's text — the loop this replaced spent a `git show`
per plan, 1.22 s for memoro's 38 against 54 ms for the whole listing.

**"Since last brief" is the mtime of the newest file in `~/mc/brief/`**, and
24 hours when there has never been one. There is no state file: the briefs
themselves are the record of when there was last a brief. The *Runner*
section is the exception and always looks back 24 h — it is a picture of the
machine's day, not of the interval.

**Held before merge** is the one section that carries work rather than
reporting it. `mc run` writes `~/mc/runner/held.json` whenever a landing does
not land, gives such a pull request exactly one repair session, and stops
there; what the repair could not fix is a project standing still — its pull
request is open, so the runner passes it every round — and this is where a
person is told. The brief takes the entries at `repairs >= 1` only: one still
at zero is the runner's next round, and raising it would ask Martin to decide
something a session is about to try. When there is one at all the brief says so
in its opening lines, not only in the section. The three answers the role
allows are in [`canon/roles/brief.md`](../../canon/roles/brief.md): merge by
hand, close, or block the step with a decision.

**Ready, and the runner cannot start it** is the rest of the same waiting.
`held.json` only knows a pull request the gate refused, and a session killed
before it committed never got as far as one: `no-text-in-code` stood from
2026-09-04T12:37Z on exit 143 with 35 files of finished work uncommitted, and
`connections-section` from 2026-08-29T21:37Z on a session that exited 0 and
opened no pull request. Neither was in `held.json`, neither was in *Workareas
with no project on main* — both had a project on main, which is what made them
a loss — and both were skipped every round with one `, skip` line in
`runner.log`. The section asks `machineState` for the same answer the round
refuses on and lists what it refuses: the project, what is in the way, since
when and how long, and the `runs.tsv` row that left it. It is a section of its
own rather than rows in *Held before merge* because the act differs — a held
pull request takes one of that section's three answers, and a workarea takes a
person opening it — and a row under prose that promises the wrong answer is a
row somebody applies the wrong answer to. `prs-unknown` is a fact about a
repository rather than a project, so it is one line per repository. A project
the runner has a live session on is left out: its worktree is dirty because
somebody is working in it this minute, and every row here has to be one a
person acts on — a lane file whose pid is dead is not a live session, and that
workarea is precisely what the section is for.

**And a plan that does not parse is not in it either**, which is correct and has
a cost worth knowing. The section keeps only the refusals whose word is in
`RUN_REFUSALS` — the machine-shaped ones — so `blocked`, `done` and
`unparseable` stay *Plan status* rows, where the plan is the first thing to fix.
`inbox-finish` is what that costs: six files and 165 insertions of apparently
finished work have stood in its workarea since its session was killed at
2026-09-02T20:59:43Z, and no surface names the workarea, because the plan above
it does not parse (measured 2026-09-05). The row that would send somebody there
is the *Plans that do not parse* one.

**Blocked** is the third and largest section of that same family, and the one
that carries the most work. A `blocked` step is a project standing still with
nobody looking: the runner hands out `ready` steps and reads no further, so a
blocker does not flip itself and nothing in mc ever read one a second time
until `staleBlockers` did. Measured on `origin/main` 2026-09-05, **45 steps
were `blocked`** across both repositories and the only trace of any of them was
one clipped `next` cell in *Plan status*.

The section groups by what the reader does next, which is not what
`blocked_by.kind` says. **Named decisions** (5 on 2026-09-05) get a table with
the blocker's full name uncut, because that name is what a session looks the
answer up by; that is the list a brief works through. **`plan-review`** (12,
across six programmes) is a `decision` by kind and a hand-off by meaning — the
park every plan converted to the schema carries until its programme's planning
session reads it — so it is one line per programme ending in `mc plan
<programme>`, and never a question for Martin. **Project blockers** (28, of
which 26 are the sql-readiness families closing in a deliberate order) are
sequencing: the order is the blocking project's design, the section reads it
and never moves it, so they are a count.

Two facts ride along under the count because both were invisible and neither
costs a read. A project blocker whose named project has left `origin/main` is
`staleBlockers`'s answer, reused rather than recomputed so the page and the
brief cannot disagree about which blocking project is gone — and the line says
*is not on main* rather than *is done*, because a project also leaves main when
it is abandoned, and only a person can say which happened. And a blocker name
that is not a name (`NAME_RE`, `src/mc/plan-schema.js`, exported for this one
reader) is neither a live blocker nor a finished one but a plan nothing can
check: `sql-goal1-certification` step 4 waits on a 99-character sentence. It is
reported, not refused — making the schema reject one would make every plan
carrying one unrunnable the moment it landed, which is a separate decision.

The three routes a session takes are in
[`canon/roles/brief.md`](../../canon/roles/brief.md), and so is the one thing
that is new: **the brief may write a plan.** Where the estate already holds the
answer — a decision answered under another name, a blocking project landed — a
brief session sets that step `ready` itself and writes what it read into the
step's `comments` in the same edit. Everything else it only reports.

**Production** is the other section that can end in something being done, and
what it ends in is Martin typing `mc deploy` — never the session, and never the
runner. It carries three readings and no verdict: the last deploy mc made, how
many commits `origin/main` is ahead of it, and whether the nightly ever measured
that tree whole. The role turns those into at most one proposal
([`canon/roles/brief.md`](../../canon/roles/brief.md)); a gap nobody has
measured is a reason not to propose one yet. The same row is drawn on the page's
RUNNER block, and `mc helper` reads it beside `/admin/deploy/logs`, so the three
cannot say different things about what is live.

Two answers are kept apart everywhere. A file the runner has never written
is reported as absent; a file it wrote and left empty is reported as none.
"The runner has not written one yet" is a different thing from "there is
nothing to report", and reading it as the second is how a board looks clean
when nobody has looked.

## What it writes

`~/mc/brief/<date>.md`. That is all.

It used to delete answered decision files too. mc had a decision concept —
`<area>/decisions/*.md`, a `**Beslut:**` line Martin appended, a scan, a
render, a retirement rule keyed on which plans still waited — and all of it is
gone. What is decided with Martin is written into the plan it is about, by
whoever next opens that plan, and a plan comes back to the runner by its first
unfinished step being `ready`. There is nothing left for mc to read, count or
delete.

## The session

The bare verb opens **an ordinary foreground terminal program** — `spawn`
with `stdio: 'inherit'` through `openInWorkArea`
([`src/mc/work-open.js:127`](../../src/mc/work-open.js)) — not tmux, never
`--resume`. Opus by default from the role, `--codex` allowed through the
adapter, the Coding Profile appended, then `canon/roles/_common.md` and the
overlay from [`canon/roles/brief.md`](../../canon/roles/brief.md) — assembled
like every other session's ([`mc-roles.md`](mc-roles.md)) — and the brief file
as the first prompt. NOW says `brief` for exactly as long as it holds the
terminal.

It stands in `~/mc`, the work root, and not in a repository. It writes one
file, `~/mc/brief/<date>.md`, and giving it a worktree would only put a branch
under a conversation that must never commit anything.

The role tells it to take the decisions **one at a time**, each as a
proposal Martin says GO to — never a menu of options, and never a question
it has not read the code behind. If it cannot name one thing to do, the
question is not ready and it says so. Then the two lists the tidying leaves,
one row at a time. It ends when the lists are empty or Martin says stop.

## How an answer travels

Into the plan, and nowhere else.

The brief is where Martin and a session agree what to do. What they agree is
written into `docs/project/<programme>/<project>/PLAN.json` — the contract, a
step, or a step's instruction — and setting the stopped step back to `ready` is
what puts the project in front of the runner again. mc records none of it:
there is no file to write, no line to grep for, and no state to keep in step.

That is a deliberate loss of a round trip. The old shape wrote the answer as a
`**Beslut:**` line in a file mc then parsed, retired and deleted, and the parse
was the whole reason the line had a fixed shape. Removing the reader removes
the shape with it.

### When the brief itself is the writer

One case does not wait for whoever next opens the plan. A blocked step the
brief settles by reading is answered in the session that read it, and that
makes the brief a fourth writer beside the step session, the planning session
and the runner ([`docs/project/README.md`](../project/README.md) § *Who writes
what*). It reaches `main` by a route the role names, because a route that is
not written down will not be taken:

- **One pull request per repository per brief**, not one per unblocked step.
  Every unblocking that brief made travels together and reads as one decision.
- A worktree at **`~/mc/brief/unblock/<repo>`**, on branch
  **`brief/unblock-<date>`**, cut from `origin/main`.
- `gh pr create`, then **`mc merge <repo> <pr> --docs`** — a plan is a file
  under `docs/`, so the docs door lands it with no suite at all and refuses by
  GitHub's own file list if anything outside `docs/` crept in
  ([`mc-merge.md`](mc-merge.md)). Landed before the brief ends, and the
  worktree removed after: an open pull request on a project's plan costs that
  project a round.

Both names are load-bearing and neither is decoration, and both were checked by
running them rather than by reading (2026-09-05, against the real `~/mc` with
the worktree in place). The worktree sits a level below `~/mc/brief/`, where
`areasWithCheckout` and the runner's `workareas()` cannot see it — both list a
top-level directory only when `<area>/<repo>/.git` exists, which is why
`~/mc/plan/` and `~/mc/gate/` are invisible too; with the worktree at
`~/mc/brief/unblock/memoro-cli`, `areasWithCheckout` listed 80 areas and
neither `brief` nor `unblock` was among them. And the branch is not `<project>`
or `<project>-…`, which is the shape `projectForBranch`
(`src/mc/project-prs.js`) claims for a project: against the 46 project names on
main, `brief/unblock-2026-09-05` returned `null` where `brief-blocked-steps-4`
returned `brief-blocked-steps`. A branch of the claimed shape would read as
that project's own work in flight and end its round.

No verb was built for this. `mc unblock <repo> <project> <step>` was the
alternative and was rejected: the route above needs no new code and no new
authority, and a route that has to be built first cannot be walked by the step
that walks it.

## What is deliberately wide

Nothing, any more. The section that stood here explained how loosely a
decision file was recognised — anything under `<area>/decisions/` with a `# `
heading, minus three bookkeeping names — and why the looser rule was worth its
false positives: the narrower one had been hiding unanswered questions from the
only person who could answer them.

That reasoning went with the concept. It is worth keeping the shape of it,
because the same trap is one directory away: `~/mc/proposals/` is now counted
and never parsed, for the same reason. A reader that decides what counts as a
proposal is a reader that can decide wrongly, silently, about a file somebody
wrote for Martin.

## Speed

The whole thing is a script, so it must feel like one. Measured 2026-08-29
against a copy of the real `~/mc` and both real repositories: **1.5 s**
online and **0.2 s** offline, for 51 plans, 15 decision files, 8 proposals
and 72 runner rows.

The network is the cost, and it is spent concurrently: one `git fetch` and
two `gh pr list` per repository, run side by side. Run one after another the
same calls took 10.4 s, which was the plan's entire budget. `--offline`
skips all of them and reads only what is on disk.

## How it is tested

`tests/mc/brief-collect.test.js` covers the parsers on text: decision files
answered and unanswered, the wide heading rule and the bookkeeping names,
`retireDecisions`'s three outcomes (removed, held, orphan), plan
frontmatter including folded scalars, `cat-file --batch` framing on bytes
rather than characters, the runs.tsv window, and both intake tables
including absent-versus-empty.

*Blocked* is driven from one fixture holding one of each — sequencing that is
live, sequencing whose project has left main, the `plan-review` park, a named
decision, and a decision whose name is a 99-character sentence — through both
`blockedSteps` and `renderBrief`: that the group is what the reader does and
not `blocked_by.kind`, that the three counts are right, that the blocker name
is printed uncut, that the hand-off names its programme, and that neither
special case is folded into the list above it.

`tests/mc/commands/brief.test.js` covers the verb: that `--collect` stops
after the file, that the bare verb opens a new foreground conversation in
the work root with the overlay and the brief as its first words, and that the
overlay asks for a proposal rather than a menu. It reads the overlay itself
rather than a copy of it.

**Not measured:** the interactive launch itself. No headless session can
watch a program take the terminal, so what is verified is that the right
argv is built and spawned with `stdio: 'inherit'`; that the session opens
and its first turn is the agenda is Martin's to see, once.
