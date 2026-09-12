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
key on `deps` so a lane's pass can be driven in a test with no network.

```
mc run [--once] [--no-merge] [--idle-sleep <seconds>] [--no-caffeinate]
```

With no flags it takes the next step of the next project until STOP. `--once`
takes one step — the first runnable project in the whole order, either
repository — and exits: the way to watch a single step. `--no-merge`
leaves the pull requests open; it is a default-on boolean written mc's way,
not `--merge 0|1`. `--idle-sleep` is how long a lane that could start nothing
waits before it looks again, 600 s by default. The flag that counted passes is
gone; the history section at the end says why.

## The switch

```
mc run start [same flags]   the runner, detached, logging to runner.log
mc run stop                 after the step each lane is in
mc run stop --force         now, and the sessions it is holding with it
mc run --update             when every lane is between steps: new code, new process
```

All three orders are **files under `~/mc/runner/`, read between two picks**
— never signals, and never mid-session. A runner ninety minutes into a
headless step is given the order without that step being interrupted, which is
the whole reason they are files. `src/mc/run-control.js` writes them and holds
the rules; each lane reads them before it picks.

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
  otherwise the page draws a step that is not running. What a killed session
  leaves in its workarea — a merge of `origin/main` in progress — the next pick
  aborts (*What the worktree decides*).
- **`--update`** writes `UPDATE`. From the moment a lane reads it, that lane
  starts no new step; the steps in flight finish and land, and when nothing is
  in flight anywhere the runner fast-forwards the checkout mc is running from,
  starts a fresh `mc run` with the same argument list and the same stdio, and
  exits. `runner.json` is cleared *before* the new process is started, so the
  two never race for it. A checkout that will not fast-forward — local work, or
  diverged — is said out loud and handed over anyway: the restart was asked
  for. `UPDATE` has one other writer, which is not a person: a landing that
  changed mc's own code (see *The merge*). `mc run --update` itself is
  unchanged by that — it is still the order somebody gives, with its own
  refusals.

**Why `--update` has to exist at all.** Node reads its whole module graph at
process start and never looks at the disk again. The runner merges pull
requests, including pull requests that change the runner, so a runner that has
been up all day is running the code it was started with however much of itself
it has improved since. Measured 2026-08-29, four merged improvements to
`mc run` sat unused for two hours. Measured 2026-08-30, the process that could
first have closed a finished workarea ran for eighteen hours having started
ninety minutes *before* the closing code was merged — so nothing was ever
closed, and no line anywhere said why. New code needs a new process; this is
the order that asks for one at the one moment it costs nothing.

**Why it drains rather than hands over at once.** Two wrong versions preceded
the drain on 2026-09-04. In the morning a lane that read `UPDATE` while idle
left its loop and *sat*, so the idle lanes took no work for the whole of a busy
lane's step. Then idle lanes were let keep taking work until a quiet moment —
and with four lanes in steady work the quiet moment never came: an `UPDATE` the
runner wrote for itself at 09:30 was still pending two hours later. Martin chose
the drain over an immediate handover with two runners alive.

## Staying awake

A run that is not `--once` holds the machine awake for its whole length, and
that is the default rather than a flag to remember: this laptop is set to
sleep after **one minute** of idle on battery (`pmset -g custom`), and a
lane waiting ten minutes before it looks again is exactly what that setting is
for. An unattended run would stop without anybody deciding it should.

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
Apple Silicon the ways past it are clamshell mode (external display and
power) or `sudo pmset -a disablesleep 1`, which is machine-wide, persists
until it is changed back, and is therefore an operator's decision rather than
something a verb does on somebody's behalf. `mc run` prints which of these it
got at start, so the limit is read at the beginning rather than discovered as
an empty log the next morning.

`--no-caffeinate` turns it off.

## The pick, in order

A **step** is one fresh headless session in one workarea, followed by the
merge of the pull request that session opened. A **pick** is a lane choosing
which step that is. There is nothing that walks every project: a lane takes
the next step, and then the next one (Martin, 2026-09-08 — ruling 17 below, in
*Blocked by the runner*).

A **lane** is one loop in `runLoop` (`lane`, `run.js`), bound to one
repository. What it does, for as long as the runner runs:

1. **STOP and UPDATE first.** A `STOP` file ends the lane; a pending `UPDATE`
   makes it take no new step and wait for the drain (*The switch*).
2. **Read the world for its repository** — `queue({ only: repo })`:
   `~/mc/queue.md`, every `PLAN.json` on that repository's `origin/main`, and
   `gh pr list --state open`, on the same trip to the network. The open list
   also reconciles `held.json`: an entry whose pull request is no longer open
   leaves it.
3. **Pick** — `nextFor` ([`run-plan.js`](../../src/mc/run-plan.js)): the first
   name in `assembleQueue`'s order (*The queue*) that is in this repository and
   - whose plan on `origin/main` says its first unfinished step is `ready`
     (`kindFor`, the same call the page makes),
   - whose repository GitHub answered for (`prs-unknown` otherwise — a lane
     that cannot see what is open starts nothing),
   - that has no open pull request (`inFlight`) — unless it is a pull request
     `held.json` holds at `repairs: 0`, which is one repair session owed and is
     picked as `repair`,
   - that is not held after its one repair (`heldRepair`),
   - that no other lane has claimed (`claims`),
   - and that this pass has not already been refused on (`passed`).

   A pick costs no git at all: everything it reads is what step 2 fetched.
4. **Claim it, and say it.** The name goes into `claims` in the same tick it
   is picked, before anything is awaited, and the lane writes
   `memoro#2: next — <name> (step 3/8)`.
5. **Run it** — `runStep`, which asks the machine (*One step*) and gets one of
   three kinds of answer:
   - **a step ran** (`ran`, or `merged` when it landed): the pass ends, and the
     lane picks again **at once** against a freshly read world, because the
     one it picked from now has a pull request in it and a plan that moved on;
   - **a fault a person has to fix**: the step is written `blocked` on `main`
     (*Blocked by the runner*), the name joins `passed`, and the lane takes the
     next name in the same pass;
   - **a moment's fault** — `WAIT_REFUSALS` in `run.js`: a fetch that failed,
     GitHub not answering, an UPDATE read while waiting for a slot, a name
     another lane took between the pick and the run: the pass ends, the lane
     says `memoro#2: waiting — <word>` and sleeps `--idle-sleep`, then asks the
     same question again.

   Anything else — an open pull request that appeared after the world was read,
   a plan that left `main` mid-pass — is passed over for this pass like a
   block, and not written anywhere.
6. **Nothing to pick**: `memoro#2: nothing to run — sleeping`, and a sleep of
   `--idle-sleep`. An idle lane says that line once and then nothing until what
   it would say changes; it used to be one line per lane every ten minutes.

**A step that moved nothing is not picked again at once.** *Pick again at once*
is a spin if the step changed nothing: a session that opens no pull request and
leaves its plan on `main` exactly as it found it would be restarted the second
it ended. So a lane carries the `{ name, step }` it just ran, and `pass` skips
that one name while the plan on `main` still shows the same step
(`<tag>: <name> is on the same step its last session ended on — leaving it for
the next pass`). A merged step *does* move the plan, so a project whose next step
is ready is picked again at once — the order does what a lane's stay on a
project used to.

**The chores are not a lane.** They run in a loop of their own beside the lanes
(`choreLoop` and `chores()`), from the whole queue, with the same
`--idle-sleep` between two passes of it:

1. **The day's collect**, if it is due: once per calendar day, in the first
   chore pass after 05:00Z. It is not a step and not a project — it opens no
   worktree, touches no branch and calls no model; it reads production and
   writes one digest per repository into `~/mc/intake/`. Its two runs.tsv rows
   (`kind: helper`) are its whole state, which is why a failed collect stays
   unretried for the rest of the day. See [`mc-helper.md`](mc-helper.md).
2. **The inbox, drained**, every chore pass and with no day gate: the oldest
   files in `~/mc/intake/` — the collector's digests and whatever Martin
   dropped there — up to three of them, one headless turn each, every one moved
   to `~/mc/runner/log/intake/<date>/` the moment its turn ends whatever the
   turn returned. One row per file (`kind: intake`, the file in the name
   column). The question here is *is there a file?*, not *has today's collect
   run?*, and the two were one gate until 2026-09-05 — which is how thirteen
   digests came to be waiting in a directory that is supposed to drain.
3. **Tidy `queue.md`** against the plans on both `origin/main`s, and write
   `~/mc/runner/unreadable-plans.md` from the same reading.
4. **Archive** every plan that says `status: done` — the directory removed and
   a `project_log.md` row left behind it, one PR per repository, landed through
   `mc merge --docs` — but only while no lane is in a session, because the
   gate refuses a second landing rather than queueing it. See
   [`mc-tidy.md`](mc-tidy.md).
5. **Close** the workareas whose project is finished — whose archive PR merged
   in 4, or whose plan an earlier archive already took off `main`, which
   `project_log.md` is what still knows.

**The merge lane** is the third kind of loop: one for the whole process, taking
what a refused `mc merge` queued (*The merge*).

**`--once`** is one pass with one lane over the whole order, both
repositories: the same pick, the same refusals, and out after the first step
that ran (`once: exiting`) or when nothing is left (`once: nothing to run`). No
chores and no merge lane — the flag exists to watch one step, and a model turn
over production is not what somebody typing it asked for.

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

What a lane takes from is `assembleQueue`: the names in `~/mc/queue.md` first,
in the file's order, then every project with a `PLAN.json` on either
`origin/main` that the file did not name, **alphabetically**. That is the whole
of the order, within each repository. A name with no plan on main is not in it
at all — it used to be, and the skip line it produced was read by nobody. Such a
workarea is surfaced where somebody looks instead: the page's list of
workareas without a project.

`~/mc/queue.md` is Martin's "these first" and nothing else: project names, one
per line, no comments and no headings. **A name leaves it when its plan is
`done` or has left `main`**, and not before. It used to leave the moment one
step of the project had run, which made sense while every name was tried once
per pass over the queue; with the order as the only thing a lane goes by, a
prioritised five-step project would have dropped to alphabetical after its
first step (2026-09-08). `strictQueue` is the rule and `tidyQueue` in the chore
loop rewrites the file to that shape, one runner.log line per dropped entry: a
line that is not a name, a name given twice, a name with no plan on main, a
plan still written as `PLAN.md`, and a plan that is `done`. A `blocked` project
keeps its place — it is first again the moment its step is `ready`.

## One step

A project is asked in two places, and the order is the whole of what a pick
costs: **the plan on `origin/main` decides before anything is touched, and the
worktree decides after.**

### What the plan on main decides

The pick answers it (step 3 above), from the plans the lane has just read.
`kindFor` is the reading — the same one the page's NEXT draws from — and a name
it refuses is never picked and costs no git at all:

| the plan on main says | the lane |
|---|---|
| the first unfinished step is `ready` | may pick it |
| every step is `done`, or the first unfinished one is `blocked` | does not |
| the file does not parse | does not — and a row in `~/mc/runner/unreadable-plans.md` |
| there is no plan | does not — `assembleQueue` has already left the name out |

The first unfinished step is the only step anything looks at. Steps are an
order, and skipping a stopped one to reach a later `ready` step is how a plan
gets half-built in an order nobody chose.

What this answer is worth was measured while the runner still walked every
name: 38 projects in 51 s of git, 36 of which the plan on main had already
refused, against 1.2 ms for the same answers read from the plans in hand
(the history section at the end). The picker is that economy made the only
path.

### What the worktree decides

Everything that is *not* on any plan is asked by `runStep` of this machine and
this GitHub at this moment, in this order (`runStepClaimed`):

1. **STOP**, and the quota: a lane that another lane's quota answer has put to
   sleep waits it out here, before a worktree is touched.
2. **No workarea** is not a refusal: one is created with `git worktree add`
   from `origin/main` — the call `mc work add <name> <repo> <name> --from
   origin/main` makes.
3. **A merge of `origin/main` left in progress** — `MERGE_HEAD` present — is
   aborted: `git merge --abort`, and `<name>: a merge of origin/main was left in
   progress — aborted`. That is what a session killed mid-merge leaves (rc 143,
   `mc run stop --force`), and the runner's own abort after a session never runs
   in a process that was killed. The abort returns the tree to the branch's own
   last commit; nothing a session committed is touched, and what it had not
   committed went with the session. `REBASE_HEAD` and `CHERRY_PICK_HEAD` are
   deliberately left alone — the runner starts neither, so one of them is a
   person's work.
4. **The worktree is dirty** — uncommitted changes that are not a merge in
   progress, usually somebody's unfinished work about to be stepped on. The
   runner never commits, stashes or discards it.
5. **What is open on GitHub could not be read** for this repository.
6. **A held pull request**: at `repairs: 0` the step becomes a `repair`
   session; after its repair it is the brief's (*Held before merge*).
7. **A pull request already in flight** (`inFlight`) — the picker has already
   passed over every project it saw one on, so this is only a pull request that
   opened between the pick and the run.
8. **The branch.** A workarea whose branch has already landed — checked by
   content (`branch-landed.js`), because the runner squash-merges and "ahead by
   N" says nothing — is moved to `<name>-<n>` from `origin/main`, the smallest
   `<n>` no branch local or remote is using, *before* a session starts, because
   `push-guard.js` would otherwise refuse the push at the end of it. Asked of
   every workarea under `~/mc` on 2026-09-02, 44 stood on a landed branch. A
   branch that has *not* landed carries work and is left exactly where it is. A
   repair stands on its pull request's branch instead.
9. **`git merge origin/main`** — **never** a rebase, which is what nights 1–2
   of the shell runner cost to learn (`syncMain`, below).
10. **The role and the tool**: `canon/roles/<kind>.md` must be there, and the
    launch adapter must find the plan's tool.
11. **A slot** under the machine's `total` (*Lanes*).

**The answers split in two, and the split is the whole of ruling 17.** A fault
that nothing the runner does next will change, and that a person has to act on,
ends with the step `blocked` on `main` — *Blocked by the runner* has how. A
fault that is a moment's, and not the project's, is waited out.

| blocked on `main`, as `blocked_by: { kind: "workarea", name }` | the refusal word | when |
|---|---|---|
| `dirty-worktree` | `dirty` | 4 — the comment names up to five of the files |
| `worktree-missing` | `worktree` | 2 — `git worktree add` failed; git's reason |
| `branch-unmovable` | `branch` | 8 — `<name>-<n>` could not be made, or a repair's branch could not be checked out |
| `merge-uncommittable` | `sync` | 9 — every conflict resolved and the commit refused; a merge git refused with no conflict at all (unrelated histories, a stale `index.lock`); a `PLAN.json` neither the plan's rule nor `main`'s copy could settle |
| `role-missing` | `role-missing` | 10 |
| `tool-missing` | `tool-missing` | 10 — the adapter's hint |
| `held-after-repair` | `held-after-repair` | 6 — the pull request and its hold |

The names are `WORKAREA_BLOCKS` (`run-plan.js`), keyed by the refusal word so
the two lists are one. Where a merge is in progress when the fault is met, it is
aborted first, so the workarea a person opens is the branch's own last commit
and not a tree with everything staged.

**Waited out, never blocked:** `STOP`; the quota pause; `prs-unknown`; `sync`
when it was the *fetch* that failed (the same word — `syncMain` says which, and
the lane keeps the names it blocked in `persistent` to tell them apart); an
UPDATE read while waiting for a slot. Neither blocked nor waited: `in-flight`,
because an open pull request is work and not a fault, and a hold at
`repairs: 0`, because that is a repair the runner starts.

**One gap, found writing this.** The picker passes over a project held after
its repair *before* `runStep` is reached (`pickState`, `run-plan.js`), so in a
running runner `held-after-repair` is written onto a plan only when the hold
arrives between a pick and its run. Such a project is not lost — `held.json`,
the page and the brief's *Held before merge* all name it — but its plan on
`main` goes on saying `ready`. The fix is a proposal
(`2026-09-11-held-after-repair-never-blocked`), not this document's.

A live tmux session is **not** a reason at all. It used to be, and it was a
second, undeclared way to stop work — whether a step ran depended on which
terminals happened to be open (Martin, 2026-09-02). A project the runner
should leave alone says so by being `blocked` in its own plan.

**`syncMain`.** Two conflicts are resolved without a session. One is an
identical `.gitignore` hunk. The other is a **`PLAN.json`**, always the same
shape: main carries the plan a planning session or another step wrote to, the
branch carries the same plan with its own step edited (29 of the 166
conflicting files measured in `runner.log`). `plan-merge.js` merges it from the
three sides git holds in the index while the merge is in progress (`:1:` the
base, `:2:` ours, `:3:` origin/main), by the rule the plan already has about
who may write what: each step goes to whichever side changed it, a criterion is
met if either side met it, and `goal`, `contract`, `out_of_scope` and the
criteria themselves are main's, because a step session may not change them.
**Where the rule refuses** — both sides on the same step, a side that is not
JSON, a step added or removed, a result `validatePlan` would reject — **`main`'s
copy is taken** (`git checkout --theirs`, then `git add`), with a line saying
what the rule refused and that main's copy was taken, and the merge commits.

Taking main's copy loses nothing a pull request carries. By the time `syncMain`
runs, an open pull request of the project's has already ended the pick
(`inFlight`), and a branch whose content is in `origin/main` has already been
moved (`freshBranch`). What the branch has in its plan that main does not is
either work that landed in another shape — a `Record PR N on step` commit whose
squash main then re-planned over — or work no pull request carries; and the plan
the runner obeys is the one on `main` ([`docs/project/README.md`](../project/README.md),
§ *Who writes what*). The rule is still tried first: it costs nothing, and its
line tells the next reader of the log what each side had changed.

Every other conflict is handed to the step session: `stepPrompt` puts a
preamble above the body naming the conflicting files, saying the merge stopped
there, and saying it is the first thing the session does and not the job. One
session resolves the merge and delivers the step, and one pull request carries
both. A repair is handed its conflicts the same way — a pull request held
*because* it conflicts with main meets the same conflict when the runner merges
main into its branch, and resolving it is the repair. If the session leaves the
merge unfinished, the runner aborts it after the session.

**A project's branches are `<name>` or `<name>-<suffix>`.** That convention is
what lets a pull request be matched back to a project at all, and step 8 is
what makes it true rather than hoped for: `projectForBranch` takes the longest
project name the branch equals or begins with followed by a hyphen — longest,
because `mc`, `mc-cut`, `mc-log` and `mc-test` are all project names and
`mc-cut-2` must not resolve to `mc`. A pull request on a differently named
branch is invisible to this, and there is no second rule for a case nobody has
seen: every open pull request on 2026-09-02 followed the convention. The block
pull request relies on it too (*Blocked by the runner*).

### Which copy of the plan the runner reads

**Two readings of one copy.** The pick reads the plan on `origin/main`, off the
lane's world, to decide *whether to start*. `runStep` then reads the plan out
of the worktree, after `syncMain`, to decide *what to hand the session* — and
after `syncMain` the file on disk **is** main's copy: the workarea stands on
`origin/main` merged in; a merge that stopped on some other file has already
written main's plan into the worktree, because git merges the files it can; and
a conflicted `PLAN.json` has been resolved by the plan's rule or by taking
main's side. It is also the file the step session will edit, so it is the one
that must be obeyed. `planOf` (`run.js`) reads it off disk and from nowhere
else — there is no branch-copy read left anywhere in the runner. **What a
planning session and the runner share is a `PLAN.json` on `main`, and nothing
else.**

A step session's own edits to its plan in its worktree are untouched by all of
this. This is about which copy the runner reads to decide what to hand out —
not about what the session then edits, or what its pull request carries.

`chooseKind` is the whole of what a project gets from that copy:

| state | kind |
|---|---|
| plan says `status: ready` | `step` — with the conflicting files in its prompt if a merge is in progress |
| plan says anything else | nothing, one skip line |
| the plan does not parse | nothing — and a row in `~/mc/runner/unreadable-plans.md` |
| no plan in the worktree | nothing, silently |

An open pull request is not in the table: the pick answered it, and a held one
is a `repair` rather than a step.

There is no `triage` and there never will be again: the runner runs plans, it
does not write them. Planning is `mc plan <programme>`, a session at the
terminal with Martin in it, and it happens somewhere the runner cannot reach —
`~/mc/plan/<programme>/`, not a workarea (see [`mc-plan.md`](mc-plan.md)). The
one thing the runner writes into a plan is a step it could not start, and it
never writes `ready`. The runner never read decision files, counted them, or
started a project because one was answered, and there are none to read now. A
plan comes back by being set `ready`, which is the job of whoever applies the
answer.

### The two readings, and what each answers

The pick is not the only reader of those two refusals. **There are two readings
of "can this project be worked on now", they answer different questions, and
neither can answer the other's:**

| | `planState` / `kindFor` | `machineState` |
|---|---|---|
| the question | is this plan ready to be worked on? | would the runner start it now? |
| what it is a fact about | a file on `origin/main` — the state of the first step that is not `done` | this machine, at this moment |
| what it sees | `ready`, `blocked` and what on, `done`, a file that does not parse | the STOP file, a dirty worktree, a merge stopped in one, a held pull request, work in flight, a branch the workarea does not have |
| what it costs | nothing — the lane has already read the plans | one `git status --porcelain` in the workarea, and only where the plan does not already refuse |
| where it lives | `plan-schema.js`, flattened by `kindFor` (`run-plan.js`, re-exported by `status-collect.js`) | `machineState` (`status-collect.js`) |

A plan can be `ready` for days while nothing can start it. On 2026-09-05 both
of memoro-cli's unfinished plans read `ready` in every surface a person uses
while `held.json` held #612 and #614 and the whole queue was stopped; the one
place that knew was `runner.log`, which carried 9 827 `, skip` lines. That is
what the second reading is for. Since 2026-09-08 the runner closes most of that
gap itself: a fault a person has to act on becomes `blocked` on `main`, so the
*first* reading says it, and `machineState` answers `blocked` from the plan
before it asks this machine anything. What `machineState` still sees that the
plan does not is the window between a pick and a landed block, and the faults
that are not blocks — a held pull request, work in flight.

`machineState` asks the reasons in `runStepClaimed`'s own order, because the
answer has to be the first thing the runner would hit and not merely some true
thing. It starts nothing, writes nothing and fetches nothing — its `git` is only
ever given read-only arguments — and it asks the plan first, so a project the
plan already refuses costs no git at all.

**The two cannot drift, and that is asserted rather than hoped for.**
`RUN_REFUSALS` (`run-plan.js`) is the shared vocabulary: every word `runStep`
refuses on for a reason that is not in the plan, in the order it asks them.
`runStepClaimed` returns `skipped:<reason>` through one `refuse()` helper — or
through `block()`, which returns the same word after writing the block — and
the reading answers in the same words. Tests in `tests/mc/run.test.js` hold
them together: a table of cases driven through both `runStep` and the reading
over one fixture, a coverage test asserting every word in `RUN_REFUSALS` has a
case, one test per `WORKAREA_BLOCKS` name, and a source check that no refusal
returns a bare `'skipped'` (the lane claim in `runStep` is the one exception,
and it is a fact about this process rather than about the files).

Four of the words carry `read: false`, and there the reading answers *runnable*
rather than guessing: `worktree`, `sync`, `role-missing` and `tool-missing` are
each the outcome of work the runner does and the reading may not do — creating
a worktree, fetching and merging, reading a role out of a worktree it has just
synced, spawning a tool. So **`runnable: true` means nothing on this machine is
standing in the way, not that the step is guaranteed to start**: `mc status`
cannot know a fetch will fail.

Two things are deliberately absent, and one differs. A **repository lease** is
not read: a lease held by a gate or a deploy is a reason to wait rather than a
reason a project cannot run, it is gone within minutes, and reading it would
make `mc status` flicker. There is no word for a **merge the runner aborted and
recorded** any more — the `unmergeable` word and its file went when a
`PLAN.json` conflict started taking main's copy (the history section). And a
**merge left in progress** in a workarea still reads `dirty` in the reading
(`a merge stopped in …`), while the lane now aborts it and starts — a
difference of one idle sleep at most, and a proposal
(`2026-09-11-reading-calls-a-killed-merge-dirty`).

**Which surface says which**, so that a bare `ready` can be read for what it is
wherever it is met:

| surface | what it says |
|---|---|
| `mc status <name>` | both, on one row — `ready · #614 is held before merge after a repair (since 09-03 10:00Z)`, `step n is blocked on workarea dirty-worktree` where the runner blocked it, and bare `ready` when this machine has nothing to add ([`mc-status.md`](mc-status.md)) |
| the page's NEXT (`mc`) | both — a skipped name is counted under its word, a runnable name is drawn as the kind the runner would actually start, `repair` where a hold is owed one, and each lane block's head is what that lane picks next ([`mc-ui.md`](mc-ui.md)) |
| `mc brief --collect` | both — *Blocked* has a group of its own, *Waiting on a workarea*, for what the runner blocked, and *Ready, and the runner cannot start it* for what the plan does not say yet ([`mc-brief.md`](mc-brief.md)) |
| the page's PROGRAMMES rows, `mc status`'s step rows, the brief's *Plan status* | the plan alone, and that is right: they are about what the plan says |

### The session

Fresh, headless, and assembled from the plan's `runner`, the step's own
`runner`, and the defaults for the session's kind (`sessionSettings`). `model`,
`effort` and `advisor` resolve **step over plan over default**, one key at a
time — a step that names only its effort keeps the plan's model. `tool` and
`budget_minutes` are the plan's alone. A repair reads the plan's `runner` but
never a step's: it is a session on a pull request, not the step that opened it.

| kind | `model` | `effort` | `advisor` |
|---|---|---|---|
| step | `sonnet` | `medium` | `opus` |
| repair | `opus` | none | none |

That is [ruling 18](../project/mc/rulings.md) (2026-09-11). Opus at high
effort on every turn was the cost — 155 step sessions over 2026-09-05..12, all
on `claude-opus-5` at this machine's `effortLevel: high` — and the advisor is
the strong model at the decision points rather than throughout. The defaults
are `SESSION_DEFAULTS` in `run-plan.js`.

- **`tool:`** — `claude` by default, resolved through `resolveLaunch`. A tool
  that is not installed is a block with the adapter's own hint.
- **`model:`** — `sonnet` by default for a step, `opus` for a repair, and
  those defaults belong to claude alone. They are claude aliases; handed to
  `codex -m` one names a model that tool does not have and the step dies on
  its argument list before reading a word of the plan. A plan on another tool
  that names no model gets none, and the tool picks its own.
- **`effort:`** — `low`, `medium`, `high`, `xhigh` or `max`, passed as
  `--effort`. Without it claude falls back to the machine's own
  `effortLevel`, which is why the step default names one. Anything else is
  refused by the schema.
- **`advisor:`** — a model name passed as `--advisor`, or `off` for none. An
  advisor that is the session's own model is none too: a plan or step on
  `opus` runs without one unless it names a different advisor (Martin,
  2026-09-12: *"Om step har opus => advisor = null, inte opus+opus."*). The
  flag is not in `claude --help`; it is documented at
  code.claude.com/docs/en/advisor.md and was accepted by claude 2.1.268 on
  2026-09-11.
- **`budget_minutes:`** — the wall-clock cap, ninety minutes, by default.
  The child is killed at the cap and the row says `timeout`.

Effort and advisor are claude's flags (`effortArgs` and `advisorArgs` in the
claude adapter), so a codex session gets neither, named or not. A step's
`runner` is its author's, like its `instruction`: `unauthorisedChanges`
compares every key of the session's own step except `status`, `pr`,
`comments` and `blocked_by`, so a session that changed the model it runs on
is a `plan-trespass`.

The prompt is `stepPrompt`: you are in this workarea, your plan is on disk at
this path, do `steps[i]`, its `done_when` is your success criterion, say in the
PR body how you verified it, what in the plan file you may edit, and — if the
contract must change — stop with the step `blocked` and say so in the PR. "Do
not merge. Do not ask questions. Stop when the PR exists." Below that comes
**the part of the plan the step needs, not the file**: rendered from the parsed
plan, each part under a `----- <heading> -----` line the session can search
for — `goal`, `contract`, `out_of_scope`, `success_criteria` (index, `met`,
criterion, check), `documents`, `runner` where the plan has one; then
`Your step: steps[i]` with every field of the step, `instruction` and
`comments` as paragraphs; then `The other steps`, one line each:
`steps[i] · <status> · <title> · done when: <done_when>`, and `PR #n` where the
step has one. Until step-cost (ruling 18) the prompt ended with the whole
PLAN.json — up to 115k characters for memoro's `sql-w1-universe-closure` — and
since the prompt is read on every turn, so was every other step's instructions.
The session still has the whole file in its worktree and edits it there; one
that needs another step's instructions reads it.

The session's context has a ceiling too: claude gets `--autocompact` at
`AUTOCOMPACT_TOKENS` (150 000), so it compacts at 150k tokens rather than near
the model's own limit. Over 2026-09-05..12 the mean context per turn was 112k
and 36 of 295 sessions averaged over 200k, and every turn pays for all of it.
The window is a constant in `run-plan.js`, not a plan field — nothing has shown
a plan needing another, and the measurement after twenty sessions
(`scripts/measure-steps.py`'s *context per turn* row) is where that would show.
A step and a repair get it; the helper and intake turns, which share
`headlessArgs`, do not.

Next to that body go the Coding Profile, `canon/roles/_common.md` and
`canon/roles/step.md` — assembled by `instructionsFor` and passed through the
channel each tool already has, with nothing written into the worktree to carry
them. How that is found and joined, for every session and not only this one, is
[`mc-roles.md`](mc-roles.md).

The two argument lists are the only place the tools differ:

```
claude  -p <prompt> [--model …] [--effort …] [--advisor …] \
        --permission-mode acceptEdits --autocompact 150000 \
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
rather than a detached job polled in two-minute `sleep` loops.

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

| what the merge round reported | the row says |
| --- | --- |
| merged into `main` | `success,merged` |
| merged into anything else | `success,off-main` — not a merge this counts |
| the gate went red | `success,open,gate-red` |
| the gate round stopped for another reason | `success,open,gate-<why>` |

A red gate is not a failure to find a way past. The pull request stays open, and
the open-pull-request rule then keeps that project out of every pick until
somebody has dealt with it.

The gate costs a gate round — 20–35 minutes on memoro — where the old merge
cost seconds. That is the price of the contract; `land_seconds` in runs.tsv is
where it shows, kept apart from the session's own `seconds`.

The **archive** pull request and the **block** pull request are the two
exceptions in kind, not in door: an archive removes a plan directory and adds a
`project_log.md` row, a block edits one step of one plan, so both are
documentation by construction and land through `mc merge --docs`
(`landDocsPr`), which checks that against GitHub's own file list and refuses
anything touching a line of code.

**A landing that changed mc's own code hands the runner over to it.** When the
gate lands a pull request, the runner asks GitHub which files it changed — the
same question `--docs` asks, and for the same reason: the gate's report lists
the *test* files its selection ran, and a local diff is only as fresh as the
checkout. If any of them is under **`src/mc/`** or **`canon/`**, the runner
writes `runner/UPDATE` itself, and the drain in *The switch* fast-forwards and
hands over. Nothing else about the handover changes: it happens between steps,
never mid-session, and one file is written however many of mc's own pull
requests the lanes landed.

Those two trees and no others. `src/mc/` is the runner — node read its module
graph at process start, so a merge of `plan-schema.js` changes nothing about
the process that merged it — and `canon/` is the roles it quotes into the next
step's prompt. A change to `tests/`, `docs/` or `scripts/` cannot make the
running runner wrong, and a handover costs a fresh process; widening this to
"the repository" would hand over after most memoro-cli landings. The docs door
cannot trigger it at all: `--docs` refuses anything outside `docs/`, and
neither of these is under it.

A **stack** needs an order rather than a call — `mc merge` refuses a batch
aimed at several bases. `stackOrder` in run-plan.js is the whole decision, over
the list of open pull requests the lane already fetched: exactly one aimed at
`main` is the bottom, and every other one must be aimed at the head of exactly
one of the others. Land the bottom, `gh pr edit --base main` the one above it,
`git rebase --onto origin/main <where it left its old base>` — a squashed base
leaves every branch above it conflicting even when its author did nothing
wrong — and land that. Two aimed at `main`, a fork, a cycle, or a base that is
nobody's head is not a stack the runner understands: it lands none of them and
says so. A rebase that conflicts is aborted, the files are named, and the
landing stops on that project.

Merge direct is the policy for both repositories (Martin, 2026-08-25). The
runner does not review; `mc brief` is what shows Martin what merged.

**A hand `mc merge` that was refused becomes the runner's.** The verb runs the
merge round it always ran and prints what it always printed; what changed on
2026-09-06 is what becomes of one that did not land. Six stops are ones the
merge lane can do something about — `busy` and `lease` (this machine's one gate
lock, or the repository, is somebody else's for the minute), `red`, `pr-tests`,
`extra-gate` and `merge` — and each writes one entry to
**`~/mc/runner/merges.json`**: repository and number together as the identity,
the branch the gate read, the reason, the stop, a `since` a second queueing does
not move, and who typed it. The rules are pure in
[`src/mc/merge-queue.js`](../../src/mc/merge-queue.js), the shape `held.js` has
and for the same reason. A stop at `pr` is not queued — GitHub could not be
asked, or there is no such pull request, and nothing on this machine can land
what it cannot name — and neither is a batch or a `--check`, which measured and
was never asked to land. The caller gets one line, `queued — the runner's merge
lane lands #N, or holds it after one repair`, and **exit 0**: the merge is now
somebody's rather than nobody's. Measured 2026-09-06: `mc merge memoro-cli 671`
was refused fourteen times in twenty minutes by the runner's own landings, and
every one of those refusals was a person typing again. Every queued and every
held entry, and the round the lane is landing right now, are on the page
under **MERGES** rather than NEXT (ruling 20, 2026-09-12) — see
[`mc-ui.md`](mc-ui.md).

**Without a running runner nothing is queued**, and the terminal is what it was
before this project plus one line on stderr saying no runner is there to take
the refusal. *A runner is running* is `runner.json` with a live pid, read
through the same `readRunner` the loop reads it with, so the verb and the runner
cannot disagree about who is holding the machine.

**The lane that lands them** is one loop for the whole process, beside the
repository lanes and the chores (*Lanes*, below). It takes the oldest entry
every 30 s and hands it to the same `landPr` a step's own pull request goes
through, so it waits out a busy gate exactly as a step's landing does — up to 45
minutes — and writes `held.json` when the gate goes red. The entry leaves the
queue on whatever the answer was, dropped inside `landPr` *after* the hold is
written, so a crash between the two leaves the pull request in a file rather
than in neither; from then on a red one is `held.json`'s, with the one-repair
rule every held pull request has. A step lane's own landing answers a queued
pull request just as well, which is the ordinary case — a hand merge is usually
refused *because* the project's lane was landing that same pull request — and a
queued landing that changed mc's own code writes `UPDATE` exactly as a step's
does, since the runner should not go on running old code because the change came
in by hand. An entry whose pull request somebody merged or closed by hand leaves
at `reconcileHold`, where a held entry leaves, with one guard of its own: the
open list is the `gh pr list` of the last reading of the world, and
`merges.json` is written by another process, so an entry younger than that
reading is left alone rather than judged absent from a list taken before it
existed.

Measured live, 2026-09-06T23:46Z, with the repository's whole suite holding the
gate: `mc merge memoro-cli 681` stopped at `busy`, printed the queued line and
exited 0 in under a second; the lane read the entry four seconds later, waited
40 s for the gate, and GitHub merged #681 into `main` at 23:47:22Z with nobody
typing again. The merge round before it, against a free gate, landed in 4 s and
wrote no queue file at all.

### Held before merge

A landing that does not land leaves a pull request open, and an open pull
request stops its project: `inFlight` keeps it out of every later pick. Until
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
`current-<repo>.json`, **never a status in a `PLAN.json`** — `ready`/`done`/`blocked`
are still the whole of `STEP_STATUSES`, and the one thing the runner writes into
a plan is a `blocked` step (*Blocked by the runner*). The rules are pure in
[`src/mc/held.js`](../../src/mc/held.js); `run.js` reads-changes-writes the file
whole through `hold()`, `countRepair()`, `release()` and `reconcileHold()`,
because any lane may hold a pull request while another is landing one.

`repo` is part of the identity, not decoration: two repositories number their
pull requests independently, so memoro #9 and memoro-cli #9 are different
work and a release keyed on the number alone would drop the wrong entry.

**Two birthplaces.** `landPr`'s `else` — the gate went red, the merge round
stopped, the stack was not one — writes the gate's own `reason` plus what
`holdDetails(report)` took off it. The report is the only place a command
gate's output ever exists: `gate-rounds.jsonl` keeps the red names capped at
forty and no output at all, and the report itself lives in memory for the
length of that gate round, so it is read there or it is lost. The other is
`runStep`, when a session ends with a pull request open and a note that is
neither `success` nor `quota` (`holdsAfterSession`) — a `plan-trespass` with
its problems named, a session that timed out with its work pushed, a tool that
printed no result.

**One death.** An entry leaves when its pull request is no longer open. `landPr`
releases what it lands, and `queue()` checks the file against the open list
every reading of the world fetches, so a pull request somebody merged or closed
by hand leaves by itself with a line saying so. A repository `gh` could not be
asked for is *unknown* rather than empty: nothing of its is dropped on a bad
network.

**Then one repair.** Before `inFlight` passes the project over, the pick asks
the file. A held pull request with `repairs: 0` is not work in flight — nothing
is going to finish it — so the project gets a `repair` session instead of a
skip: in its own workarea, standing on the entry's branch (a repair never calls
`freshBranch`; that branch carries the work), told the pull request, the
branch, the reason, every red test by name and every failed gate's output
(`repairPrompt`, `canon/roles/repair.md`), and the conflicting files when
merging main in stopped. It makes the branch green and pushes to the same
branch — the runner lands it afterwards through the same `landPr` — or it sets
its step `blocked` with a `blocked_by` and says what the answer is about. It
never merges, never lowers a threshold, never deletes a test to pass: the gate
decides and the repair obeys it.

The repair is counted **before** the session starts, not after. A repair killed
on its budget still had its turn, and a count written afterwards would hand the
next pick a second one for the same pull request.

A repair of a `plan-trespass` is judged against the plan on **origin/main**,
not the plan in the worktree: the worktree's plan already carries the trespass,
so judging by it would call the trespass repaired the moment the session
touched nothing more, and the runner would land what it refused an hour
earlier. `repairBaseline` picks the baseline and `stepOfPr` the index — the
step that names this pull request, or the deliverable one before that edit has
landed. An ordinary repair is judged against the worktree's plan, so a repair
that oversteps is held again like any step.

**A held pull request with no project gets its one repair from the merge lane.**
The repair above is found *per project*, by a lane's pick, and runs in that
project's workarea — so an entry whose branch is no project's is reached by no
lane at all, and stood at `repairs: 0` for ever with nobody told. That is the
ordinary shape of a hand `mc merge`, which is a person typing about their own
branch. So the merge lane does the reaching: where a landing it made held a pull
request `projectForBranch` calls nobody's, the lane makes a workarea from the
entry's branch (the call `mc work add` makes), counts the repair *before* the
session as the rule above says, runs the same `repair` role on the same
`repairPrompt`, and lands once more. After that the entry reads `repairs: 1` and
it is the brief's, exactly as a project's own held pull request is. It re-reads
`held.json` before it launches and refuses an entry that already carries a
repair, which is what stops the one branch both readings could claim — a branch
named after a plan that is on main with no workarea on this machine — from being
given two. STOP or a pending UPDATE stops a repair *starting*, the same refusal
`waitForSlot` makes for a step, because a ninety-minute session begun under a
drain stretches the drain into two. The workarea is fresh from the branch, so
the rule that a repair may not run in a worktree with a merge in progress is
asserted rather than handled; and an entry that names no branch — a merge round
refused before the gate ran has none to give — gets no repair here and says so.
The session writes no `current-<repo>.json`, because it is not a step and the
page's RUNNER block draws that file as one; what says the machine is busy is the
lane's own `mergeBusy`, and what makes the hour visible afterwards is a runs.tsv
row with `kind: repair` and the branch in the name column.

**And then it stops.** `repairs >= 1` is a skip again: the picker passes the
project over (`held-after-repair`), and where the hold arrives between a pick
and its run, `runStep` blocks the step on `main` under that name with `#N is
held before merge after a repair — the brief's` as its detail. No loop: a pull
request its one repair could not save is a person's decision, and it reaches
Martin in `mc brief`'s *Held before merge* section — merge by hand, close, or
block the step with a decision, one proposal each (see
[`mc-brief.md`](mc-brief.md)). Between briefs it is on the page: **MERGES**
draws `N held` on its own heading with project, pull request and reason under
it, and `mc --json` carries `merges.held` whole (see [`mc-ui.md`](mc-ui.md)) —
moved there from NEXT by ruling 20, because it answers MERGES' question rather
than NEXT's.

One gap worth knowing: the picker passes over a project whose plan on
`origin/main` is blocked, done or unparseable before `runStep` is reached, so
such a project's held pull request gets neither a repair nor a line in
runner.log. It is still in `held.json`, which is why both the page and the
brief read the file rather than the log.

## Lanes

**One lane loop per repository per `per_repo`, all at the same time**, each on
its own clock. memoro's steps and memoro-cli's never touch — different main
branches, different worktrees, different pull requests — so a lane that is idle
does not wait for one that is busy.

**A lane owns one repository, and everything that repository's steps touch.**

- **Its slice of the order.** `nextFor` takes only names whose plan is in the
  lane's repository — an existing workarea decides it, and a plan on main
  decides it when there is no workarea yet. Martin's order holds *within* the
  repository.
- **Its own steps, one at a time.** A lane runs one step and picks again.
- **Its own reading of the world.** `queue({ only })` fetches one repository,
  so two lanes of two repositories never run `git fetch` in the same checkout
  at the same moment.
- **Its own rows.** runs.tsv rows and runner.log lines are appended whole and
  prefixed by project name, so two lanes writing at once interleave by line,
  never within one.

**A repository may have more than one — `mc run lanes <n>`.** The count lives in
`~/.memoro/mc/lanes.json` (`lane-count.js`), 1 to 8, default 1, read once at
start; a running runner takes a new count on `mc run --update`. With n above
one, n loops run on each repository, tagged `memoro#1`, `memoro#2`, and **every
one of them takes from the same ordered list**. What keeps two of them off one
project is **the claim**: `claims` in `run.js` is one set for the process, a
lane adds the name it picked in the same tick it picks it — before its session
has opened anything — and `runStep` releases it in a `finally` however the step
ends. `nextFor` skips a claimed name, so the second lane takes the second
*runnable* name, not the second by position. Two lanes on one repository read
the world separately, up to ten minutes apart, and the first lane's pull request
does not exist yet while its session runs; the claim is what covers that, and
the open pull request covers the rest once the session has pushed. `runStep`
checks the claim once more as the last guard.

Each lane has a current file of its own — the first keeps `current-<repo>.json`,
the rest are `current-<repo>-<k>.json`, and the page reads them by name. What
the lanes of one repository share is its main, and that is where two steps
meet: **a landing that finds the gate lock or the repository lease held waits
for it** — `landPr` asks the merge round again every 30 s for up to 45 minutes —
instead of logging `left open` and parking the project behind its own pull
request, which is what a refused landing did until 2026-09-03. The lock and the
lease themselves still refuse: one suite at a time is the guarantee, and it is
the caller that learnt to wait.

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
case this is built for; `mc run --once` beside it is refused.

**The merge lane is outside both numbers, and the ceiling is `total + 1`.** It
is not one of the `per_repo` loops and it never takes a slot — `takeSlot` counts
steps and this is not one: no session, no workarea, no plan. That is the
requirement the queue exists for, since the refusals it answers are the ones a
person was retrying by hand *while every lane was busy*, and a merge that waited
for a step lane would answer them no faster. It lands one pull request at a time
and runs at most one repair session, so a machine with a merge lane in it runs
at most `total` steps and one more thing: **`total + 1`**. What it does share is
what no landing can avoid sharing — this machine's one gate lock and the
repository's lease, both of which `landPr` waits for rather than gives up on.
STOP and UPDATE it reads where the step lanes read them, between two picks,
which for this lane is between two queued pull requests and never inside a
landing; and because it writes no `current-<repo>.json` for the drain to count,
it answers the drain itself through `mergeBusy()`, so a handover cannot arrive
in the middle of a squash.

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

Everything lives under `~/mc/runner/`, with one exception, which is the one
thing it writes into a repository: a blocked step (below).

- **`log/runs.tsv`** — one row per step, repair, collect and drained inbox
  file, and the
  history keeps the kinds the runner no longer produces:
  `ts name kind exit seconds pr turns input output cache_read cache_write
  session note land_seconds model`. `seconds` is the session; `land_seconds` is the
  gate round that followed it, `-` when there was none. It is appended rather
  than placed beside `seconds` because the header is written once, when the
  file is created, and a column inserted would shift `note` one to the left for
  every reader of the old header. `model` is the model the runner asked for —
  the resolved `sessionSettings` model, `-` for the helper and intake turns and
  for a tool left to pick its own — appended last for the same reason, so a
  row can be read against the effort and advisor its session ran with (step-cost,
  ruling 18). The file on this machine still has the thirteen-column header it
  was created with, so a reader that keys cells by the header sees neither of
  the last two; `archive-plan.js` reads by position and stops at `note`. What
  the session actually ran on is in its own json's `modelUsage`, which is what
  `scripts/measure-steps.py` groups by. The usage columns come from claude's `--output-format json`
  and from codex's `exec --json` event stream; a field the tool does not give
  is `-`, never a guess. `exit` and `note` are independent and are allowed to
  disagree — a process can fail after a session that reported success, and
  both are recorded. **A `plan-trespass` on a step that changed the runner's
  own rules is worth checking before it is believed.** The boundary is judged
  by the process that ran the step, with the code it was started with, so a
  step that merged a new `plan-schema.js`, prompt or `unauthorisedChanges` is
  measured against the old one: on 2026-09-02 a step migrated every plan on
  both mains, the runner re-read them with the schema it was holding, they did
  not parse, and the row said `plan-trespass` against a session that did
  nothing wrong. The handover above is what keeps the *next* step honest; it
  cannot save the step that produced the change.
- **`log/runner.log`** — the line-by-line narration, also on stdout. What a
  lane picked (`memoro#2: next — <name> (step i/n)`), what it could not start
  and why, and — once, not every ten minutes — that it has nothing to run.
  The `starting` line says what the session runs on, leaving out what was not
  passed: `<name>: step starting (claude sonnet · effort medium · advisor opus,
  90 min)`, `(claude opus, 90 min)` for a repair, `(codex own default model,
  90 min)` for a codex plan that names none (`describeSettings`).
- **`log/<name>-<ts>.json`** and `.json.err` — what the session actually
  printed, kept whole.
- **`runner.json`** stays one per machine: a runner is here, and this is the
  pid to test for life. Every start reads it first, so it is a claim that is
  checked rather than one that is only made.
- **`current-<repo>.json`** — one file per lane, existing exactly as long as
  that lane's session does. It carries the project name, kind, repo, tool,
  model, effort, advisor (`null` where none was passed), budget, start time,
  the runner's pid and the worktree, and it is
  written immediately before the session starts and removed in a `finally`
  however that session returns, so a step that throws still clears it.
  Readers — the page's RUNNER block, `mc status <name>` — glob
  `current-*.json` rather than opening one fixed path, which is why the block
  is a list of lines and not a line.
- **`held.json`** — every pull request a landing did not land, with the reason
  and how many repairs it has had. One file for the machine, written by
  whichever lane held or released something; see *Held before merge*.
- **`merges.json`** — every pull request a refused `mc merge` handed the merge
  lane, and only what the lane has not tried yet: repository, number, branch,
  reason, stop, `since` and who typed it. Written by the verb, in whatever
  terminal it was typed in, and emptied by the lane one entry at a time; see
  *The merge*.
- **`block/<repo>/`** — the worktree a block is written in, existing only while
  it is written (below).
- **`log/closed/<name>/`** — whatever a closed workarea kept beside its
  checkout. Moved, never deleted.

Three more files sit beside them, and are the runner's questions for Martin
rather than records of what it did — `mc brief --collect` is their only reader
and renders one section each. `undocumented-closures.md` is appended when a
project is archived with `doc: none`; `unplanned-workareas.md` and
`unreadable-plans.md` are rewritten whole every chore pass, so a folder that got
a plan and a plan somebody fixed each leave their list by themselves.
`unreadable-plans.md` (`plan-intake.js`) is the newest of the three and exists
for the same reason as the other two: the runner can hand out no step from a
plan the schema refuses, and what its author meant to say is not mc's to guess.
It used to be a `runner.log` line, which is where `new-user` sat for a day.

They were written to `~/mc/intake/` until 2026-09-04. That room is an inbox
somebody drops one file into and a turn drains — and two of these three come
back whole every chore pass, so a turn that read one and filed it away would
find it there again the next time, forever. They are the runner's own output
about its own work, so they live with the rest of it. The path is spelled once,
in `src/mc/paths.js`, for the runner that writes it and the brief that names it
to a person.

### Blocked by the runner

**The runner writes one thing into a plan: a step it could not start.** When a
fault in the table under *What the worktree decides* is met, `blockStep`
(`run.js`) writes the project's first step that is not `done`:

- `status: "blocked"`,
- `blocked_by: { "kind": "workarea", "name": <the name from WORKAREA_BLOCKS> }`,
- and one paragraph appended to that step's `comments`:
  `Blocked by mc run on <stamp>: <detail>. The workarea is <path>. mc brief or a
  planning session sets this step ready again once the workarea is fixed; the
  runner does not retry.`

Nothing else in the file changes — it is exactly the edit `unauthorisedChanges`
allows a step session on its own step, and a test holds the runner to that
shape. The plan is checked with `validatePlan` before it is committed: a plan
the runner made unreadable is the failure `plan-intake.js` exists for, and it
must not be this runner's. If that step is already `blocked` — another lane, or
an earlier pick, wrote it from a world this one read a minute ago — nothing is
written and the line says so.

**How it reaches `main`.** Like an archive: a worktree of the repository at
`~/mc/runner/block/<repo>` on a fresh branch from `origin/main`, a commit titled
`Block <name> step <i>: <name of the block>` with the detail as its body, a push,
`gh pr create` with the same title and a body that says the way back, and
`landDocsPr` — the docs door, `mc merge --docs`. The worktree and the branch are
removed in a `finally`. Under `--no-merge` the pull request is left open.

**The branch is `<name>-blocked-<stamp>`, named after the project on purpose.**
`projectForBranch` then reads a block pull request that did *not* land — the
docs door refused it, or `--no-merge` — as the project's own open pull request,
so `inFlight` keeps the project out of every pick until it lands; nothing else
has to know the branch exists, and the brief reads open pull requests. Once it
lands, the plan on `main` says `blocked` and `kindFor` answers `skip:blocked`:
the project is never picked again until somebody sets the step `ready`.

If the block cannot be written at all — the worktree, the commit, the push or
the pull request fails — the line says `the step is not blocked, only skipped`,
the lane still moves to the next name, and the project is met again when the
world is next read.

**The way back is `mc brief` or a planning session, and nothing else.** The
brief lists these steps in its *Blocked* section under *Waiting on a workarea*,
with the comment the runner wrote, and puts them as *fix the workarea, then set
the step ready* rather than as a decision; a planning session may set one
`ready` under the rules in [`docs/project/README.md`](../project/README.md),
§ *Who writes what*. No verb was added. The runner never writes `ready` and never
retries on its own, because the retry was the fault:

> "Hela upplägget med 'runda' är fel. Allt ska inte provas. Runner ska ta next
> step. Punkt." … "Dessutom så är kodningen med jämna och ojämna rader för
> vilket projekt som tas ur bota dumt skapat så det får vi fixa till. Varje
> lane tar nästa step under NEXT, men inte samma projekt för två olika lanes."
> … "Vägen tillbaka är via brief eller en plan-session. Om det var något som
> en LLM skulle kunna ta beslut som så skulle det ha gjorts vid första
> Runner-försöket. Då är det det som är fel. Rätt svar är inte en Runner-runda
> till." (Martin, 2026-09-08 — ruling 17 of the `mc` programme, carried by the
> `runner-next-step` project and closed with it)

What the runner *can* settle by itself it settles at the first attempt instead
of blocking: `main`'s copy of a `PLAN.json` the plan's rule cannot merge, and
the abort of a merge a killed session left.

## Sleeping and stopping

- **`~/mc/runner/STOP`** — checked by every lane before it picks and at the top
  of every step, so it ends *every* lane after the step each is in. No lane
  abandons a session that is already running, and the runner refuses to start
  at all while the file exists. Written by `mc run stop`, removed by
  `mc run start`.
- **`~/mc/runner/UPDATE`** — read between picks only, and answered by a
  handover rather than an exit. Written by `mc run --update`; see *The switch*.
- **An idle lane** sleeps `--idle-sleep` — 600 s unless it is given — and then
  reads the world again. A lane with a step to run does not sleep at all.
- **The Claude quota.** The 5-hour limit is one budget for the whole machine,
  so a quota answer in one lane pauses all of them. The lane that sees the
  refusal calls `quotaPause`, which logs `every lane sleeping 30m` and holds one
  promise; every other lane awaits that same promise in `quotaHold` before it
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
fast-forwarded `~/memoro-cli`, ran the runner for one pass and slept — written
on 2026-08-29 because `mc run` had no way of its own to pick up a merge of its
own code. It has one now: **`mc run --update`**, read between two picks, which
fast-forwards that same checkout and hands over to a fresh process. See
*The switch* for what it does and why node's module graph makes it necessary.
The script was deleted on 2026-09-03 with nothing running it — no process, no
tmux server, no reference in `src/`. A supervisor outside the product is a
second thing to start, stop and remember, and mc's own state files know
nothing about it.

## How it is tested

- `tests/mc/run-plan.test.js` — the rules with no process at all: queue
  assembly and tidying, `nextFor` (the order, a claimed name, an in-flight
  name, a held-after-repair name, a blocked plan, one repository at a time),
  `chooseKind`, the headless argument lists, the reading of a session's output,
  the runs.tsv row, `sessionSettings`, `helperDue`.
- `tests/mc/run.test.js` — lane passes and the chores against fake git, gh,
  tmux and session deps, asserting what only concurrency can produce: two
  lanes on one repository taking the next two *runnable* names and never the
  same one, a memoro step and a memoro-cli step in flight at the same moment,
  exactly one sleep for a quota answer seen in one lane, and STOP ending every
  lane after one step each. One case per `WORKAREA_BLOCKS` name drives the fault
  through `runStep` and asserts the block pull request's title and branch, the
  plan edit (only the status, the blocker and one comment) and that the next
  pick over the re-read world is the next name; a `PLAN.json` both sides edited
  starts a step with main's plan in the prompt; a merge left in progress is
  aborted and the step starts.
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

## History: the round

From 2026-08-28 to 2026-09-08 the runner worked in **rounds**, and this is the
one place the word is kept for it. A round was one pass over the whole queue:
the day's collect and the inbox, `queue.md`, every plan on both `origin/main`s
and `gh pr list`, the tidy and the archive, then every name of the queue walked
in order — the plan on main asked first (`planRefusal`), the worktree second
(`runStep`) — then the workareas closed, and ten minutes of sleep after a round
that ran nothing. `mc run --rounds N` ran N of them;
`--rounds <n>` was retired with the round on 2026-09-08 and is answered by
name, with exit 2. `--once` kept its meaning: one step.

It was built up in good faith, and each piece is still in the code in another
shape:

- **One lane per repository (2026-08-29)**, so a round was as slow as the
  slower repository rather than both together. **Each lane its own rounds
  (2026-09-03)**: memoro-cli's lane had sat idle for hours while memoro's walked
  thirty names. **`mc run lanes <n>` (2026-09-04)** put n loops on a repository,
  and lane `k` of `n` took every `n`th name of the repository's list from
  position `k` (`splitLanes`, `index % count === lane`) — so lane 2 took the
  second name whether or not lane 1 could run the first. The claim replaced it.
- **The plan before git (2026-09-02, `mc-run-one-project`).** A real `mc run
  --rounds 1` against `~/mc` walked 38 projects in **51 s** and started none of
  them, roughly 1.3 s of git each — `repoOf`, the worktree's existence, `git
  status`, the fetch and merge, and only then the plan, and a missing workarea
  was *created* before anything was read. 36 of those 38 refusals were already
  on the page. Answered from the plans the round had already read, the same
  board was **1.2 ms** — `kindFor` over `~/mc/runner/plans.json`, measured
  2026-09-02T20:03Z. On that board 21 of the 38 waited on `blocked_by: {kind:
  "decision", name: "plan-review"}` and 7 more behind one blocked project; read
  the numbers as the shape of that day's board. The live before-and-after of one
  `mc run --rounds 1 --no-merge` was never taken: the runner was up and holding
  the session that measured it. Those refusals left **one line per round**,
  counted by reason — `skipped 36 (blocked 30, unparseable 5, done 1) — the
  plans that do not parse: …`.
- **A lane stayed on a project after a merged step**, re-reading the plans and
  following its next step at once, up to eight times — a six-step plan would
  otherwise have taken six rounds of twenty projects. The order now does it.
- **`queue.md` emptied itself**: a name left the file the moment its step had
  run, so a queue everything ran from was an empty file.
- **Which copy of the plan (2026-09-05, ruling 10).** While a merge was in
  progress the round read the plan out of the branch (`git show HEAD:`,
  `planOf`'s `fromHead`), and the condition was `conflicts.length > 0` while the
  docstring defended only a conflicted `PLAN.json`. Over the whole of
  `runner.log` to 2026-09-05, **207 rounds reached a conflict, 180 of them (87 %)
  with no `PLAN.json` among the conflicting files**, and every one of those 180
  was handed the branch's plan when main's was on disk beside it: `docx-editor`
  reported *"step 17 is blocked on decision docx-ime-input-source"* for 13
  consecutive rounds about a step main had re-planned the evening before, and
  the only conflicting file was a technical note. Ruling 10 narrowed the
  predicate to `conflicts.some(isPlanPath)` (`plan-read-from-main`). The case it
  kept was stale too — HEAD there is the copy that lags, and
  `sdk-artifact-storage` read `blocked` on a step main said was `done` in 13 of
  the 27 plan-conflict rounds — so the round aborted such a merge and recorded
  the workarea in **`~/mc/runner/unmergeable.json`**, because `git merge
  --abort` leaves the worktree clean and every surface would otherwise have
  called the project runnable; `machineState` read it as the word
  `unmergeable`. On 2026-09-08 `main`'s copy started being taken instead, and
  the predicate, the file, its readers and the word went together.

**Why it went.** Measured 2026-09-08 in `runner.log`: memoro lanes #1 and #2
each ended every round with `skipped 15 (blocked 15)` or `skipped 16 (blocked
16)` and `0 ran`; `sql-w3-email-closure` was merged, refused (`PLAN.json is not
resolvable by the plan's rule — steps: 13 in the merge base, 13 on this branch,
12 on main`) and aborted every ten minutes from 2026-09-06T18:34Z; and
`sql-w1-universe-closure` was `dirty worktree (.gitattributes,
.github/workflows/deploy.yml, .gitignore +1039)` every round — a `git merge
origin/main` a killed session had left in progress — while nothing on `main`
said either project was stuck. Tried again every ten minutes, a fault a person
had to fix was a log line nobody read, for days. Martin's answer is ruling 17,
quoted under *Blocked by the runner*: take the next step, and write down on
`main` the step that cannot be taken.

After the switch (the runner restarted on the picker at 2026-09-08T06:48Z),
`grep -c 'skipped [0-9]* ('` over `runner.log` stood at 930 and has not grown:
the last such line is 2026-09-08T06:42:08Z, and every lane line since is
`next —`, `waiting —` or `nothing to run — sleeping`.

## What the era measured

`scripts/measure-steps.py --since <day or instant> --until <day>` is the instrument: per step session, wall-clock against model time, turns, cost, test commands, the tool-time classes, Bash against native calls, and — since 2026-09-04 — the turns that carried more than one tool call, which is the number that says whether a session batches. Since step-cost (ruling 18) it prints the wall, API time, turns, cost and context-per-turn rows once more per **main model** — the `modelUsage` key in the session's json with the most output, so an advisor or claude's own small calls do not count as what the session ran on — which is the before-and-after that ruling is measured on. The baseline it produced on 2026-09-03 is in `project_log.md` (step-parallelism) and that plan's history.

`mc run` has been the runner since 2026-08-28T23:28Z. Through 2026-08-30 that
is 115 rows in runs.tsv — 92 `step`, 20 merge-only sessions of a kind this
era later removed, 2 `helper` and one `triage`, both from before the rules
changed — with **84 merged and none left
open**, one quota sleep, and not one `rebase failed, skip`. Every failure mode
nights 1–2 recorded is gone.

There is no baseline left to compare against: `runner.sh` is deleted, and
`mc run` has deliberately outgrown it — lanes, archive, workarea close-out, the
day's helper, no triage, no decisions. What survives of the intent holds: no
line in the era shows a failure the shell runner handled and this one does not.

Read `~/mc/runner/log/natt-1.md` for what the shell runner learned on nights
1–2, including why merges failed and why rebase was wrong.
