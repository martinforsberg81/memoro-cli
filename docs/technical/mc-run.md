# mc run — the runner

`mc run` is the one thing that lives all day. It takes the next step of the
next project, in a fresh headless session, and merges the result — and it
does that in a loop until somebody stops it. It was `~/mc/bin/runner.sh`,
some 220 lines of bash calling `claude -p` directly; since 2026-08-28 it is a
verb, so the tool is a per-project choice through the same launch adapter
every other verb uses, the prompts are role files in `canon/roles/`, and the
log is something `mc status` can read.

**The runner decides nothing with a model.** It reads files, runs `git` and
`gh`, starts a session through the adapter and waits for it. It is the parent
of the process it starts, so it needs no inbox, no knock and no watcher to
know whether that process is alive. The model is the step session, and the
step session is the only place a model appears.

The rules that are pure functions of text live in
[`src/mc/run-plan.js`](../../src/mc/run-plan.js); everything that touches a
process is [`src/mc/run.js`](../../src/mc/run.js), where every boundary is a
key on `deps` so a whole round can be driven in a test with no network.

```
mc run [--rounds <n>] [--once] [--no-merge] [--idle-sleep <seconds>] [--no-caffeinate]
```

`--rounds 0` (the default) is forever. `--once` runs one step for the first
runnable project and exits — the way to watch a single step. `--no-merge`
leaves the pull requests open; it is a default-on boolean written mc's way,
not `--merge 0|1`. `--idle-sleep` is how long a round that ran nothing waits
before the next one, 600 s by default.

## The switch

```
mc run start [same flags]   the runner, in the background
mc run stop                 after the round it is in
mc run stop --force         now, and the session it is holding with it
mc run --update             after the round: new code, new process
```

All three orders are **files under `~/mc/runner/`, read at a round boundary**
— never signals, and never mid-session. A runner ninety minutes into a
headless step is given the order without that step being interrupted, which is
the whole reason they are files. `src/mc/run-control.js` writes them and holds
the rules; `runLoop` reads them between rounds.

- **`start`** spawns `mc run` detached with its stdout and stderr appended to
  `runner.log`, carrying whatever flags follow it. It removes the `STOP` the
  last stop wrote — `start` and `stop` are one switch, and a switch that will
  not turn back on is not one — and refuses only on a first runner that is
  still alive.
- **`stop`** writes `STOP`. **`stop --force`** writes it too, and then ends the
  runner now: `SIGTERM` to its process group, `SIGKILL` to whatever is left of
  it two seconds later. The group and not the pid, because the headless session
  is a child of the runner and shares it — kill the runner alone and `claude`
  carries on for another eighty minutes with nobody left to read its output.
  A killed runner never reaches its own `finally`, so `--force` removes the
  `runner.json` and `current-<repo>.json` it would have removed itself;
  otherwise the page draws a step that is not running.
- **`--update`** writes `UPDATE`. At the next round boundary the runner
  fast-forwards the checkout mc is running from, starts a fresh `mc run` with
  the same argument list and the same stdio, and exits. `runner.json` is
  cleared *before* the new process is started, so the two never race for it.
  A checkout that will not fast-forward — local work, or diverged — is said out
  loud and handed over anyway: the restart was asked for. `UPDATE` has one
  other writer, which is not a person: a landing that changed mc's own code
  (see *The merge*). `mc run --update` itself is unchanged by that — it is
  still the order somebody gives, with its own refusals.

**Why `--update` has to exist at all.** Node reads its whole module graph at
process start and never looks at the disk again. The runner merges pull
requests, including pull requests that change the runner, so a runner that has
been up all day is running the code it was started with however much of itself
it has improved since. Measured 2026-08-29, four merged improvements to
`mc run` sat unused for two hours. Measured 2026-08-30, the round that could
first have closed a finished workarea ran for eighteen hours in a process that
started ninety minutes *before* the closing code was merged — so nothing was
ever closed, and no line anywhere said why. New code needs a new process; this
is the order that asks for one at the one moment it costs nothing.

## Staying awake

A run that is not `--once` holds the machine awake for its whole length, and
that is the default rather than a flag to remember: this laptop is set to
sleep after **one minute** of idle on battery (`pmset -g custom`), and a
runner waiting ten minutes between rounds is exactly what that setting is for.
An unattended run would stop without anybody deciding it should.

It is `caffeinate -i -m -s -w <runner pid>`
([`src/mc/stay-awake.js`](../../src/mc/stay-awake.js)) — tied to the process,
never to a clock. A timed assertion is wrong at both ends: too short and the
run sleeps, too long and a laptop is held awake in somebody's bag. Watching
the pid also means nothing has to clean up, including when the runner is
killed by a signal that runs no handler.

What it holds, honestly:

| flag | what it actually does |
|---|---|
| `-i` | idle system sleep — **the one that matters**, and it holds on battery |
| `-m` | the disk idling down under a run that is mostly waiting |
| `-s` | system sleep — caffeinate(8) says this is *valid only on AC power*, so on battery it is asked for and does nothing |

`-d` is deliberately not asked for: display sleep does not stop a process, and
keeping the screen lit all night costs battery for nothing.

**A closed lid still sleeps the machine.** No assertion suppresses it. On
Apple Silicon the ways around it are clamshell mode (external display and
power) or `sudo pmset -a disablesleep 1`, which is machine-wide, persists
until it is changed back, and is therefore an operator's decision rather than
something a verb does on somebody's behalf. `mc run` prints which of these it
got at start, so the limit is read at the beginning rather than discovered as
an empty log the next morning.

`--no-caffeinate` turns it off.

## The round, in order

A **round** is one pass over the queue. A **step** is one fresh headless
session in one workarea, followed by the merge of the pull request that
session opened.

1. **The day's collect**, if it is due: once per calendar day, at the top of
   the first round after 05:00Z. It is not a step and not a project — it opens
   no worktree, touches no branch and calls no model; it reads production and
   writes one digest per repository into `~/mc/intake/`. Its two runs.tsv rows
   (`kind: helper`) are its whole state, which is why a failed collect stays
   unretried for the rest of the day. See [`mc-helper.md`](mc-helper.md).
2. **The inbox, drained**, every round and with no day gate: the oldest files
   in `~/mc/intake/` — the collector's digests and whatever Martin dropped
   there — up to three of them, one headless turn each, every one moved to
   `~/mc/runner/log/intake/<date>/` the moment its turn ends whatever the turn
   returned. One row per file (`kind: intake`, the file in the name column).
   The question here is *is there a file?*, not *has today's collect run?*, and
   the two were one gate until 2026-09-05 — which is how thirteen digests came
   to be waiting in a directory that is supposed to drain.
3. **Read the queue**: `~/mc/queue.md`, then every `PLAN.json` on both
   `origin/main`s, and — once per repository, on the same trip to the network —
   `gh pr list --state open`. That third reading is the round's answer to what
   is in flight, and it is asked *before* anything is started rather than after
   the session. A repository whose `gh` could not answer starts nothing that
   round and says so; the other repository's lane is untouched. An idle round
   costs ten minutes of sleep, a blind one bought a 120-minute Opus session.
4. **Tidy `queue.md`** against that reading, and write
   `~/mc/runner/unreadable-plans.md` from it.
5. **Archive** every plan that says `status: done` — the directory removed and
   a `project_log.md` row left behind it, one PR per repository, landed through
   `mc merge --docs`. See [`mc-tidy.md`](mc-tidy.md).
6. **Run the steps**, one lane per repository at the same time.
7. **Close** the workareas whose project is finished — whose archive PR merged
   in step 5, or whose plan an earlier round already archived, which
   `project_log.md` is what still knows.

Steps 1, 2, 5 and 7 and the tidying half of 4 are skipped under `--once`: that
flag exists to watch one step, and a model turn over production is not what
somebody typing it asked for. The unreadable-plans table is written
either way — it is a write of what the round has already read, not a pass over
anything.

The loop around the round is `runLoop`. It reads `runner.json` before it
writes one, runs rounds until `--rounds` is reached or a STOP file appears,
sleeps `--idle-sleep` after a round that ran nothing, and clears its files in
a `finally` however it ends.

**It refuses to start while another runner is alive**, naming the pid that
holds it and the two ways on — `mc run stop`, `mc run --update` — which is the
same refusal `mc run start` has always made, from the same `readRunner`, so
the two cannot disagree about who is running. It has to be here and not only
in `start`, because on 2026-09-02 two runners were alive in one work root and
handed the same step to two headless sessions in the same worktree a hundred
seconds apart: two agents in one working tree share one `git add -A` and one
branch, and the second session's only safe move was to stand down. `--once` is
refused too — it is a person watching one step rather than an unattended loop,
but the collision is identical. A `runner.json` naming a pid that is *gone* is
a killed runner's leftovers, not a wall: it is cleared, along with the
`current-<repo>.json` files that runner never got to remove, and the loop says
so and goes on. The one start that must not be refused is `--update`'s
successor, and it is not: `runLoop` clears `runner.json` before it hands over,
so the new process reads no holder.

## The queue

`~/mc/queue.md` is Martin's "these first" and nothing else: project names, one
per line, no comments and no headings. It empties itself — a name leaves the
file the moment that project's step has run — so a queue everything ran from
is an empty file. `strictQueue` rewrites it to that shape each round and logs
one line per dropped entry; a name with no plan on main, or whose plan is
`done`, goes now.

What the runner actually walks is `assembleQueue`: the queue file's order
first, then every project with a `PLAN.json` on either `origin/main` that the
file did not name, sorted. A name with no plan on main is not in the queue at
all — it used to be, and the skip line it produced every round was read by
nobody. Such a workarea is surfaced where somebody looks instead: the page's
list of workareas without a project.

## One step

A project is refused in two places, and the order is the whole of what a round
costs: **the plan on `origin/main` decides before anything is touched, and the
worktree decides after.**

### What the plan on main decides

Reading the queue (step 2 of the round) has already fetched every `PLAN.json`
on both `origin/main`s, so *would the runner act on this project at all* is
answered before a lane starts walking. `planRefusal` asks it with `kindFor` —
the same reading the page's NEXT draws its order from — and a name it
refuses never reaches `runStep` and costs no git at all:

| the plan on main says | the lane |
|---|---|
| the first unfinished step is `ready` | goes there |
| every step is `done`, or a step is `blocked` | does not |
| the file does not parse | does not |
| there is no plan | goes there — `assembleQueue` has already dropped the nameless, so this only happens when a plan leaves main mid-round, and `runStep` has the line for it |

This changes what a round *touches*, not which project wins: the order is
still `queue()`'s, and the first unfinished step is still the only step
anything looks at. The filter is re-applied when a lane stays on a project
after a merged step, not computed once for the round — a plan that came good
in that window should not have to wait for the next one — and the same answer
is what makes a lane let go of a project whose merged step left it stopped.
A pending `UPDATE` makes it let go too: the drain is read between rounds by
the lane loop, and inside a round at this one place, so a lane that has just
merged does not chain further steps on its project while the other lanes wait
for the quiet moment.

One thing it deliberately does not answer: a **conflicted merge** left in a
workarea lives where no plan on main can see it. It does not need to be
answered here any more — a conflict is not a kind, it is something a step
session is told about — and a project whose plan is stopped simply keeps its
half-finished merge until the plan is `ready` again, which is the first round
it could have used it in anyway.

Those refusals leave **one line for the round**, counted by reason in the
page's own shape:

```
skipped 36 (blocked 30, unparseable 5, done 1) — the plans that do not parse: …
```

The plans that do not parse are named rather than only counted: that is a
thing somebody must go and fix, and a count of five does not say which five.
It is the round's line and not the lane's — lanes run under one `Promise.all`
and whoever reads `runner.log` is reading a round.

**Why it was worth doing.** `runStep` derives the same answer five pieces of
git work later: `repoOf`, the worktree's existence, `git status`, `syncMain`'s
fetch and merge, and only then the plan in the worktree. It also *creates* a
missing workarea before it reads anything, so every refused project without
one got a worktree made for it every round. Measured 2026-09-02: a real
`mc run --rounds 1` against `~/mc` walked 38 projects in **51 s** and started
none of them, roughly 1.3 s of git each — and 36 of those 38 refusals were
already drawn on the page before the round began.

**And what it costs now.** The same board answered from the plans the round
has already read is **1.2 ms** for all of it — `kindFor` over
`~/mc/runner/plans.json`, measured 2026-09-02T20:03Z. Thirty-six of the
thirty-eight then cost no git at all; the two `dirty worktree` names still
walk into `runStep` and still cost their second or so, which is the point of
them. The live before-and-after of one `mc run --rounds 1 --no-merge` is
deliberately *not* in this note: the runner was up and holding the very
session that wrote it, and a second `mc run` against `~/mc` would then have
spawned step sessions and raced for `runner.json` — it now refuses instead,
which is the same reason there is no live before-and-after here. What is
measured is the round that was slow, and the reading that replaces its 51 s.

**A round is only slow in proportion to how much of the board it cannot act
on.** On 2026-09-02 that was almost all of it: 21 of the 38 waited on
`blocked_by: {kind: "decision", name: "plan-review"}`, which nothing can
answer since the decision concept was removed, and 7 more behind a single
blocked project. A board where most plans are `ready` never paid this cost and
does not notice the change. Read the numbers as the shape of that board on
that day, not as a constant.

### What the worktree decides

Everything that is *not* on any plan keeps its own named line, because nothing
else records it. These are facts about this machine and this GitHub at this
moment:

- the worktree is dirty — usually somebody's unfinished work, about to be
  stepped on;
- a pull request for the project is already in flight (`inFlight`), or what is
  open on GitHub could not be read this round;
- the branch underneath cannot be pushed, or the workarea could not be
  created;
- **the worktree's branch has already landed.** Checked by content
  (`branch-landed.js`), because the runner squash-merges and "ahead by N" says
  nothing. It is moved to `<name>-<n>` from `origin/main` — the smallest `<n>`
  no branch local or remote is using — *before* a session starts, because
  `push-guard.js` would otherwise refuse the push at the end of it and the
  whole session would buy nothing. Asked of every workarea under `~/mc` on
  2026-09-02, 44 stood on a landed branch. A branch that has *not* landed
  carries work and is left exactly where it is;
- `syncMain`'s merge conflicted.

A live tmux session is **not** on that list. It used to be, and it was a
second, undeclared way to stop work — whether a step ran depended on which
terminals happened to be open (Martin, 2026-09-02). A project the runner
should leave alone says so by being `blocked` in its own plan.

Then a missing workarea is created rather than skipped: `mc work add <name>
<repo> <name> --from origin/main`. Then `git merge origin/main` — **never** a
rebase, which is what nights 1–2 of the shell runner cost to learn. Two
conflicts are resolved without a session. One is an identical `.gitignore`
hunk. The other is a **`PLAN.json` whose two sides wrote to different steps** —
29 of the 166 conflicting files measured in `runner.log`, always the same
shape: main carries the plan a later round wrote to, the branch carries the
same plan with its own step edited. `plan-merge.js` merges it from the three
sides git holds in the index while the merge is in progress (`:1:` the base,
`:2:` ours, `:3:` origin/main), by the rule the plan already has about who may
write what: each step goes to whichever side changed it, a criterion is met if
either side met it, and `goal`, `contract`, `out_of_scope` and the criteria
themselves are main's, because a step session may not change them. It refuses
rather than guesses — both sides on the same step, a side that is not JSON, a
step added or removed, or a result `validatePlan` would reject leaves the file
conflicted, with the reason in `runner.log`. What it refuses is left in
progress and handed to the step session: `stepPrompt` puts a preamble above the
body naming the conflicting files, saying the merge stopped there, and saying
it is the first thing the session does and not the job. One session resolves
the merge and delivers the step, and one pull request carries both. If there is
no step to hand it to — a held pull request waiting for its repair, a missing
role, a tool that is not installed, a branch whose own plan is the conflicted
file and carries no step — the merge is aborted and the project skipped with
the conflicting files named, because a merge nobody is handed is a merge nobody
finishes. That workarea is then written into `~/mc/runner/unmergeable.json`, so
it reaches a person: `git merge --abort` leaves the worktree *clean*, and
without the record the only trace is one `runner.log` line per round.

**A project's branches are `<name>` or `<name>-<suffix>`.** That convention is
what lets a pull request be matched back to a project at all, and rule 5 is
what makes it true rather than hoped for: `projectForBranch` takes the longest
project name the branch equals or begins with followed by a hyphen — longest,
because `mc`, `mc-cut`, `mc-log` and `mc-test` are all project names and
`mc-cut-2` must not resolve to `mc`. A pull request on a differently named
branch is invisible to this, and there is no second rule for a case nobody has
seen: every open pull request on 2026-09-02 followed the convention.

### Which copy of the plan the round reads, and when

**And then `runStep` reads the plan again**, out of the worktree, after that
merge. This is not the same reading twice over. The plan on main was read to
decide *whether to start*; the plan the worktree carries is what decides *what
to do*, and the two can differ by exactly one merge — `syncMain` may have just
brought a newer plan down. It is also the file the step session will edit, so
it is the one that must be obeyed. The cheap reading gates the walk; the
expensive one holds the decision.

Which is why *which copy* is a rule and not an accident. **What a planning
session and the runner share is a `PLAN.json` on `main`, and nothing else**
([`docs/project/README.md`](../project/README.md), § Who writes what) — so the
step a round hands out is the step main names, and `planOf` (`run.js`) has
exactly one exception:

| the state of the workarea | the copy the round reads | why |
|---|---|---|
| no merge in progress | the file on disk | the workarea stands on `origin/main`, so the file on disk *is* main's copy |
| the merge stopped, but not on the `PLAN.json` | the file on disk | git merges the files it can, so it has **already written main's plan into the worktree** — the conflict is elsewhere |
| the merge stopped *on the `PLAN.json`* | `git show HEAD:<plan path>` | the file on disk carries conflict markers and parses as nothing; HEAD is the last copy of it that is a plan at all |

So `fromHead` is `conflicts.some(isPlanPath)`, never `conflicts.length > 0`.
That distinction is the whole of ruling 10 (`docs/project/mc/rulings.md`), and
it is written here because the wrong version of it was documented, deliberate
and wrong at the same time: the docstring argued that "HEAD is the branch's last
good copy", which is true of a conflicted plan and false of every other
conflicting file, while the condition it sat on fired on any of them. Measured
over the whole of `runner.log` to 2026-09-05: **207 rounds reached a conflict,
180 of them (87 %) with no `PLAN.json` among the conflicting files**, and every
one of those 180 was handed the branch's plan when main's was on disk beside it.
`docx-editor` reported *"step 17 is blocked on decision docx-ime-input-source"*
for 13 consecutive rounds about a step main had re-planned the evening before,
and the only conflicting file was a technical note.

The third row is the case that survives, and it survives on its own merits: a
plan that will not parse cannot be read from disk, and the session handed that
merge needs a plan to work from. Its residue is known and is not this rule's to
fix — HEAD there is not "the branch's last good copy" so much as the copy that
lags, and a step it says is `blocked` may be `done` on main (`sdk-artifact-storage`,
13 of the 27 plan-conflict rounds). What that costs is now visible rather than
silent: the round refuses such a project as `unmergeable` and records the
workarea, instead of reporting whatever the stale plan said.

A step session's own edits to its plan in its worktree are untouched by all of
this. This is about which copy the *round* reads to decide what to hand out —
not about what the session then edits, or what its pull request carries.

`chooseKind` is the whole of what a project gets:

| state | kind |
|---|---|
| an open pull request | nothing, one line naming it |
| plan says `status: ready` | `step` — with the conflicting files in its prompt if a merge is in progress |
| plan says anything else | nothing, one skip line |
| the plan does not parse | nothing — and a row in `~/mc/runner/unreadable-plans.md` |
| no plan in the worktree | nothing, silently |

There is no `triage` and there never will be again: the runner runs plans, it
does not write them. Planning is `mc plan <programme>`, a foreground session
with Martin in it, and it happens somewhere the runner cannot reach —
`~/mc/plan/<programme>/`, not a workarea (see [`mc-plan.md`](mc-plan.md)). What
the two share is a `PLAN.json` on `main`, and nothing else. And a stopped step
is simply not `ready` — the runner never read decision files, counted them, or
started a project because one was answered, and there are none to read now. A
plan comes back by being set `ready`, which is the job of whoever
applies the answer.

### The two readings, and what each answers

The round is not the only reader of those two refusals, and since 2026-09-05 it
is not the only one that gets both. **There are two readings of "can this
project be worked on now", they answer different questions, and neither can
answer the other's:**

| | `planState` / `kindFor` | `machineState` |
|---|---|---|
| the question | is this plan ready to be worked on? | would the runner start it now? |
| what it is a fact about | a file on `origin/main` — the state of the first step that is not `done` | this machine, at this moment |
| what it sees | `ready`, `blocked` and what on, `done`, a file that does not parse | the STOP file, a dirty worktree, a merge stopped in one, a workarea an earlier round could not bring to `origin/main`, a held pull request, work in flight, a branch the workarea does not have |
| what it costs | nothing — the round has already read the plans | one `git status --porcelain` in the workarea, and only where the plan does not already refuse |
| where it lives | `plan-schema.js`, flattened by `kindFor` (`status-collect.js`) | `machineState` (`status-collect.js`), beside it |

A plan can be `ready` for days while nothing can start it. On 2026-09-05 both
of memoro-cli's unfinished plans read `ready` in every surface a person uses
while `held.json` held #612 and #614 and the whole queue was stopped; the one
place that knew was `runner.log`, which carried 9 827 `, skip` lines. That is
what the second reading is for — not that the log said it badly, but that
nothing else said any of it.

`machineState` asks the reasons in `runStepClaimed`'s own order, because the
answer has to be the first thing the round would hit and not merely some true
thing: a project that is both dirty and held reads `dirty`, which is what a
person has to deal with first. It starts nothing, writes nothing and fetches
nothing — its `git` is only ever given read-only arguments — and it asks the
plan first, so a project the plan already refuses costs no git at all. That is
`planRefusal`'s economy above, applied to the reading.

**The two cannot drift, and that is asserted rather than hoped for.**
`RUN_REFUSALS` (`run-plan.js`) is the shared vocabulary: every word a round
refuses on for a reason that is not in the plan, in the order it asks them.
`runStepClaimed` returns `skipped:<reason>` through one `refuse()` helper and
the reading answers in the same words. Three tests in `tests/mc/run.test.js`
hold them together — a table of thirteen cases driven through both the round and
the reading over one fixture, a coverage test asserting every word in
`RUN_REFUSALS` has a case, and a source check that no refusal returns a bare
`'skipped'` (the lane claim in `runStep` is the one exception, and it is a fact
about this process rather than about the files). A reason added to
`runStepClaimed` without the reading fails the suite.

Four of the words carry `read: false`, and there the reading answers *runnable*
rather than guessing: `worktree`, `sync`, `role-missing` and `tool-missing` are
each the outcome of work the round does and the reading may not do — creating a
worktree, fetching and merging, reading a role out of a worktree it has just
synced, spawning a tool. So **`runnable: true` means nothing on this machine is
standing in the way, not that the round is guaranteed to start**: `mc status`
cannot know a fetch will fail.

Two things are deliberately absent. A **repository lease** is not read: a lease
held by a gate round or a deploy is a reason a round waits rather than a reason
a project cannot run, it is gone within minutes, and reading it would make
`mc status` flicker. And a **merge left in a workarea** is reported as `dirty`
rather than as a word of its own, because that is what the round does with it —
an unmerged path makes `git status --porcelain` non-empty and the round skips
there, before any of its own merge work. The two are told apart in the sentence
(`a merge stopped in …` against `uncommitted work in …`) and not in the word,
because a word of its own would be one the two readings could disagree about.

A merge the round **aborted** is the opposite case and does have a word,
`unmergeable`, and it is the one word the reading answers out of a file rather
than out of the machine as it stands. `git merge --abort` leaves the worktree
clean, so a second later there is nothing here to see: `git status --porcelain`
says nothing, and every surface would call the project runnable while the round
conflicts and aborts again ten minutes on. So the round writes what it did —
`~/mc/runner/unmergeable.json`, one entry per workarea with the files and a
`since`, in the shape `held.json` already has — and the reading reads it. Its
own merge cannot be predicted; its outcome can be recorded.

**Which surface says which**, so that a bare `ready` can be read for what it is
wherever it is met:

| surface | what it says |
|---|---|
| `mc status <name>` | both, on one row — `ready · #614 is held before merge after a repair (since 09-03 10:00Z)`, and bare `ready` when this machine has nothing to add ([`mc-status.md`](mc-status.md)) |
| the page's NEXT (`mc`) | both — a skipped name is counted under its machine word, and a runnable name is drawn as the kind the runner would actually start, `repair` where a hold is owed one |
| `mc brief --collect` | both, in a section of its own — *Ready, and the runner cannot start it*, one line per project with what is in the way, since when, and the `runs.tsv` row that left it ([`mc-brief.md`](mc-brief.md)) |
| the page's PROGRAMMES rows, `mc status`'s step rows, the brief's *Plan status* | the plan alone, and that is right: they are about what the plan says |

### The session

Fresh, headless, and assembled from the plan's own frontmatter
(`sessionSettings`):

- **`tool:`** — `claude` by default, resolved through `resolveLaunch`. A tool
  that is not installed is a skip with the adapter's own hint.
- **`model:`** — `opus` by default, and that default belongs to claude alone.
  `opus` is a claude alias; handed to `codex -m` it names a model that tool
  does not have and the step dies on its argument list before reading a word
  of the plan. A plan on another tool that names no model gets none, and the
  tool picks its own.
- **`budget_minutes:`** — the wall-clock cap, ninety minutes, by default.
  The child is killed at the cap and the row says `timeout`.

The prompt body is the PLAN.json itself, wrapped in `stepPrompt`: you are in
this workarea, do the step named in `next:`, its "done when" is your success
criterion, say in the PR body how you verified it, and — if the Contract must
change — stop with the step `blocked` and say so in the PR. It ends "Do not merge.
Do not ask questions. Stop when the PR exists."

Around that body go the Coding Profile, `canon/roles/_common.md` and
`canon/roles/step.md` — assembled by `instructionsFor` and passed through the
channel each tool already has, with nothing written into the worktree to carry
them. How that is found and joined, for every session and not only this one, is
[`mc-roles.md`](mc-roles.md).

The two argument lists are the only place the tools differ:

```
claude  -p <prompt> [--model …] --permission-mode auto \
        --append-system-prompt <instructions> --output-format json
codex   exec --json --sandbox danger-full-access [-m …] \
        -c instructions=<instructions> <prompt>
```

`danger-full-access` and not `--full-auto`, deliberately. `--full-auto` is
codex's workspace-write sandbox: no network, so no `git push` and no `gh pr
create`, and no writes outside the working directory — which takes the commit
too, because a workarea's `.git` is a file pointing into the main checkout's
`.git/worktrees/<name>`. A codex step under it could never reach the last
sentence of its own prompt. The claude lane is `--permission-mode acceptEdits`
— it was `auto` until 2026-09-03, and auto routed every Bash call through a
classifier and told the session to work through Bash rather than the native
tools: over 59 step sessions that was 5 598 Bash calls against 255
`Read`/`Grep`/`Edit`/`Write`, most of them a screen of a file at a time, and
about half of every step's turns (`docs/project/mc/step-parallelism/measurements.md`).
Either way **the workarea is the boundary the runner trusts**, not a sandbox
inside it, and both tools are given the same. The session's Bash also gets a
ten-minute ceiling (`BASH_DEFAULT_TIMEOUT_MS`), so a suite run is one call
rather than a background job polled in two-minute `sleep` loops.

### The merge

**The runner lands through `mc merge` and nothing else** (Martin, 2026-09-02).
`repo-merge.js`'s round, called in this process rather than shelled out to,
because the runner *is* mc: it takes the repository's lease and holds it across
the whole round, runs the gate inside it, re-checks that the base has not moved
between the measurement and the merge, squash-merges, and reports what it
landed in.

There is no `gh pr merge` left in `run.js`. What it replaces squash-merged
whatever the branch's pull request was after waiting for `mergeable`, so a step
landed without the gate at all — and it never read the base it landed on: on
2026-09-02 at 13:00 that squashed #11250 into `msr-track-3-capture-command`,
the branch of #11249 the runner had left open eighty minutes earlier, logged
`success,merged`, and `main` received nothing.

So the two fields the runner reads back are **`merged_into`** and
**`off_default`**, never its own "the call returned zero":

| what the round reported | the row says |
| --- | --- |
| merged into `main` | `success,merged` |
| merged into anything else | `success,off-main` — not a merge this counts |
| the gate went red | `success,open,gate-red` |
| the round stopped for another reason | `success,open,gate-<why>` |

A red gate is not a failure to work around. The pull request stays open, and
the open-pull-request rule above then keeps that project from starting anything
else until somebody has dealt with it.

The gate costs a round — 20–35 minutes on memoro — where the old merge cost
seconds. That is the price of the contract; `land_seconds` in runs.tsv is
where it shows, kept apart from the session's own `seconds`.

The **archive** pull request is the one exception in kind, not in door: it
removes a plan directory and adds a `project_log.md` row, so it is
documentation by construction and lands through `mc merge --docs`, which
checks that against GitHub's own file list and refuses anything touching a
line of code.

**A landing that changed mc's own code hands the runner over to it.** When the
gate lands a pull request, the runner asks GitHub which files it changed — the
same question `--docs` asks, and for the same reason: the gate's report lists
the *test* files its selection ran, and a local diff is only as fresh as the
checkout. If any of them is under **`src/mc/`** or **`canon/`**, the runner
writes `runner/UPDATE` itself, and the round-boundary reader in *The switch*
fast-forwards and hands over. Nothing else about the handover changes: it
happens between rounds, never mid-session, and one file is written however many
of mc's own pull requests the round landed.

Those two trees and no others. `src/mc/` is the runner — node read its module
graph at process start, so a merge of `plan-schema.js` changes nothing about
the process that merged it — and `canon/` is the roles it quotes into the next
step's prompt. A change to `tests/`, `docs/` or `scripts/` cannot make the
running runner wrong, and a handover costs a fresh process; widening this to
"the repository" would hand over after most memoro-cli landings. The archive
door cannot trigger it at all: `--docs` refuses anything outside `docs/`, and
neither of these is under it.

A **stack** needs an order rather than a call — `mc merge` refuses a batch
aimed at several bases. `stackOrder` in run-plan.js is the whole decision, over
the list of open pull requests the round already fetched: exactly one aimed at
`main` is the bottom, and every other one must be aimed at the head of exactly
one of the others. Land the bottom, `gh pr edit --base main` the one above it,
`git rebase --onto origin/main <where it left its old base>` — a squashed base
leaves every branch above it conflicting even when its author did nothing
wrong — and land that. Two aimed at `main`, a fork, a cycle, or a base that is
nobody's head is not a stack the runner understands: it lands none of them and
says so. A rebase that conflicts is aborted, the files are named, and the round
stops on that project.

Merge direct is the policy for both repositories (Martin, 2026-08-25). The
runner does not review; `mc brief` is what shows Martin what merged.

A project whose step merged **keeps its lane**: the plans are re-read and, if
it is still `ready`, its next step follows at once rather than a whole round
later, up to eight times. A six-step plan would otherwise have taken six
rounds of twenty projects.

### Held before merge

A landing that does not land leaves a pull request open, and an open pull
request stops its project: `inFlight` refuses it every later round. Until
2026-09-04 the only trace of *why* was a `runner.log` line and a runs.tsv note
— `success,open,gate-red`, `plan-trespass`, `open,not-a-stack`. Counted over
2026-09-03..04: of 55 step rows seven ended that way, and each of those seven
projects stood still until a person read the log, found the reason, fixed the
branch by hand and typed `mc merge`.

So the runner writes the fact down. **`~/mc/runner/held.json`** is one entry
per pull request it would not land — `{ project, repo, pr, branch, reason,
note, since, repairs }`, and, when a gate held it, `red` (every red test by
name) and `gates` (`{ name, output }` per failed command gate, clipped at
`OUTPUT_CAP`). It is mc's own state beside `runner.json` and
`current-<repo>.json`, **never a status in a `PLAN.json`** — the runner does
not write plans, and `ready`/`done`/`blocked` are still the whole of
`STEP_STATUSES`. The rules are pure in [`src/mc/held.js`](../../src/mc/held.js);
`run.js` reads-changes-writes the file whole through `hold()`, `countRepair()`,
`release()` and `reconcileHold()`, because any lane may hold a pull request
while another is landing one.

`repo` is part of the identity, not decoration: two repositories number their
pull requests independently, so memoro #9 and memoro-cli #9 are different
work and a release keyed on the number alone would drop the wrong entry.

**Two birthplaces.** `landPr`'s `else` — the gate went red, the round stopped,
the stack was not one — writes the round's own `reason` plus what
`holdDetails(report)` took off it. The report is the only place a command
gate's output ever exists: `gate-rounds.jsonl` keeps the red names capped at
forty and no output at all, and the report itself lives in memory for the
length of that round, so it is read there or it is lost. The other is
`runStep`, when a session ends with a pull request open and a note that is
neither `success` nor `quota` (`holdsAfterSession`) — a `plan-trespass` with
its problems named, a session that timed out with its work pushed, a tool that
printed no result.

**One death.** An entry leaves when its pull request is no longer open. `landPr`
releases what it lands, and `queue()` checks the file against the open list
the round has already fetched, so a pull request somebody merged or closed by
hand leaves by itself with a line saying so. A repository `gh` could not be
asked for is *unknown* rather than empty: nothing of its is dropped on a bad
network.

**Then one repair.** Before `inFlight` refuses the project, the round asks the
file. A held pull request with `repairs: 0` is not work in flight — nothing is
going to finish it — so the project gets a `repair` session instead of a skip:
in its own workarea, standing on the entry's branch (a repair never calls
`freshBranch`; that branch carries the work), told the pull request, the
branch, the reason, every red test by name and every failed gate's output
(`repairPrompt`, `canon/roles/repair.md`). It makes the branch green and
pushes to the same branch — the runner lands it afterwards through the same
`landPr` — or it sets its step `blocked` with a `blocked_by` and says what the
answer is about. It never merges, never lowers a threshold, never deletes a
test to pass: the gate decides and the repair obeys it. A repair never runs
in a worktree with a merge in progress — a conflicted `git merge origin/main`
is aborted, the project skipped, and the pull request still held the next
round; the merge is not the repair's job.

The repair is counted **before** the session starts, not after. A repair killed
on its budget still had its turn, and a count written afterwards would hand the
next round a second one for the same pull request.

A repair of a `plan-trespass` is judged against the plan on **origin/main**,
not the plan in the worktree: the worktree's plan already carries the trespass,
so judging by it would call the trespass repaired the moment the session
touched nothing more, and the runner would land what it refused an hour
earlier. `repairBaseline` picks the baseline and `stepOfPr` the index — the
step that names this pull request, or the deliverable one before that edit has
landed. An ordinary repair is judged against the worktree's plan, so a repair
that oversteps is held again like any step.

**And then it stops.** `repairs >= 1` is a skip again, with the line `#N is
held before merge after a repair — the brief's`. No loop: a pull request its
one repair could not save is a person's decision, and it reaches Martin in
`mc brief`'s *Held before merge* section — merge by hand, close, or block the
step with a decision, one proposal each (see
[`mc-brief.md`](mc-brief.md)). Between briefs it is on the page: NEXT draws
`held before merge N` with project, pull request and reason under it, and
`mc --json` carries `next.held` whole (see [`mc-ui.md`](mc-ui.md)).

One gap worth knowing: `planRefusal` passes over a project whose plan on
`origin/main` is blocked, done or unparseable *before* `runStep` is reached, so
such a project's held pull request gets neither a repair nor a line in
runner.log. It is still in `held.json`, which is why both the page and the
brief read the file rather than the log.

## Lanes

Since 2026-08-29 a round drives **one lane per repository at the same time**.

A round used to be one step at a time, so it was as slow as memoro and
memoro-cli together, even though their steps never touch: different main
branches, different worktrees, different pull requests, and the runner merges
without a shared suite gate. Two lanes make a round as slow as the slower
repository.

There is nothing new to type. `mc run` is the same command with the same
flags; a round with only one repository holding ready plans is one lane and
behaves exactly as it did before — it does not even log the word `lanes`.

**A lane owns one repository, and everything that repository's steps touch.**

- **Its slice of the queue.** `splitLanes` groups the queue's names by the
  repository each project lives in — an existing workarea decides it, and a
  plan on main decides it when there is no workarea yet. Martin's order holds
  *within* a lane. A name whose repository cannot be told rides in a lane of
  its own, where `runStep` says so and skips it.
- **Its own steps, one at a time.** `runLane` walks its names in order.
- **Its own mid-round re-read.** That re-read fetches one repository
  (`queue({ only })`), so two lanes never run `git fetch` in the same checkout
  at the same moment.
- **Its own rows.** runs.tsv rows and runner.log lines are appended whole and
  prefixed by project name, so two lanes writing at once interleave by line,
  never within one.

**Since 2026-09-03 each lane runs its own rounds.** Until then the two lanes
ran under one `Promise.all` and a round ended when both had: memoro-cli's lane
sat idle for hours while memoro's walked thirty names, and a memoro-cli step
that became ready in that time waited for a round boundary nobody needed. Now
the unattended loop (`runLoop`, `rounds === 0`) runs one loop per lane, each
calling `round({ only: repo })` and sleeping on its own clock; the chores a
shared round did around its lanes — the collect, the drain, `tidyQueue`, the
unreadable plans, archiving, closing workareas — run in `chores()` in a loop beside them,
from the whole queue. `--rounds N` and `--once` keep the shared round, for a
person watching one.

**And a repository may have more than one — `mc run lanes <n>`.** The count
lives in `~/.memoro/mc/lanes.json` (`lane-count.js`), 1 to 8, default 1, read
once at start; a running runner takes a new count on `mc run --update`. With
n above one, n loops run on each repository and each takes every nth name of
that repository's queue from its own index (`round({ lane, count })`), so two
never hold one project and Martin's order still holds within each. Each has a
current file of its own — the first keeps `current-<repo>.json`, the rest are
`current-<repo>-<k>.json`, and the page reads them by name. What they share
is the repository's main, and that is where two steps meet: **a landing that
finds the gate lock or the repository lease held waits for it** — `landPr`
asks the merge round again every 30 s for up to 45 minutes — instead of
logging `left open` and parking the project behind its own pull request,
which is what a refused round did until 2026-09-03. The lock and the lease
themselves still refuse: one suite at a time is the guarantee, and it is the
caller that learnt to wait.

**And the machine has a number of its own — `mc run lanes --total <n>`.** It
lives beside the first in the same file, and the two are not the same kind of
thing. `per_repo` bounds how many steps share one `main` — where two landings
meet at the gate — and is a correctness number. `total` bounds this machine
across every repository at once: CPU, memory, API quota, and how much of a
fleet one person can follow. `lanes 3` on two repositories is six sessions,
and until 2026-09-05 nothing in the code objected. **A count of sessions is a
proxy for load, not a measurement of it** — memory and quota are the honest
measurements and neither is read.

Each is absent on its own terms and the file may hold either alone. An absent
`per_repo` is 1, an absent `total` is no cap, and a machine with neither set —
which is what `~/.memoro/mc/lanes.json` held until 2026-09-05 — runs one lane
per repository, two sessions, exactly what it ran before the total existed. Set,
both bind and the smaller wins: `per_repo`
structurally, because there are that many lane loops per repository, and
`total` as an in-process claim each lane takes at the last moment before it
launches a session (`takeSlot`/`waitForSlot`, run.js) and drops in the same
`finally` that removes its current file. It is a claim rather than a count of
`current-*.json` because a file is written after a step begins, and two lanes
counting files in the same tick would both see the same free slot. A lane with
no slot polls every 15 s and says one line when the wait begins, and gives the
wait up on STOP or UPDATE — the drain promises that from the moment UPDATE is
read no lane starts a step. There is no ordering rule between waiting lanes:
whoever polls first wins, so a busy repository can hold the machine while a
quiet one waits. That is measured, not designed, and it is the thing to watch
first if a cap turns out to starve one side.

**Which pair is chosen decides whether that hazard can bite at all**, and this
is the one arithmetic worth knowing about the two numbers together. `per_repo`
is structural — there are exactly that many lane loops per repository, so one
repository can never hold more than `per_repo` slots — while `total` is one
counter for the machine. With two repositories, whatever one of them holds, the
other always has at least `total − per_repo` slots it cannot be shut out of.
`per_repo 3, total 3` therefore guarantees a repository nothing: memoro can
hold all three and memoro-cli waits for as long as memoro has steps, which
with 46 memoro step runs against memoro-cli's 10 since 2026-09-02 is most of
the time. `per_repo 2, total 3` guarantees each of them one, with no ordering
rule and no scheduler. A `total` at or below `per_repo` is the first thing to
look at when one side is being starved.

**This machine runs `per_repo 2, total 3`**, set 2026-09-05 as
[ruling 14](../project/mc/rulings.md) — the pair that lifts the interim
`per_repo 1` and still leaves memoro-cli a slot memoro cannot take. Measured
from `runner.log`'s own start lines over the first 12½ hours under it
(2026-09-06T02:28Z on): 40 step sessions, **never more than three at once**,
three of them at once six times and 4 % of the window; the same reading of
2026-09-04, before the total existed, has six at once. No lane has yet had to
wait for a slot — there is not one `steps in flight on this machine` line in
the log — so the ceiling is measured and the waiting is still only tested.

What the total does not bound is worth knowing before it is trusted as a load
guard. It counts **steps**, taken by a lane: the chores beside the lanes — the
helper turn, the intake drain — spend sessions of their own and take no slot,
and neither do `mc test`, `mc merge` or anything a person starts. And the
counter is one runner process's own, so a second `mc run` on this machine has a
second counter and the two do not see each other. One unattended runner is the
case this is built for; `mc run --once` beside it is not capped against it.

`mc run lanes` with no argument prints both numbers and how many steps are in
flight while it is read — `3 per repository, 3 in total — 2 in flight`, or
`1 per repository, no total cap (up to 2 across 2 repositories) — 0 in
flight`, because a line that names only the per-repository number is the line
that produced the wrong picture in the first place. `mc run lanes <n>` sets
the per-repository number as it always has, `--total <n>` sets the machine's
without touching it, `--total none` takes the cap off, and both may be given
in one command — each is checked before either is written. A total at or above
`per_repo × repositories` can never refuse a lane a slot, and the verb says so
rather than letting an operator believe they capped anything.

### Why the session is spawned, not `spawnSync`

`mc run` used to start the headless tool with `spawnSync` and block. Two lanes
in one process cannot overlap behind a call that holds the event loop for the
whole budget — ninety minutes, by default — so the second lane would never
have started at all.

`deps.session` returns a promise: `spawn` with stdin closed (`claude -p` reads
a piped stdin and would eat it), a wall-clock `timeout` after which the child
is killed and the step logged as a timeout, and stdout/stderr collected here
rather than by `maxBuffer` — capped, because a session that floods stdout will
not parse as JSON either way.

## What the runner writes

Everything lives under `~/mc/runner/`.

- **`log/runs.tsv`** — one row per step, repair, collect and drained inbox
  file, and the
  history keeps the kinds the runner no longer produces:
  `ts name kind exit seconds pr turns input output cache_read cache_write
  session note land_seconds`. `seconds` is the session; `land_seconds` is the
  gated round that followed it, `-` when there was none. It is appended rather
  than placed beside `seconds` because the header is written once, when the
  file is created, and a column inserted would shift `note` one to the left for
  every reader of the old header. The usage columns come from claude's `--output-format json`
  and from codex's `exec --json` event stream; a field the tool does not give
  is `-`, never a guess. `exit` and `note` are independent and are allowed to
  disagree — a process can fail after a session that reported success, and
  both are recorded. **A `plan-trespass` on a step that changed the runner's
  own rules is worth checking before it is believed.** The boundary is judged
  inside the same round by the code the process started with, so a step that
  merged a new `plan-schema.js`, prompt or `unauthorisedChanges` is measured
  against the old one: on 2026-09-02 a step migrated every plan on both mains,
  the runner re-read them with the schema it was holding, they did not parse,
  and the row said `plan-trespass` against a session that did nothing wrong.
  The handover above is what keeps the *next* round honest; it cannot save the
  round that produced the change.
- **`log/runner.log`** — the line-by-line narration, also on stdout.
- **`log/<name>-<ts>.json`** and `.json.err` — what the session actually
  printed, kept whole.
- **`runner.json`** stays one per machine: a runner is here, and this is the
  pid to test for life. Every start reads it first, so it is a claim that is
  checked rather than one that is only made.
- **`current-<repo>.json`** — one file per lane, existing exactly as long as
  that lane's session does. It carries the project name, kind, repo, tool,
  model, budget, start time, the runner's pid and the worktree, and it is
  written immediately before the session starts and removed in a `finally`
  however that session returns, so a step that throws still clears it.
  Readers — the page's NOW block, `mc status <name>` — glob
  `current-*.json` rather than opening one fixed path, which is why NOW is a
  list of lines and not a line.
- **`held.json`** — every pull request a landing did not land, with the reason
  and how many repairs it has had. One file for the machine, written by
  whichever lane held or released something; see *Held before merge*.
- **`unmergeable.json`** — every workarea a round could not bring to
  `origin/main`, with the files the merge stopped on and a `since`. Written
  where the round aborts a merge nothing could be handed, dropped the round
  that workarea takes main. It exists because `git merge --abort` leaves the
  worktree *clean*: without it, the only trace is one `runner.log` line per
  round, and `docx-editor` produced thirteen of them on 2026-09-05 while every
  surface called the project ready. `machineState` reads it, so a stuck
  workarea is a row in `mc status <name>` and in the brief's *Ready, and the
  runner cannot start it* rather than something only the log knows.
- **`log/closed/<name>/`** — whatever a closed workarea kept beside its
  checkout. Moved, never deleted.

Three more files sit beside them, and are the runner's questions for Martin
rather than records of what it did — `mc brief --collect` is their only reader
and renders one section each. `undocumented-closures.md` is appended when a
project is archived with `doc: none`; `unplanned-workareas.md` and
`unreadable-plans.md` are rewritten whole every round, so a folder that got a
plan and a plan somebody fixed each leave their list by themselves.
`unreadable-plans.md` (`plan-intake.js`) is the newest of the three and exists
for the same reason as the other two: the runner can hand out no step from a
plan the schema refuses, and what its author meant to say is not mc's to guess.
It used to be a `runner.log` line, which is where `new-user` sat for a day.

They were written to `~/mc/intake/` until 2026-09-04. That room is an inbox
somebody drops one file into and a turn drains — and two of these three come
back whole every round, so a turn that read one and filed it away would find it
there again the next round, and the round after, forever. They are the runner's
own output about its own rounds, so they live with the rest of it. The path is
spelled once, in `src/mc/paths.js`, for the runner that writes it and the brief
that names it to a person.

## Sleeping and stopping

- **`~/mc/runner/STOP`** — checked at the top of every step and between the
  steps of a lane, so it ends *both* lanes after the step each is in. Neither
  lane abandons a session that is already running, and the runner refuses to
  start at all while the file exists. Written by `mc run stop`, removed by
  `mc run start`.
- **`~/mc/runner/UPDATE`** — read between rounds only, and answered by a
  handover rather than an exit. Written by `mc run --update`; see *The switch*.
- **The Claude quota.** The 5-hour limit is one budget for the whole machine,
  so a quota answer in either lane pauses both. The lane that sees the refusal
  calls `quotaPause`, which logs `every lane sleeping 30m` and holds one
  promise; the other lane awaits that same promise in `quotaHold` before it
  starts anything — before a worktree is touched or a session is spent. One
  sleep, not one per lane, and no session spent to be told the same thing
  again.
- **What counts as a quota answer** is narrow on purpose: the limit text as
  the *whole result* of a session of one or two turns. Session prose that
  merely mentions a quota — a PR body about quota rows, say — is not one. On
  2026-08-29 the broader test slept 30 minutes and left a finished PR
  unmerged.

## What runs beside it

Nothing, and that is the point. There was a shell supervisor — it fetched,
fast-forwarded `~/memoro-cli`, ran `mc run --rounds 1` and slept — written on
2026-08-29 because `mc run` had no way of its own to pick up a merge of its
own code. It has one now: **`mc run --update`**, read at a round boundary,
which fast-forwards that same checkout and hands over to a fresh process. See
*The switch* for what it does and why node's module graph makes it necessary.
The script was deleted on 2026-09-03 with nothing running it — no process, no
tmux server, no reference in `src/`. A supervisor outside the product is a
second thing to start, stop and remember, and mc's own state files know
nothing about it.

## How it is tested

- `tests/mc/run-plan.test.js` — the rules with no process at all: queue
  assembly and tidying, `chooseKind`, the headless argument lists, the reading
  of a session's output, the runs.tsv row, `sessionSettings`, `helperDue`.
- `tests/mc/run.test.js` — whole rounds against fake git, gh, tmux and session
  deps, asserting what only concurrency can produce: a memoro step and a
  memoro-cli step in flight at the same moment, both lanes' current files
  present together, the queue split with Martin's order intact, one repository
  still logging no lanes line, exactly one sleep for a quota answer seen in
  one lane, and STOP ending both lanes after one step each.
- `tests/mc/run-codex.test.js` — the codex lane on `realDeps`: a real git
  repository with a real origin, a real worktree whose `.git` points outside
  it, a real spawned process, and a stub `codex` on PATH answering in codex's
  `exec --json` event stream. It proves mc's half — the argument list mc
  builds is the one the process gets, the instructions arrive on
  `-c instructions=`, the event stream is read into the usage columns, and the
  row and the launch line are written. It cannot prove the real codex accepts
  those arguments; codex is not installed on this machine, and that is one
  live step away from being known.
- `tests/mc/run-doc.test.js` — this note, pinned: every constant the prose
  states is read back out of it and compared with the export it describes.

## What the era measured

`scripts/measure-steps.py --since <day or instant> --until <day>` is the instrument: per step session, wall-clock against model time, turns, cost, test commands, the tool-time classes, Bash against native calls, and — since 2026-09-04 — the turns that carried more than one tool call, which is the number that says whether a session batches. The baseline it produced on 2026-09-03 is in `project_log.md` (step-parallelism) and that plan's history.

`mc run` has been the runner since 2026-08-28T23:28Z. Through 2026-08-30 that
is 115 rows in runs.tsv — 92 `step`, 20 merge-only sessions of a kind this
era later removed, 2 `helper` and one `triage`, both from before the rules
changed — with **84 merged and none left
open**, one quota sleep, and not one `rebase failed, skip`. Every failure mode
nights 1–2 recorded is gone.

There is no baseline left to compare against: `runner.sh` is deleted, and
`mc run` has deliberately outgrown it — two lanes, archive, workarea
close-out, the day's helper, no triage, no decisions. What survives of the
intent holds: no line in the era shows a failure the shell runner handled and
this one does not.

Read `~/mc/runner/log/natt-1.md` for what the shell runner learned on nights
1–2, including why merges failed and why rebase was wrong.
