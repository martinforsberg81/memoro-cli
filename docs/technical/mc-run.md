# mc run — lanes

The runner is `mc run`: one process, rounds until it is stopped. A **round**
is one pass over the queue; a **step** is one fresh headless session in one
workarea, then the merge of the PR that session opened. The runner decides
nothing with a model — it reads files, runs `git` and `gh`, starts the session
through the launch adapter and waits for it.

This note is about the one thing in that loop which is not obvious from the
outside: since 2026-08-29 a round drives **one lane per repository at the same
time**. The rest of the runner — the queue, the step kinds, the merge, the
day's `mc helper` ride-along — is described in the source header of
[`src/mc/run.js`](../../src/mc/run.js) and in
[`docs/technical/mc-helper.md`](mc-helper.md), and gets its own note when the
`mc run` project closes out.

## Why lanes at all

A round used to be one step at a time, so it was as slow as memoro and
memoro-cli together, even though their steps never touch: different main
branches, different worktrees, different pull requests, and the runner merges
without a shared suite gate. Two lanes make a round as slow as the slower
repository.

There is nothing new to type. `mc run` is the same command with the same
flags; a round with only one repository holding ready plans is one lane and
behaves exactly as it did before — it does not even log the word `lanes`.

## What a lane owns

**One repository, and everything that repository's steps touch.**

- **Its slice of the queue.** `queue()` reads `~/mc/queue.md` plus every plan
  on the two `origin/main`s; `splitLanes` then groups the names by the
  repository each project lives in — an existing workarea decides it, and a
  plan on main decides it when there is no workarea yet. Martin's order in
  `queue.md` holds *within* a lane. A name whose repository cannot be told
  rides in a lane of its own, where `runStep` says so and skips it.
- **Its own steps, one at a time.** `runLane` walks its names in order. A step
  that merged keeps the lane on that project — the plan is re-read and, if it
  is still `ready`, the next step follows at once rather than a whole round
  later — up to eight times before the lane moves on.
- **Its own mid-round re-read.** That re-read fetches one repository
  (`queue({ only })`), so two lanes never run `git fetch` in the same checkout
  at the same moment.
- **Its own rows.** runs.tsv rows and runner.log lines are appended whole and
  prefixed by project name, so two lanes writing at once interleave by line,
  never within one.

Two lanes, not N: a third repository would be a third lane, but nothing ever
makes two lanes inside one repository — they would race for main.

## One current file per lane

`~/mc/runner/runner.json` stays one: a runner is here, and this is the pid to
test for life. What is running *right now* is one file per lane,
`~/mc/runner/current-<repo>.json`, carrying the project name, kind, repo,
tool, model, budget, start time, the runner's pid and the worktree.

It is written immediately before the session starts and removed in a `finally`
however that session returns, so a step that throws still clears the file.
Readers — the page's NOW block in `page-collect.js`, `mc status <name>` in
`status-collect.js` — glob `current-*.json` rather than opening one fixed
path, which is why NOW is a list of lines and not a line. `clearRunner` sweeps
every lane's file when the loop exits.

## What the lanes share

Two things, and they are the only two.

- **The Claude quota.** The 5-hour limit is one budget for the whole machine,
  so a quota answer in either lane pauses both. The lane that sees the refusal
  calls `quotaPause`, which logs `every lane sleeping 30m` and holds one
  promise; the other lane awaits that same promise in `quotaHold` before it
  starts anything — before a worktree is touched or a session is spent. One
  sleep of `QUOTA_SLEEP_MS`, not one per lane, and no session spent to be told
  the same thing again.
- **`~/mc/runner/STOP`.** It is checked at the top of every step and between
  the steps of a lane, so it ends *both* lanes after the step each is in.
  Neither lane abandons a session that is already running.

## Why the session is spawned, not `spawnSync`

`mc run` used to start the headless tool with `spawnSync` and block. Two lanes
in one process cannot overlap behind a call that holds the event loop for the
whole budget — ninety minutes, by default — so the second lane would never
have started at all.

`deps.session` returns a promise now: `spawn` with stdin closed (`claude -p`
reads a piped stdin and would eat it), a wall-clock `timeout` after which the
child is killed and the step is logged as a timeout, and stdout/stderr
collected here rather than by `maxBuffer` — capped, because a session that
floods stdout will not parse as JSON either way. Nothing else about a step
changed, and the fakes in the tests still return a plain object.

## How it is tested

`tests/mc/run.test.js` drives whole rounds against fake git, gh, tmux and
session deps, and asserts what only concurrency can produce: a memoro step and
a memoro-cli step in flight at the same moment, both lanes' current files
present together, the queue split with Martin's order intact, one repository
still logging no lanes line, exactly one sleep for a quota answer seen in one
lane, and STOP ending both lanes after one step each.
