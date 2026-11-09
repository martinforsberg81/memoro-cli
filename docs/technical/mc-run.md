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
   `merge · blocked`, or `merge · ready` after its first red or moved head
   and once it is no longer in the merger's line. Only a merge failure wakes a mend session; legacy blocked work outside merge is reconciled to Martin without a launch; `finish · ready` a finish session. `Martin`
   waits for the person. `draft · ready`, `done` and `dropped` do not start a
   delivery session. A focused plan session may complete the next draft under the programme rule below.
3. Hold any goal whose programme has an unfinished goal in a lower phase.
   All goals of a phase can run side by side; there is no separate queue file.
4. Exclude goals already claimed or named by a live current file, and goals
   whose first repository is not served by the lane. A review without an
   available route does not stand in front of other work.
5. Take merge-failure mend first, then finish, review, then build. Pre-merge blocked work wakes no session and is reconciled to Martin. Within the earliest runnable rank, repository fairness
   reserves a share before higher programme priority, then carry/resumed work
   and longest waiting. Waiting begins at the last log entry. A carried build never
   jumps ahead of recovery or review.

Set one or several programmes with `mc programs priority mc inbox --set 10`.
Priorities are non-negative safe whole numbers; higher wins, and `--set 0`
restores the default. The value lives in each programme's `PRIORITY.json` and
is read on every choice, so changes need no runner restart once this code is
installed. Running sessions continue. Priority does not bypass eligibility,
phases or claims. Repository shares apply within the earliest rank; a recovery
can take the next lane even when its repository already holds its share.
Equal priorities keep the usual wait order. Continuous higher-priority work may keep lower priorities waiting.
The page shows nonzero priorities on programme headings; `mc programs list`
and its JSON include every priority, including zero.

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

No new session starts unless the disk policy admits it
([mc-tidy.md § Disk pressure](mc-tidy.md#disk-pressure)): 20 GB available on
the scratch volume, after a pressure pass if need be, asked at the top of a
pass and again at the start itself. A reading that fails refuses. No session
waits ten minutes just because another start holds the admission lease:
contended lanes retry within one second, remeasure, and still honor STOP,
UPDATE and the configured lane total. The lease remains exclusive through
allocation and spawn and is released before waiting for the session to end.
Dead-owner leases are reclaimed; live owners retain exclusion. No session
starts either below 20 percent host available memory. On Linux this is
`100 * MemAvailable / MemTotal` from `/proc/meminfo`: `MemAvailable` includes
memory the kernel estimates can be made available without swapping, including
reclaimable memory, and is not `MemFree`. Darwin keeps its existing sysctl
measurement. This is host telemetry, not cgroup/container headroom; an mc
process constrained by cgroups is not protected by this measurement. Missing,
unreadable or invalid telemetry is unknown and keeps the existing fail-open
policy: a session is admitted on unknown memory. The runner writes `disk.json`
or `memory.json` and removes the hold when the reading recovers. A timer reads
the disk every minute, beside the lanes and chores. Sessions already running
and the merger go on. Synthetic fixture evidence does not establish Linux
deployment readiness or reboot/service behavior.

Each session's scratch directory gets an ownership record,
`.mc-scratch.json`, with its session and start, and its end and exit once
the session is over. Scratch is no longer removed by age; tidy's rule S
reclaims only on that record: an ended session, or one whose runner has gone
with no end recorded (`mc-tidy.md`, rule S).

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
  is retried once, then waits directly on Martin if it dies again.
- A finish uses `finish-session` on a goal in `finish · ready`: it fixes what
  review found, gates, publishes and `mc goal stage merge`. One that ends
  with the goal still `finish · ready` is set `finish · Martin`.
- A mend uses `mend-session` only for merge failures (conflict, failed candidate check or moved judged head), repairs and requeues merge. Pre-merge blockers are resolved in-role or sent directly to Martin. The first two failed merges run mend; its ready result retries delivery. The third failed merge waits on Martin. Both run in the goal's worktree on the goal's class, like a
  build, and write the merge handoff when they queue. See
  [finish and mend](mc-goals.md#finish-and-mend). Planning is a separate next-draft assignment under the rule below.

These are fresh sessions, not a resumed execution chain. If a session ends
after handing its goal to merge, its lane is available for the next assignment
without waiting for the merge. `mc goal stage merge` writes a receipt in the
session's scratch directory after queueing every PR. The runner checks it
every 250 ms, ends its own launched child, and releases the current file,
slot and goal/programme claims after the child closes. Partial queue failures
write no receipt and leave the session able to retry. Review and finish must
write their records before the final stage command.

If a session ends
without writing a log entry, the runner writes one; three such build ends
in succession send the goal to finish. A normal build end with more work
leaves it build · ready for the next session.

A session that ends because the API server cannot be reached (`apiInterruption`
kind `offline`: `connection_failed`, or the result says `Can't reach the API
server`, ENOTFOUND, ECONNREFUSED or ETIMEDOUT) is no answer about its goal: it
writes no runner entry and records no refusal, and its `runs.tsv` note is
`offline`. It holds every new model session of any kind — build, review, finish,
mend, the helper and the intake — for `offlineBackoffMs(n)`: a
minute, doubling, at most fifteen, with `n` the offline endings in a row. The
hold is in memory, so a restart starts without one. A session that ends any
other way clears it and resets `n` only when it started after the hold was set.
A session that started before the hold ends without clearing it, and the runner
says so in one line. Sessions already running are otherwise untouched.

### Launch settings

`mc model priority [auto|codex|claude]` saves one global provider preference in
`runner/models.json`; an absent value is `auto`. The runner rereads it for each
fresh class-routed build, review and plan launch, including headless programme
planning, while an already-running conversation is unchanged. A preferred
provider wins among usable subscriptions regardless of relative headroom or
review build-model avoidance; within that provider the existing capacity and
model ranking remains. Preferred Claude with unknown, stale, failed or reset
usage is an attempted subscription launch even when Codex has measured room;
this does not assert unknown usage is zero. A live refusal or unexpired full
window excludes that provider until reset. An unavailable preferred Codex
model/effort falls back to another subscription before API reserve. Existing
API-off guards still apply.
`auto` keeps capacity balancing. Manager and intake use role-appropriate
provider models; manual explicit tool/model choices and interactive `mc plan`
and `mc manager` retain their selections. The page displays this setting and
its menu's `priority auto|codex|claude` command writes through `mc model`.

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
Dropped goals are finalized and archived immediately through the shared drop
operation on ordinary reconciliation, even without a stage timestamp. It
closes exclusively owned PRs, cancels their queue rows, preserves PRs with an
unfinished co-owner, and retains failed/unsafe cleanup for retry without
starting a recovery session. Done goals retain the 24-hour archive hold, with
one row in `goals/goal_log.md`; archive refusals are recorded once. Every five
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
This applies to every current MC session path: build, review, finish, mend,
helper, and interactive sessions. An ordinary interactive `mc plan` still lets
Martin choose the tool and model; billing follows that choice. A finish or
mend session runs on the goal's class routing and is billed as any other
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
An interactive session (`mc plan`, `mc manager`, `mc helper`) is the exception: its grant names
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
account. The snapshot is refreshed by sessions that run anyway, and by
independent read-only collectors due at startup and every 15 minutes for both
providers. `review` is a class too, but only a goal's review
takes it. Review ranks usable subscriptions by provider priority, then
headroom; ties avoid the build model, then follow catalog order. Codex needs a
fresh successful capacity observation listing the model and effort. Auto mode
retains unknown-Claude bootstrap only when no candidate has measured usable
capacity. Explicit Claude priority may also attempt its subscription with
unknown, stale, failed or reset usage ahead of known Codex capacity; unknown
does not mean zero. With no usable subscription, priority orders API reserve
candidates. The review waits when the selected API is off.

**The catalog** is Martin's. `mc model` is its only writer, and the file is
written whole or not at all:

- `mc model [list] [--json]` — the candidates of fast, large and review, each
  a numbered list in preference order, and whether they come from the file or
  the defaults.
- `mc model priority [auto|codex|claude]` — show or change the provider
  preference for unattended launches; an absent setting means `auto`.
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
- **Both providers are polled independently** at startup when no recent attempt
  exists, then every 15 minutes, outside chores and lanes. Reads do not overlap
  per provider; failures suppress retries for 15 minutes. A pending UPDATE
  pauses reads; the timer ends on STOP, a successful handover, a drain or exit,
  so a failed handover keeps polling. Completion patches the latest snapshot
  under the short runner lock (on the work root, never over a network wait),
  preserving other-provider, newer-observation and refusal
  updates. Codex `app-server --stdio` is sent `initialize`, then `account/rateLimits/read` and
  `model/list`, every page of the list up to five. It is never sent a thread or a
  turn, so no model is asked anything and no rate-limit reset is spent, and
  `send` refuses any other method. It is bounded to 20 s and 1 MiB. Credits are
  not read: they are not subscription headroom. Claude makes only a GET to the
  fixed `https://api.anthropic.com/api/oauth/usage` origin using the installed
  Claude Code login (Keychain service on macOS, otherwise its standard
  credentials file); redirects are denied. It parses subscription
  `five_hour`/`seven_day` usage only, never overage credits. Neither provider's
  credentials or raw response is logged/persisted. Each collector is bounded
  to 20 s and 1 MiB. Failures retain the last valid snapshot and record attempt
  and failure. Claude's passive stream observations remain supplementary.
- **Not verified live.** Controlled fixtures test the collectors; the fixed
  Claude request/auth contract was matched to inspected installed-tool code.
  No live provider request, login or model run was made. Codex account type is
  inferred from the successful capacity response.
- The retired cadence was: Codex was read once an hour from the chore pass.

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

Auto mode bootstraps unknown Claude only when no candidate is known. Explicit
Claude priority can bootstrap ahead of known Codex capacity. This is an
attempted subscription launch, not proven free quota. Billing status marks
failed, stale and unknown usage rather than showing zero or claiming the plan
is available.

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

## Next draft planning

Martin, 2026-11-09: a programme with at least one draft and every goal in
`draft`, `done` or `dropped` may run one plan session to complete its next draft.
Any unfinished delivery goal, including a goal waiting on Martin, holds this
trigger. Unreadable goal data holds it too. Select lowest phase, oldest creation
time, then goal name; a selected draft waiting on Martin cannot be bypassed.

The runner offers this assignment after build in the existing lane picker.
Claims and live current records prevent concurrent planning in one programme,
including across runner handover. Recheck the programme after admission awaits
before spawning. Use the selected goal's first repository worktree, role `plan`,
kind `plan`, `MC_GOAL` and `MC_HEADLESS=1`; keep the normal routing, admission,
provider refusals, offline holds, STOP and UPDATE behavior. Interactive planning
checkouts are not runner work areas. The assignment is to finish the brief and
reconcile the README and phases, then move that draft to build. An unresolved
choice goes through goal-bound mc ask. An ordinary completed plan session
leaving draft ready waits on Martin with an incomplete-session diagnostic,
preventing an unchanged-work launch loop. Provider refusals and offline endings
retain normal retry behavior and are not evidence of planning failure.

No draft means no plan session. Proposal arrival and daily proposal processing
remain outside this trigger. See [next draft planning](mc-goals.md#next-draft-planning).
