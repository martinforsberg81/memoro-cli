# mc run — the runner

`mc run` starts fresh headless sessions on goals until stopped. It reads
GOAL.json and LOG.md, chooses work, launches a coding tool through the shared
adapter, and records the outcome. The runner itself makes no model turn.
`src/mc/run.js` owns processes and file boundaries; `src/mc/run-plan.js`
holds prompts, argument lists, output parsing and chore cadence rules.

Projects went on 2026-11-03; migration is documented in
[mc-goals.md § From a project](mc-goals.md#from-a-project). The runner now
starts goals only. A goal's worktree stays on its one branch until it lands.

```
mc run [--once] [--no-merge] [--idle-sleep <seconds>] [--no-caffeinate]
mc run start [same flags]
mc run stop [--force]
mc run --update [--force]
mc run lanes [<n>]
mc run --billing [<claude|codex> <on|off>]
```

With no flags it keeps picking. `--once` runs one runnable goal session and
no chores. `--no-merge` leaves the pull requests open; goal builds already
publish without merge, and their review owns the hand-off. `--idle-sleep`
is the idle delay, 600 s by default, checked in short slices for orders.
`--rounds <n>` was retired with the round: there is no pass to count.

## The switch

The person controls the runner with start, stop and update, also accepted at
the page's prompt. Orders are files under `~/mc/runner/`, read between picks,
not a message typed into the session being built.

- `start` spawns the detached runner and writes runner.json as soon as the pid
  is known; it removes a previous STOP. A runner already running is refused.
  On a stopping runner, start takes over: a new runner takes new work while
  its predecessor finishes only the sessions it already holds.
- `stop` writes `~/mc/runner/STOP`. It is sticky once seen: every lane finishes
  its session and takes nothing more. `--force` also terminates the runner's
  process group and removes its current files. It is not ordinary shutdown.
- `--update` (`update` is equivalent) writes UPDATE. The first reader
  fast-forwards the installed checkout and starts its successor with the same
  arguments and stdio; the old runner finishes its sessions. A requested
  restart still happens when the checkout cannot fast-forward, with a warning.
- The runner writes `runner/UPDATE` itself when origin/main has moved and
  that checkout is clean and fast-forwards, once per origin/main sha.
  Local work or divergence is said once, not silently discarded. The merger
  and repository watcher follow changes to their installed checkout too.

`src/mc/run-control.js` implements these orders and the login agent.
`mc run start` installs a RunAtLoad agent using `start --if-was-running`.
After login it starts only if runner.json names a dead pid and no STOP is
present. A runner deliberately stopped stays stopped. Node loads its module
graph once, so a landed code change needs a new process to use it.

## Staying awake

A continuous run holds `caffeinate -i -m -s -w <runner pid>` for its lifetime
(`stay-awake.js`); `--once` does not. Idle sleep is suppressed on battery,
while `-s` is effective only on AC. Display sleep is not suppressed. A closed
lid still sleeps the machine. `--no-caffeinate` allows normal sleep.

## The pick, in order

`goalWork`, `goalSession`, `phaseOpen` and `pickWork` (`lane-pick.js`) decide eligibility and
order without a model call:

1. Read the goals under `~/mc/programs/<programme>/goals/`, through the
   runner's own environment. Convert older goal status/dependency records
   before judging them. An unreadable goal is not runnable.
2. Consider `build · ready` with criteria, `review · ready`, `finish · ready`,
   or `merge · ready` after its first red or moved head and once it is no
   longer in the merger's line. `plan`, `done`, `dropped` and `blocked` do
   not start a session.
3. Hold any goal whose programme has an unfinished goal in a lower phase.
   All goals of a phase can run side by side; there is no separate queue file.
4. Exclude goals already claimed or named by a live current file, and goals
   whose first repository is not served by the lane. A review without an
   available route does not stand in front of other work.
5. Take reviews and plan work before builds, longest waiting first
   within the rank. Repository fairness first reserves a share for each
   repository with runnable work or a running session. Waiting begins at the last log entry.

The in-process claim is taken in the same tick as the choice, before any
await, so two lanes cannot choose the same goal before its current file exists.
The phase rule and the stage transitions are in [mc-goals.md](mc-goals.md).

## Lanes

`mc run lanes <n>` sets one total across repositories and session kinds,
from 1 to 16. It is read live. Raising it starts additional lanes; lowering
it lets sessions above the new count finish. `memoro` and `memoro-cli` are
the two repository names the runner serves.

A slot is taken at the last moment before launch, with no await between
checking and taking. Sessions held by a predecessor count too. A held lane
polls every 15 s; admission is FIFO, with waiters visible in
`runner/waiting.json`. STOP and UPDATE retire their waiting tickets.

No new session starts with less than 5 GiB free on the scratch volume or
memory status below 20 percent. The runner writes disk.json or memory.json
and removes it when the hold clears. A failed reading is not a hold.
Sessions already running and the merger go on.

## The session

`runGoal` works in the first repository's existing goal worktree and keeps its
branch. An unbuilt branch is remade from origin/main before its first build
when it has no commits of its own; built work never merges main to keep up.
A missing worktree is recreated on its goal branch when possible. A missing
role or tool skips launch; a worktree failure is recorded in LOG.md. The
prompt includes the rendered goal (goal, contract, boundaries, documents and criteria), and the
role tells the session to read LOG.md first.

- A build uses `build-session:goal` and the goal's `fast` or `large` class.
  It gates, commits and publishes with `--no-merge`. It ends with `mc goal log`,
  moving to review only once every criterion has been checked and met.
- A review uses `review-session:goal`, the open PR and its head. It judges,
  never builds: `mc goal stage merge` sends all registered PRs to merge, or it
  writes REVIEW.md and moves to finish. A review that dies still in review
  is retried once, then blocked if that happens again.
- A plan session uses `plan-session` on Claude opus at high effort, starting
  in the programme directory with access to the goal's worktree, for finish
  or a first merger red. It can finish the work and publish it. A subsequent red in merge is blocked for a person.

These are fresh sessions, not a resumed execution chain. If a session ends
without writing a log entry, the runner writes one; three such build ends
in succession send the goal to finish. A normal build end with more work
leaves it build · ready for the next session.

### Launch settings

Class routing supplies the tool, model and effort. The shared internal
`SESSION_DEFAULTS` fallback still has these rows (`step` is an internal key,
not a unit of runnable work):

| kind | `model` | `effort` | `advisor` |
|---|---|---|---|
| step | `opus` | `medium` | none |
| review | `opus` | `high` | none |

- **`tool:`** — `claude` by default in shared settings; class routing selects
  the candidate's tool. A missing tool is a visible refusal.
- **`model:`** — `opus` by default in shared settings; a goal's model comes
  from its catalog candidate, not from a field in its brief.
- **`effort:`** is passed through the adapter: Claude `--effort`, Codex
  `-c model_reasoning_effort=<level>`. Codex's model goes to
  `codex exec -m <name>`. The legacy schema names `haiku` and `opus` on claude,
  `gpt-6.1-sol` and `gpt-6-luna` on codex; catalog candidates are tool-specific.
- **`check_in_minutes:`** — 60 minutes by default: Claude receives a prompt
  asking whether the session is still moving the goal, not an elapsed-time kill.
- **`stall_minutes:`** — 20 minutes by default: silence is watched separately.
  A session with background tool tasks is asked before it is treated as hung.
  Sleep detected on the machine rearms this guard. Codex receives neither
  stdin check-ins nor this watcher.

The headless argument shapes include:

```
claude -p [--effort …] [--advisor …] --autocompact 150000
codex exec [-m …] [-c model_reasoning_effort=…]
```

`AUTOCOMPACT_TOKENS` (150 000) bounds Claude's context; Codex has no equivalent
flag here. Both use the shared instruction assembler and their native tool
adapters. Native delegation is the tool's; mc starts and counts no subagents.
Claude's allowlist stays narrow and strict MCP configuration excludes
user-level servers.

## What the runner writes

- **`runner.json`** stays one, naming the runner, its code and arguments.
- **`current-<repo>.json`**, with `-<lane>` for additional lanes, exists while
  a session is in flight. It carries kind, goal, tool/model/effort, worktree,
  pid, start time and check-ins. Removal is paired in a finally.
- **GOAL.json and LOG.md** hold the goal state and runner entries. The runner
  never writes its goal text, contract, boundaries or criteria.
- **Session logs** share a stem under runner/log: `.jsonl` is the stream,
  `.json` the parsed result or summed usage, `.json.err` stderr.
- **runs.tsv** appends one row after each session or chore, in this order:

```
ts name kind exit seconds pr turns input output cache_read cache_write session note land_seconds model class tool effort billing
```

The page reads these files, not a transcript to infer the goal's state.
Finished goals are archived through `archiveGoal` after 24 hours, with one
row in `goals/goal_log.md`; archive refusals are logged once. Every five
minutes at most, `settleLanded` checks carried PRs and sets done once all are
merged or closed and at least one merged. See [mc-tidy.md](mc-tidy.md).

## Sleeping and stopping

STOP and UPDATE are read between picks and inside idle waits. The helper's
shared quota pause reports `every lane sleeping 30m` when no reset is named;
a named reset sleeps until one minute after it. Orders break the pause in
short slices. A goal's provider refusal instead records that provider's
unavailability and lets the next goal route past it. API and plan refusals
are recorded separately for the next launch.

### Billing

Every MC session starts on its selected provider's subscription. A current plan
window below 100% remains eligible. At 100%, or after that provider refuses a
plan request, the next launch uses its API key through the local billing gateway.
This applies to every current MC session path: build, review, plan, helper, and
interactive sessions. An ordinary interactive `mc plan` still lets Martin
choose the tool and model; billing follows that choice. A headless plan session
on a goal in finish or merge runs on opus at high effort and is billed as any other
session. `mc run --billing` shows both providers' next routes. The MC page shows
one billing line.

The API reserve is switched per provider:
`mc run --billing <claude|codex> <on|off>`. Off, a spent plan stays the plan —
the session meets the plan's own refusal and the runner waits it out — and a
class-routed goal routed to the reserve waits instead of starting. The wrapper reads
the switch again before it opens the key, so a launch decided before the switch
was turned off never reaches the API. A running session keeps its billing.
Absent, both are on.

The gateway wrapper opens only the fixed `mc-anthropic-api-key` (Anthropic) or
`mc-openai-api-key` (OpenAI) record from MC Vault. The provider key stays in the
wrapper process. The coding tool receives an expiring, request-limited loopback
grant, and requests only the chosen model through the provider-specific route.
An interactive session (`mc plan`, `mc brief`, `mc helper`) is the exception: its grant names
no model, because `/model` inside the session changes it, and a grant on the
launch model refused every request after the switch.
The runner never reads or places the key in a session's environment or argv.
The vault must be unlocked and the relevant record configured before an API
reserve can run. A missing or unreadable key fails the API launch visibly.
Set the two records with hidden prompts:

```sh
mc vault unlock
mc vault set mc-anthropic-api-key --type api_token --provider anthropic
mc vault set mc-openai-api-key --type api_token --provider openai
```

Unlock once on the device. Do not use a token flag or a plaintext binding.

This first version keeps the same macOS user for the wrapper and coding tool.
It prevents accidental key exposure through session environment, arguments,
files, and logs; it does not isolate a malicious process with the user's OS
permissions from Keychain or the vault. The grant can be used by the session
until it exits, expires after 12 hours, or reaches 500 requests. The gateway
binds only to `127.0.0.1` and exposes no management or key-reading endpoint.

Codex reaches the gateway over a websocket (`supports_websockets=true`), so a
request on an open connection carries only what is new since the previous
response. Over HTTP every request carried the whole thread: a 205k-token thread
measured 8.3 MB on 2026-10-29, and the first API request of a thread started on
the plan took 114 s to its first byte. The upgrade arrives on
`/codex/v1/responses` with the grant, which is checked before the handshake (401
or 404 on the raw socket otherwise). Each session socket gets its own upstream
socket to `wss://api.openai.com/v1/responses`, opened with the key inside the
wrapper and the session's `OpenAI-Beta` value. Every `response.create` frame is
checked for the session's model and counts one request against the same 500;
a refused frame closes the socket with 1008 and is not forwarded. Provider
frames pass through unread, and a refused upstream handshake closes the session
with 1011 without relaying its body. Codex first sends a `prewarm`
`response.create` with `generate: false` on a socket of its own (recorded
2026-10-29, codex-cli 0.165.0); it counts like any other. HTTP stays for
`responses/compact`, `models`, and Codex's fallback. The body limit is 64 MiB,
also per websocket frame; a larger
body is read to its end and answered 413. Codex's remote compaction has its own
route, `/codex/v1/responses/compact`. Off a terminal the wrapper gives the tool
pipes of its own rather than its own stdout: codex sharing it panicked with
EAGAIN (`os error 35`) on 2026-10-29.

`billing.json` holds the API switch (`api: { claude, codex }`); its old manual
plan/credits/auto mode is no longer read for routing. `billing-state.json` retains Claude's observed plan windows and
refusals. The provider snapshot in `model-capacity.json` supplies both
providers' plan usage. A plan refusal is written for the next launch; crossing
billing boundaries starts a cold cache context.

## Work classes and capacity (ruling 59)

A goal names a work class, `fast` or `large`, not a model. The route
is decided locally, before a tool is launched, from the catalog
(`~/mc/runner/models.json`) and the capacity snapshot
(`~/mc/runner/model-capacity.json`). Choosing spends no model turn and reads no
account. The snapshot is refreshed by sessions that run anyway, and by one
read-only Codex call an hour. `review` is a class too, but only a goal's review takes it, and it is not scored by headroom.
Review is an ordered list of candidates: it takes the first that can run on its plan now and is not the model the goal was built on, and that model only when no other can. A candidate can run on its plan when its provider has not refused it and
no window in force is at its limit. A goal's review passes over every
candidate whose model is its last build entry's while another can run on its
plan, and takes the first of them on its plan when none can. When no candidate
can run on its plan, the first that is not that model (or that model, when
every candidate is it) uses its provider's API reserve, and waits when that API is off: no
candidate goes to credits while another's plan is free (ruling 59 § 4).

**The catalog** is Martin's. `mc model` is its only writer, and the file is
written whole or not at all:

- `mc model [list] [--json]` — the candidates of fast, large and review, each
  a numbered list in preference order, and whether they come from the file or
  the defaults.
- `mc model add fast|large|review <tool>:<model>:<effort>` — appends a candidate.
- `mc model remove fast|large|review <tool>:<model>` — removes the candidate
  with exactly that tool and model; a list keeps at least one.
- `mc model set review <tool>:<model>:<effort>` — replaces the whole review
  list with that one candidate.

With no file, the defaults are: `fast`, `claude:haiku:high` then
`codex:gpt-6-luna:high`; `large`, `claude:opus:medium` then
`codex:gpt-6.1-sol:high`; review, `claude:opus:high` alone. A file whose
`review` is one candidate object, as files were before review was a list, reads
as a list of that candidate and is written back as a list the first time `mc
model` changes it. A file that is there and cannot be read is refused, never quietly replaced by the defaults. A catalog
edit never rewrites a goal.

**The snapshot** is the runner's, kept apart from the catalog, so an observation
never edits the catalog and an edit never rewrites what was observed. Per
provider it holds the last valid observation (when it was taken, each window's
fraction used and reset instant, the models listed where known, any refusal
instant) and, beside it, the last failure. A failure never erases the last valid
observation. A window whose reset has passed is expired: its usage is unknown,
never zero.

- **Claude is observed passively.** After each claude session the runner reads
  the `rate_limit_event` windows in that session's stream and writes them
  (`observeClaudeStream`). A refusal a session got is written as the provider's
  refusal until its reset, or for the quota sleep when none is named
  (`refuseProvider`). No account read and no extra turn.
- **Codex is read once an hour**, from the chore pass (`refreshCodexDue`, every
  `CODEX_POLL_MS`; the first pass is due when nothing has been observed). `codex
  app-server --stdio` is sent `initialize`, then `account/rateLimits/read` and
  `model/list`, every page of the list up to five. It is never sent a thread or a
  turn, so no model is asked anything and no rate-limit reset is spent, and
  `send` refuses any other method. It is bounded to 20 s and 1 MiB. Credits are
  not read: they are not subscription headroom. A failed read keeps the last
  valid snapshot and is said in `runner.log`.
- **Not verified live.** The collector is tested against fixture answers. No
  live read of the signed-in codex CLI is claimed here, so no live Codex quota
  is claimed. The account type is inferred: a successful windows read is taken
  as the ChatGPT entitlement, and a failed one as its absence.

**The choice at launch.** `chooseCandidate` judges each candidate of the class
at that instant:

- *refused* — its provider refused, and the refusal has not passed. Never chosen.
- *exhausted* — a window in force is at 100 % or more. Never chosen until that
  window resets.
- *known* — every window in force has a read, each under 100 %. Its headroom is
  what remains of its tightest window. The most headroom wins, and the first in
  catalog order wins a tie.
- *unknown* — no usable read, or a claude read more than 3 h old. Usage only
  grows inside a window, so an old reading proves nothing about now.
- *unavailable* (codex) — no fresh read, or the model is not listed at that effort.

If no candidate is known, the first claude candidate with unknown capacity is
bootstrapped on the included plan. That is an unknown, not proven free quota:
the choice's basis is `bootstrap`, and its reason says so.

**API reserve.** When no candidate has eligible plan capacity, the first
catalog candidate uses its provider's API key through the gateway. A pinned
review uses its provider's API without changing model. The API model must be
available to that provider's API account; MC does not maintain a separate API
model catalog in this version.

**Refusals and the wait.** A class-routed session is never switched to another
provider while it runs. If its provider refuses it, the refusal is recorded for the next launch,
and the next pick routes the goal again in a fresh session on the same branch. If the catalog has no candidate for the class, the
goal is skipped as `no-capacity`: it stays `ready`, and the next pick routes it again. The reason names each candidate and
why. The chooser also returns `retry_at`, the earliest instant an answer can
change; the runner does not act on it yet.

**Audit.** A class-routed goal's `runs.tsv` row carries `class`, `tool`, `effort`, and
`billing` (`plan` or `credits`), and `model` is the model of the candidate it was
routed to. The session's `.json` `modelUsage` is the exact record of which models
ran and what they used.

## What runs beside it

The helper collect runs once per UTC day, on the first chore pass after 05:00Z;
the inbox drain takes up to three files per pass on its own cadence. Daily
dependency readings and tidy use their own recorded rows too.

No external supervisor is needed. The runner's chore pass — the
helper's collect, the intake drain, the tidying — ends with one more chore, the
**nightly tick**: `runNightly` reads `runs.tsv` and, when 24 hours have passed
since the last `kind: nightly` row (or there is none), runs
`mc test <repo> --full` for every repository as a meter and writes its row. A
chore pass with STOP present performs no tick, `--once` runs no chores and so
no tick, and the runner's `runningRound` guard is what it was — a gate round a
lane holds ends the tick for that repository rather than being waited for. The
detached scheduler that used to do this (`mc test nightly start`, a pid file)
is deleted; `mc test nightly status` says where the tick now comes from. See
[`mc-merge.md`](mc-merge.md) § *The full run nobody asks for*.

Nothing else runs beside it. There was a shell supervisor — it fetched,
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

`tests/mc/run.test.js` drives the runner through injected file, git, GitHub,
clock and process boundaries. `tests/mc/goals.test.js` covers phase and stage
eligibility. `tests/mc/run-doc.test.js` compares the documented defaults and
routing rules with the code. These tests start no real coding session.
