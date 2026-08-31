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
  loud and handed over anyway: the restart was asked for.

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

1. **The day's `mc helper --intake`**, if it is due: once per calendar day, at
   the top of the first round after 05:00Z. It is not a step and not a
   project — it opens no worktree and touches no branch, it reads production
   and writes a digest and proposals into `~/mc/intake/`. Its runs.tsv row is
   its whole state, which is why a failed collect stays unretried for the rest
   of the day. See [`mc-helper.md`](mc-helper.md).
2. **Read the queue**: `~/mc/queue.md`, then every `PLAN.json` on both
   `origin/main`s.
3. **Tidy `queue.md`** against that reading.
4. **Archive** every plan that says `status: done` — the directory removed and
   a `project_log.md` row left behind it, one PR per repository, merged like
   any other. See [`mc-tidy.md`](mc-tidy.md).
5. **Run the steps**, one lane per repository at the same time.
6. **Close** the workareas whose project is finished — whose archive PR merged
   in step 4, or whose plan an earlier round already archived, which
   `project_log.md` is what still knows.

Steps 1, 3, 4 and 6 are skipped under `--once`: that flag exists to watch one
step, and a two-minute model turn over production is not what somebody typing
it asked for.

The loop around the round is `runLoop`. It writes `runner.json`, runs rounds
until `--rounds` is reached or a STOP file appears, sleeps `--idle-sleep`
after a round that ran nothing, and clears its files in a `finally` however it
ends.

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

Per project, in order, and any of these ends it:

- a tmux session `mc-<name>` exists — somebody is in there;
- the worktree is dirty;
- there is no workarea *and* no plan on main.

A missing workarea is created rather than skipped: `mc work add <name> <repo>
<name> --from origin/main`. Then `git merge origin/main` — **never** a rebase,
which is what nights 1–2 of the shell runner cost to learn. The one conflict
resolved without a session is an identical `.gitignore` hunk; anything else is
left in progress and the project gets a `reconcile` step instead of a `step`,
with the conflicting paths named in its prompt.

`chooseKind` is the whole of what a project gets:

| state | kind |
|---|---|
| merge left in conflict | `reconcile` |
| plan says `status: ready` | `step` |
| plan says anything else | nothing, one skip line |
| no plan in the worktree | nothing, silently |

There is no `triage` and there never will be again: the runner runs plans, it
does not write them. Planning is `mc plan <programme>`, a foreground session
with Martin in it, and it happens somewhere the runner cannot reach —
`~/mc/plan/<programme>/`, not a workarea (see [`mc-plan.md`](mc-plan.md)). What
the two share is a `PLAN.json` on `main`, and nothing else. And
`waiting-decision` is simply not `ready` — the runner does
not read decision files, count them, or start a project because one was
answered. A plan comes back by being set `ready`, which is the job of whoever
applies the answer.

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
change — write `../decisions/<name>-<date>.md` instead. It ends "Do not merge.
Do not ask questions. Stop when the PR exists."

Around that body go the Coding Profile and `canon/roles/{step,reconcile}.md`,
joined into one instruction text and passed through the channel each tool
already has: `--append-system-prompt` for claude, `-c instructions=` for
codex. Nothing is written into the worktree to carry them.

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
sentence of its own prompt. The claude lane has had `--permission-mode auto`
all along: **the workarea is the boundary the runner trusts**, not a sandbox
inside it, and both tools are given the same.

### The merge

If the session left an open PR for the branch and its own output says success,
the runner merges it: poll `gh pr view --json mergeable` up to twelve times at
5 s apart, then squash with the PR title as the subject. If that fails —
usually because main moved during the step — merge main in, push and try once
more; a conflict there is aborted rather than left in the worktree, because a
worktree with a merge in progress is dirty and would be skipped forever, and
the next round's `reconcile` owns it. Otherwise the PR is left open and the
row says `success,open`.

Merge direct is the policy for both repositories (Martin, 2026-08-25). The
runner does not review; `mc brief` is what shows Martin what merged.

A project whose step merged **keeps its lane**: the plans are re-read and, if
it is still `ready`, its next step follows at once rather than a whole round
later, up to eight times. A six-step plan would otherwise have taken six
rounds of twenty projects.

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

Two lanes, not N: a third repository would be a third lane, but nothing ever
makes two lanes inside one repository — they would race for main.

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

- **`log/runs.tsv`** — one row per step, reconcile and helper run:
  `ts name kind exit seconds pr turns input output cache_read cache_write
  session note`. The usage columns come from claude's `--output-format json`
  and from codex's `exec --json` event stream; a field the tool does not give
  is `-`, never a guess. `exit` and `note` are independent and are allowed to
  disagree — a process can fail after a session that reported success, and
  both are recorded.
- **`log/runner.log`** — the line-by-line narration, also on stdout.
- **`log/<name>-<ts>.json`** and `.json.err` — what the session actually
  printed, kept whole.
- **`runner.json`** stays one per machine: a runner is here, and this is the
  pid to test for life.
- **`current-<repo>.json`** — one file per lane, existing exactly as long as
  that lane's session does. It carries the project name, kind, repo, tool,
  model, budget, start time, the runner's pid and the worktree, and it is
  written immediately before the session starts and removed in a `finally`
  however that session returns, so a step that throws still clears it.
  Readers — the page's NOW block, `mc status <name>` — glob
  `current-*.json` rather than opening one fixed path, which is why NOW is a
  list of lines and not a line.
- **`log/closed/<name>/`** — whatever a closed workarea kept beside its
  checkout. Moved, never deleted.

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

`~/mc/bin/runner-loop.sh` is a small shell supervisor, and it exists for a
reason this project cannot fix from inside: `mc run` executes from
`~/memoro-cli`, which nothing fast-forwards, and node caches its module graph
at process start — so a runner that merges an improvement to itself keeps
running the old code for the rest of the round. The supervisor closes that at
the round boundary. Owned by
`~/mc/intake/proposals/2026-08-29-runner-runs-stale-code.md`.

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

`mc run` has been the runner since 2026-08-28T23:28Z. Through 2026-08-30 that
is 115 rows in runs.tsv — 92 `step`, 20 `reconcile`, 2 `helper` and one
`triage` from before the rules changed — with **84 merged and none left
open**, one quota sleep, and not one `rebase failed, skip`. Every failure mode
nights 1–2 recorded is gone.

There is no baseline left to compare against: `runner.sh` is deleted, and
`mc run` has deliberately outgrown it — two lanes, archive, workarea
close-out, the day's helper, no triage, no decisions. What survives of the
intent holds: no line in the era shows a failure the shell runner handled and
this one does not.

Read `~/mc/runner/log/natt-1.md` for what the shell runner learned on nights
1–2, including why merges failed and why rebase was wrong.
