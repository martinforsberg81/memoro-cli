# mc run — the runner

`mc run` starts fresh headless goal sessions and main-red mends until stopped.
It reads goal files and main-mend requests, chooses work, launches a coding tool through the shared
adapter, and records the outcome. The runner itself makes no model turn.
`src/mc/run.js` owns processes and file boundaries; `src/mc/run-plan.js`
holds prompts, argument lists, output parsing and chore cadence rules.

Projects went on 2026-11-03; migration is documented in
[mc-goals.md § From a project](mc-goals.md#from-a-project). The runner now
starts goal sessions and goal-less main-red mends. A goal's worktree stays on
its one branch until it lands.

```
mc run [--once] [--no-merge] [--idle-sleep <seconds>] [--no-caffeinate]
mc run start [same flags]
mc run stop [--force]
mc run --update [--force]
mc run lanes [<n>]
mc run --billing [<claude|codex> <on|off>]
```

With no flags it keeps picking. `--once` runs one runnable lane session and
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

### Linux user systemd

On Linux, each canonical `MC_WORK_ROOT` has its own
`mc-runner-boot-<sha256-prefix>.service` user unit and uniquely named transient
start scopes. A successful explicit background start runs in a
`systemd-run --user --scope`; the scope command returns after systemd accepts
it, while the detached runner remains in the scope's cgroup. Starts already
inside an mc boot unit or start scope do not nest. An unavailable user manager
fails a background start visibly; `mc run` in the foreground does not require
the manager.

The persistent unit is a `Type=oneshot`, `RemainAfterExit=yes`, `Restart=no`,
`KillMode=control-group` adapter wanted by `default.target`. It runs the
absolute Node and mc entry with `run start --if-was-running`; it has no
`ExecStop`, PID file, supervisor or watchdog. Explicit successful starts
rewrite the unit only when its content changes, daemon-reload only after a
change, and enable it without `--now`; they never stop or restart an existing
cgroup. Unit environment is restricted to resolved `HOME`, `PATH`, `MC_HOME`,
`MC_WORK_ROOT` and `MC_REPOS_HOME` values. Unit paths and arguments use
systemd quoting with specifier and environment expansion escaped. Credentials,
shell directive flags and runtime successor/session identity are not persisted.

Enabling the unit is not proof that it can start before login. mc reports
manager and installation errors and reads `loginctl`'s Linger state; with
`Linger=no` it reports boot recovery not ready and gives the interactive remedy
`loginctl enable-linger`. mc never invokes sudo or changes lingering. The
unit's `active (exited)` state says only that the oneshot adapter ran, not that
the runner remains healthy. An automatic start requires runner state proving
that a runner previously existed and no STOP; it never removes STOP. Explicit
start and an explicit update takeover can consume the STOP they claim under
the local lifecycle gate.

Linux runner ownership transitions use one stable `runner/lifecycle.lock`
inode separate from the register lock. The short gate is util-linux `flock`
with a five-second bound and a pipe-held `/bin/cat` helper; only local
synchronous state transitions run while held. Reservations and owner records
carry generations and Linux boot ID/process start time. Before the gate, a
source-installed runner inspects its own checkout's short `HEAD` through the
runner's Git dependency and records it on admission when available. No checkout
or a failed inspection leaves the commit absent; it does not change admission
authority. Corrupt state and a live owner with an unverifiable identity refuse
admission or signalling.
Repeated handovers retain a deduplicated list of every verified live drainer
alongside the immediate predecessor; session lanes held by all live drainers
remain excluded and count against the configured total. STOP is written and
the full owner snapshot taken under the gate; forced signals are identity
checked outside it and cleanup is conditional on the same owner generation.
Loss of an admitted owner's generation permanently revokes its authority,
even if its successor is dead or the state is missing/corrupt. An exiting or
STOP-rejected owner retains all live draining identities, including those
without lane files; a new claim over a dead newest owner inherits them and
never clears unrelated live current files. No OS shutdown hook writes STOP.

The opt-in `scripts/check-linux-runner-service.mjs` exercises the delivered
unit, scope, gate and lifecycle against an isolated real user manager and
reports cleanup and a SHA/manifest. Its real systemd/cgroup evidence is not a
reboot test. Before real workloads, TC still requires interactive lingering
setup and separate no-login reboot checks after a running start and after a
deliberate STOP. Neither the deterministic runner gate nor the opt-in check
establishes those operational acceptance results.

Run the isolated software check from the judged source root on TC:

```sh
/home/martin/.local/bin/node scripts/check-linux-runner-service.mjs \
  --scratch /tmp/mc-linux-check-<unique-id> \
  --output /tmp/mc-linux-check-<unique-id>.json
```

Use unused absolute paths. Export committed source first with
`mc scratch export --repo memoro-cli --ref <judged-sha> --path src --path scripts --path package.json --path package-lock.json --json`
and transfer its receipt and manifest; verify every file after transfer. This
is not a goal checkout or a replacement for TC's installed checkout. The check
runs actual generated boot units, runLoop reservation claims, competing starts,
updates, chained drains, stop and independent-root isolation; only external
coding/Git/network/chores inputs are inert. It reports exact received boot
environment, command arrays, identities/cgroups, timings and cleanup.

**Separate interactive operational acceptance (not authorized by the script).**
Before real workloads, Martin provisions lingering interactively and installs
the accepted release on TC. Use an empty, authorized root and record its paths,
release SHA, original lane total and flags. On TC, explicitly:

1. Run `loginctl enable-linger`, then `loginctl show-user "$USER" -p Linger`.
   Run `mc run start --no-merge --no-caffeinate` (or the agreed flags).
   Record `cat /proc/sys/kernel/random/boot_id`, `cat "$MC_WORK_ROOT/runner/runner.json"`,
   `mc run lanes`, `systemctl --user list-unit-files 'mc-runner-boot-*'` and
   `cat /proc/<owner-pid>/cgroup`. Record enabled state for this root's unit.
2. Martin runs `sudo reboot` interactively. Do not log in locally or by SSH
   until the host has had time to boot unattended. Then reconnect with
   `ssh tc` and record the changed boot ID, `loginctl show-user "$USER" -p Linger`,
   `systemctl --user status <root-unit>`, owner JSON, process identity/cgroup
   and saved arguments. Verify exactly one entitled runner and no STOP.
   Distinguish its pre-SSH start time from the later checking login; an
   active(exited) adapter alone is not runner proof.
3. Run `mc run stop`, allow all held work to complete, and verify STOP remains
   and the owner processes have ended. Martin runs `sudo reboot` again.
   Wait without login, reconnect, record changed boot ID and confirm STOP is
   unchanged and no runner was admitted. Run `mc run start` explicitly and
   verify exactly one owner and the unchanged lane total.
4. In separately authorized bounded work, verify update keeps predecessor
   sessions completing without duplicate admission, including STOP during
   update. Retain identities, session completion and unchanged lane settings.

These interactive results must be recorded separately before workload
activation. Neither a successful isolated script nor prior VPN/SSH reboot
evidence certifies them. Root retirement on transfer is the transfer plan's
responsibility; enabling a new canonical root does not retire the old unit.

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
2. Consider `build · ready` with criteria, `review · ready`,
   `merge · blocked`, or `merge · ready` after its first red or moved head
   and once it is no longer in the merger's line. A merge failure or a queued main-red request wakes a mend session; legacy blocked work outside merge is reconciled to Martin without a launch; `finish · ready` (a name kept for old records) is moved to `build · ready` with a log entry before any session starts, and a build in `build · ready` after a review's rejection is a repair build. `Martin`
   waits for the desk decision pass, not a delivery session: this includes a
   goal reported by `mc goal defect` and one stopped after three build sessions
   without progress (`no progress:`; *What a build session does* in
   [mc-goals.md](mc-goals.md)), which start no session until `mc goal ready`. A `build · ready` goal whose last entry is the runner's main-red wait (*What a build session does* in [mc-goals.md](mc-goals.md)) is held while a main-red repair of one of its repositories is queued, running or published. `draft · ready`, `done` and `dropped` do not start a
   delivery session. A focused plan session may complete the next draft under the programme rule below, and a recorded open programme signed and not yet cut gets the programme planning turn (*Programme planning turn*).
3. Hold any goal whose phase is not open in its programme. The runner reads
   each programme's record at every pick (`programmeOrder`), as it reads
   `PRIORITY.json`, so a dependency stated, removed or renumbered counts at the
   next pick without a restart. A sequential programme (no record, or one
   without `phases`) holds a goal that has an unfinished goal in a lower phase;
   a programme whose record states its phases holds a goal whose phase waits for
   a phase with an unfinished goal, and a goal in a phase that waits for none
   runs beside every other. A programme whose record is invalid holds every
   goal, plan session included, and the runner says so once per programme while
   it lasts, in `runner.log`. All goals of an open phase can run side by side;
   there is no separate queue file. The rule is `phaseStanding`
   ([mc-goals.md](mc-goals.md), *Phases*).
4. Exclude goals already claimed or named by a live current file, held goals
   (`.hold.json`; `hold` in [mc-goals.md](mc-goals.md)), goals whose valid
   programme record is `draft`, and goals whose first
   repository is not served by the lane. A review without an
   available route does not stand in front of other work.
   The draft hold says `waits for sign-off of <programme>`, once while it
   lasts. It is re-read during admission, before spawning plan, build, review
   or mend, not just at the pick. A running session finishes normally; neither
   the merger's queued work nor the runner's landed-PR reconciliation is held.
5. Take merge-failure mend and goal-less main-red mend first, then decision, a repair build, review, then an ordinary build; the programme planning turn and next-draft planning follow build, then the programme archive turn ([below](#programme-archive-turn)), and the manager's turns ([below](#the-managers-turns)) come last. Pre-merge blocked work wakes no session and is reconciled to Martin. Within the earliest runnable rank, repository fairness
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

The end follows a fixed order. The runner writes the end marker, then the
session's finalized logs (`writeSessionLogs`), and only then awaits
`mc scratch sweep` for this session's scratch directory, in a child process
bounded at 120 s, so the event loop is not held. The sweep removes this
session's own registered source exports, rechecking each candidate immediately
before removal with fresh activity, ownership, source and content evidence
(`mc-tidy.md`, Registered source exports); it never scans other scratch,
evidence, worktrees or caches. The same rule runs for a successful, failed or
interrupted-but-resolved session. A refused or failed sweep is recorded as
cleanup in the runner log, and its exports stay for the next tidy pass; it
changes no session exit, goal verdict or provider classification. Routine and
pressure tidy remain the retry path, so nothing here adds a time-based rule.

## The session

`runGoal` works in the first repository's existing goal worktree and keeps its
branch. An unbuilt branch is remade from origin/main before its first build
when it has no commits of its own. Main advancing alone does not justify
synchronization; necessary dependency, acceptance or conflict integration is
owned by the working session under mc-goals.md, *Integrating main into a goal*.
A missing worktree is recreated on its goal branch when possible. A missing
role or tool skips launch; a worktree failure is recorded in LOG.md. The
prompt includes the rendered goal (its numbered parts, its documents and criteria), and the
role tells the session to read LOG.md first.

- A build uses `build-session:goal` and the goal's `fast`, `medium` or `large` class.
  It gates, commits and publishes with `--no-merge`. It ends with `mc goal log`,
  moving to review only once every criterion has been checked and met.
- A review uses `review-session:goal`, the open PR and its head. It judges,
  never builds: it writes REVIEW.md in its fixed form, then `mc goal stage merge`
  sends all registered PRs to merge, or `mc goal stage build` returns the goal to
  build (a third rejection stays in review, set Martin). A second review is narrow:
  its prompt names the first review's heads and failed items, and lists the
  untouched areas the diff tripped. A review that dies still in review
  is retried once, then waits directly on Martin if it dies again.
- A repair build uses `build-session:goal` on the `finish` catalog list, not
  the goal's class, on a goal in `build · ready` that a review rejected. Its
  prompt names REVIEW.md and the NOT OK ids (or says the file is in the old form).
  The run row's kind is `repair`; it ranks as finish did. It fixes what review
  found, gates, publishes and moves the goal to review.
- A goal mend uses `mend-session` for merge failures (conflict, failed candidate check or moved judged head), repairs and requeues merge. Pre-merge blockers are resolved in-role or sent directly to Martin. The first two failed merges run mend; its ready result retries delivery. The third failed merge waits on Martin. Both run in the goal's worktree, a repair build on the finish list and mend on the mend list (never the goal's class), and write the merge handoff when they queue. See
  [repair and mend](mc-goals.md#repair-and-mend). Planning is a separate next-draft assignment under the rule below.

These are fresh sessions, not a resumed execution chain. If a session ends
after handing its goal to merge, its lane is available for the next assignment
without waiting for the merge. The merger lands goal PRs through the ordinary
round on the current base, reusing the session’s whole-selection receipt (exact
or delta) and measuring the rest; it does not re-check criteria or the reviewed
head. `mc goal stage merge` writes a handoff receipt in the
session's scratch directory after queueing every PR. The runner checks it
every 250 ms, ends its own launched child, and releases the current file,
slot and goal/programme claims after the child closes. Partial queue failures
write no receipt and leave the session able to retry. A review must
write its records before the final stage command.

If a session ends
without writing a log entry, the runner writes one; three such build ends
in succession set the goal Martin; the stage stays build. A normal build end with more work
leaves it build · ready for the next session.

A session that ends because the API server cannot be reached (`apiInterruption`
kind `offline`: `connection_failed`, or the result says `Can't reach the API
server`, ENOTFOUND, ECONNREFUSED or ETIMEDOUT) is no answer about its goal: it
writes no runner entry and records no refusal, and its `runs.tsv` note is
`offline`. It holds every new model session of any kind — build, review, repair,
mend, the helper and the intake — for `offlineBackoffMs(n)`: a
minute, doubling, at most fifteen, with `n` the offline endings in a row. The
hold is in memory, so a restart starts without one. A session that ends any
other way clears it and resets `n` only when it started after the hold was set.
A session that started before the hold ends without clearing it, and the runner
says so in one line. Sessions already running are otherwise untouched.

### Launch settings

`mc model priority [auto|codex|claude|agy]` saves one global provider preference in
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
its menu's `priority auto|codex|claude|agy` command writes through `mc model`.

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
  `-c model_reasoning_effort=<level>`; agy takes its effort in the model slug
  (`gemini-4-argon-high`) and gets no effort flag, so the catalog refuses an agy
  candidate whose effort differs from its slug's level (`mc model add` and `set`
  say so, exit 2). Codex's model goes to
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
agy -p '<role instructions> --- TASK --- <task>' --output-format stream-json|json \
    --dangerously-skip-permissions --disable-slash-commands [--model <slug>] [--conversation <id>]
```

agy has no instructions flag: the role's markdown leads the one `-p` argument,
behind a `--- TASK ---` separator, and a resumed conversation (`--conversation`)
gets the task alone. A session whose output mc reads whole (plan review, the
helper and manager turns) takes `--output-format json`; plan review adds
`--add-dir <checkout>` before it. That one argument stays within Linux's 128 KiB
single-argument limit (`MAX_ARG_STRLEN`); the largest role text is about 18 KB
with the shared text. agy's output is read by the `agy-stream` reader: the
`result` event's (or the json object's) `status`, `response`, `num_turns`,
`usage` and `error`, tokens as reported (`input_tokens` is the uncached input,
`output_tokens` holds the thinking, cache reads are read beside the input and
never subtracted). A non-`SUCCESS` status, an `error`, a non-zero exit or an
empty stdout at exit 0 is a failed session; a quota text is `quota`; a missing
sign-in or a locked keyring is a `login` refusal, which agy's plan counts as a
plan refusal (`LOGIN_REFUSES_PLAN`).

`AUTOCOMPACT_TOKENS` (150 000) bounds Claude's context; Codex has no equivalent
flag here. Both use the shared instruction assembler and their native tool
adapters. Native delegation is the tool's; mc starts and counts no subagents.
Claude's allowlist stays narrow and strict MCP configuration excludes
user-level servers.

**Installing agy** is Martin's act, once: put `agy` on the runner's `PATH`, sign
in (`agy` once, interactively), and leave the `login` keyring collection
unlocked, since agy keeps its sign-in in the Secret Service and a locked
collection reads as a login refusal. The runner's child already has the user's
D-Bus session bus, so mc adds nothing; an empty-password login keyring, or
unlocking it at login, lets an unattended session reach it. Then add agy to
the catalog with `mc model` (`mc model add review agy:gemini-4-argon-high:high`,
`mc model priority agy`); the defaults already list it first in review. agy
also runs the interactive entrances `mc plan`, `mc martin` and the server's
`mc session`, in the terminal that starts it
([mc-interactive-sessions.md](mc-interactive-sessions.md#a-tool-that-lives-in-the-terminal-agy)).
The retired `mc helper` desk is not one of them.

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
ts name kind exit seconds pr turns input output cache_read cache_write session note land_seconds model class tool effort billing cost
```

`cost` is the session's list-price cost in dollars, priced when it ends
([mc-status.md § The cost estimate](mc-status.md#the-cost-estimate)); `-` for
chores, merge rows and rows written before 2026-11-09. The file keeps the
header it was created with; readers take a shorter header that is a prefix of
`RUNS_HEADER` as `RUNS_HEADER` (`readRunRows`, landed.js).

The page reads these files, not a transcript to infer the goal's state.
Dropped goals are finalized and archived immediately through the shared drop
operation on ordinary reconciliation, even without a stage timestamp. It
closes exclusively owned PRs, cancels their queue rows, preserves PRs with an
unfinished co-owner, and retains failed/unsafe cleanup for retry without
starting a recovery session. Done goals are archived the same way at the next pass, with no hold, each with
one row in `goals/goal_log.md`; a goal a live session owns is left for the pass
after the session ends, with no log entry, and any other archive refusal is
recorded once. Every five
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

Every MC session starts on its selected provider's subscription. agy runs on
its plan only: it declares no API route, so the reserve below never launches it
and an agy candidate that is spent or refusing is passed by, never routed to a
key. A current plan
window below 100% remains eligible. At 100%, or after that provider refuses a
plan request, the next launch uses its API key through the local billing gateway.
This applies to every current MC session path: build, review, repair, mend,
helper, and interactive sessions. An ordinary interactive `mc plan` still lets
Martin choose the tool and model; billing follows that choice. A repair build or
mend session runs on its own catalog list (finish, mend; `finish` is the list's name, kept), never the goal's
class, and is billed as any other session. `mc run --billing` shows both providers' next routes. The MC page shows
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
An interactive session (`mc plan`, `mc martin`) is the exception: its grant names
no model, because `/model` inside the session changes it, and a grant on the
launch model refused every request after the switch.
Linux SSH Claude background sessions use a detached gateway holder rather than
letting the attaching client own the wrapper. It shares the wrapper's key-opening,
API-switch recheck and grant construction. The holder outlives both `--bg` and
`attach`, serving the same 500-request, 12-hour grant until the provider pid dies
or the grant expires. The grant reaches Claude only through settings env
`ANTHROPIC_BASE_URL` and `ANTHROPIC_AUTH_TOKEN` in a 0600 file in a 0700 directory
under `runner/claude-background/`; cleanup removes it on death or expiry. The
provider key is opened only in the holder, never in the attaching client.
A Linux SSH Codex entrance session on credits runs its own `codex app-server`
behind the same gateway wrapper: the wrapper is the long-lived parent of the
server (and so of the session's tools) with the grant in the server's
environment, and lives until the server dies or the grant expires. Its optional
`--session-directory` mode stops the server at `expiresAt` and removes its
directory and register entry, leaving a one-shot expiry status for the next
entrance. Both providers' persistent credit sessions end at their bounded grant
expiry, without renewal; the conversation can be resumed in a new session.
Plan sessions have no grant clock. The terminal's `codex --remote`
client holds no grant and no key. See
[mc-interactive-sessions.md](mc-interactive-sessions.md#codex-its-own-app-server).
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

A goal names a work class, `fast`, `medium` or `large`, not a model, and the class
routes the goal's build sessions only. Every other unattended role runs on its
own catalog list, whatever the goal's class: `review`, `finish` (a repair build), `mend`, `plan`
(the runner's next-draft planning), `manager` (an unattended manager turn
without an explicit tool or model) and `decision` (desk items). A role list never borrows a class's
candidates: with none of its own usable and its API off, the session waits
(Martin, 2026-11-09). Interactive `mc plan` and `mc martin` keep their own
selection. The route
is decided locally, before a tool is launched, from the catalog
(`~/mc/runner/models.json`) and the capacity snapshot
(`~/mc/runner/model-capacity.json`). Choosing spends no model turn and reads no
account. The snapshot is refreshed by sessions that run anyway, and by
independent read-only collectors due at startup and every 15 minutes for both
providers. Every list is judged by the same capacity, provider-priority,
bootstrap and API-reserve rules over its own candidates; review adds one. Decision instead takes the first usable subscription candidate in catalog order, including unknown-Claude bootstrap; only when none is usable does the usual API reserve apply.
Review ranks usable subscriptions by provider priority, then
headroom; ties avoid the build model, then follow catalog order. Codex needs a
fresh successful capacity observation listing the model and effort. Auto mode
retains unknown-Claude bootstrap only when no candidate has measured usable
capacity. Explicit Claude priority may also attempt its subscription with
unknown, stale, failed or reset usage ahead of known Codex capacity; unknown
does not mean zero. With no usable subscription, priority orders API reserve
candidates. The review waits when the selected API is off.

**Review's first candidate is its first choice.** Whenever the catalog's first
review candidate can run (not refused, not exhausted, its tool launchable, and
either known under the plan limit or unknown on a tool that bootstraps) review
takes it, whatever the others' headroom, and a provider priority does not
outrank it. Only build-model avoidance does: when the first candidate's model
built the goal, or in plan review when it wrote the text, the ranking above
chooses, as it does among the rest when the first cannot run. The API reserve
takes only a candidate whose tool declares an API route; a list whose
candidates have none waits, naming each and "no API route". A candidate whose
tool cannot be launched here (agy not on `PATH`) is *unavailable*, never
chosen, and review falls through to the next.

**The catalog** is Martin's. `mc model` is its only writer, and the file is
written whole or not at all:

- `mc model [list] [--json]` — the candidates of fast, medium, large, review, finish,
  mend, plan, manager and decision, each a numbered list in catalog order, and whether
  they come from the file or the defaults.
- `mc model priority [auto|codex|claude]` — show or change the provider
  preference for unattended launches; an absent setting means `auto`.
- `mc model add fast|medium|large|review <tool>:<model>:<effort>` — appends a candidate;
  `add` takes finish, mend, plan, manager and decision as well.
- `mc model remove fast|medium|large|review <tool>:<model>` — removes the candidate
  with exactly that tool and model; a list keeps at least one. `remove` takes
  every list as `add` does.
- `mc model set review <tool>:<model>:<effort>` — replaces the whole review
  list with that one candidate; `set` takes finish, mend, plan, manager and decision as
  well, never a work class.

With no file, the defaults are: `fast`, `claude:haiku:high` then
`codex:gpt-6-luna:high`; `large`, `claude:opus:medium` then
`codex:gpt-6.1-sol:high`; `medium`, `claude:sonnet:high` then
`codex:gpt-6.1-terra:high`; review, `agy:gemini-4-argon-high:high`, then
`claude:opus:medium`, then `codex:gpt-6.1-sol:medium`; finish, `claude:opus:high` then
`codex:gpt-6.1-sol:high`; mend, `claude:sonnet:medium` then
`codex:gpt-6.1-sol:medium`; plan, `claude:opus:high` then
`codex:gpt-6.1-sol:high`; manager, `claude:opus:medium` then
`codex:gpt-6.1-sol:medium`; decision, `claude:fable:high` then
`codex:gpt-6.1-sol:high`. A file without finish, mend, plan, manager or decision reads
that list from the defaults; a file without `medium` also reads its default.
Missing defaulted lists are written back with every list the first time
`mc model` changes it. A file whose
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
- **agy is read by `agy -p /usage --output-format text`** (`agy-capacity.js`,
  the `agy-usage` reader), at startup and every 15 minutes, in the runner's
  environment less the provider API keys and agy's dropped variables, bounded to
  60 s and 1 MiB; agy has no usage API. Per model group it takes "Five Hour
  Limit Remaining" and "Weekly Limit Remaining" percentages (fraction used is
  one minus remaining) and the tightest group is the provider's. Only what was
  read is stored: a window with a printed reset is a window; one with none is not
  stored, reads *unknown*, and agy bootstraps on it (no reset is invented); a
  window at its limit with no reset is a refusal until the read's time plus the
  quota sleep, renewed by each read while it stays full. Output holding no limit
  line is a failed read: the last valid snapshot is kept and marked failed, the
  choice is judged on it, and the reader stops for the life of the runner after
  the first one (the runner log says so once), so a `/usage` that agy took as a
  prompt costs one turn, not one per poll. The format is documented, not
  recorded (`tests/fixtures/agy/README`).
- **A plan refusal is written by every unattended caller.** A session whose
  read is `quota`, or a `login` on a tool whose plan counts it as a refusal
  (agy, claude), on the plan route, is written as the provider's refusal until
  the reset it names, else for the quota sleep, by one function
  (`plan-refusal.js`) the runner's `refuseProvider`, plan review, the helper
  and manager turns, the learning pass and desk preparation all call; a write
  that fails is said and the session's result stands.
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
  `five_hour`/`seven_day` usage only, never overage credits. Each Claude window
  is validated on its own, by the same rules (finite `utilization` from 0 to
  100, a strict `resets_at` instant). A read counts when one window validates;
  a window that does not keeps the last valid observation and is named in the
  runner log by window and one of four words, `absent`, `not an object`,
  `utilization` or `resets_at`, never by a value. A response with no valid
  window is a failure, and its log line names both windows and their words.
  Neither provider's credentials or raw response is logged/persisted. Each collector is bounded
  to 20 s and 1 MiB. Failures retain the last valid snapshot and record attempt
  and failure. Claude's passive stream observations remain supplementary.
- **Not verified live.** Controlled fixtures test the collectors; the fixed
  Claude request/auth contract was matched to inspected installed-tool code.
  No live provider request, login or model run was made. The polled Claude
  response itself has still not been seen: every `rate_limit_event` in this
  runner's Claude session streams from 2026-11-01 to 2026-11-14 carries
  `seven_day` and none carries `five_hour`, so an absent or null `five_hour` is
  the likely refusal (an inference). The runner log names the refused window
  when a read fails. Codex account type is inferred from the successful capacity
  response.
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

After intake and the model-free desk item sync, `runDeskPreparation` takes up
to three new items, oldest first, serially. Each gets a fresh fifteen-minute
headless turn in its item directory, with `MC_ROLE=desk-prepare`, no goal
identity and the tool/model/effort from `routeClass('medium')` only. No usable
candidate means wait. A per-item claim excludes concurrent manual preparation.
Quota endings pause as intake does. Each started turn writes `kind: desk-prepare`
in `runs.tsv`, with the item id as `name`, routing/usage and list-price `cost`.
The off-by-default shared daily desk ceiling is checked before every turn; a
hold is said once per round. Failed-attempt fallback, manual preparation, role
authority and the setting are defined in [mc-martin.md](mc-martin.md).

Right after preparation each chores round reconciles lessons with their goals
(`reconcileLessons`: an `in-goal` lesson whose goal is done becomes `landed`
with its pull request, one whose goal was dropped becomes `open`), then
`runLearning` starts the learning pass when it is due: five or more open
lessons, or one open seven days; at most one session a UTC day (marker
`~/mc/runner/learning.json`), none while the desk ceiling is reached. The
session has `MC_ROLE=learning`, `MC_HEADLESS=1`, a sixty-minute limit, the first
usable `routeClass('decision')` candidate and `~/mc/martin/lessons/` as its
directory, and writes a `runs.tsv` row of kind `learning`. Quota endings pause
the runner. When the decision pass has failed twice on an item the runner also
writes its `unsettled` lesson. See [mc-martin.md](mc-martin.md) § *Lessons and the
learning pass*.

No external supervisor is needed. The runner's chore pass — the
helper's collect, the intake drain, the tidying — ends with one more chore, the
**full runs** (Martin, 2026-11-13; they follow main since 2026-11-15, with no
once-a-day gate): every pass, `runNightly` asks `fullRunDue` of each repository and
starts, without waiting for it, `mc test <repo> --full` for each repository whose
origin/main moved since its last measured full run and that has no full run in
flight, as a meter beside the sessions and the merge rounds. One run per
repository at a time across chore passes (the runner keeps the map). It takes no round lock and no lease and measures in its
own checkout, so no merge round waits for it, at 2 test lanes
(`MC_FULL_RUN_LANES`). A `kind: nightly` row goes in `runs.tsv` only for a pass
that started a run. A chore pass with STOP or UPDATE present starts none, the
chore loop ends the runs in flight before the runner leaves, and `--once` runs
no chores and so no full run. The detached scheduler that once did this
(`mc test nightly start`, a pid file) is deleted; `mc test nightly status` says
where the full runs now come from. See [`mc-merge.md`](mc-merge.md) § *The full
run nobody asks for*.

**The check after a deploy** is the last step of every chore pass
(`runDeployCheck`, `deployCheckTick` in `deploy-check.js`): it starts, detached,
the check of the oldest deployed row that has no verdict, settles an attempt that
died or passed its deadline, and copies a verdict file into its row. One start per
pass; none under STOP or UPDATE, none while a deploy runs, none while a check is
alive; a tick that throws is said (`deploy check: the pass failed — …`) and asked
again on the next pass. It writes `~/mc/runner/deploy-check.json` and
`~/mc/runner/log/deploy-check/`, and a verdict into `deploys.tsv`. A red is
reacted to by `take-back-run.js`, which the check starts itself when it records the
red. See [`mc-deploy.md`](mc-deploy.md) § *The check after a deploy*.

**The take-back fallback** is the first step of every chore pass
(`runTakeBackFallback`, `takeBackTick` in `take-back-run.js`), before the log
rotates, the helper day and the desk turns: it starts a take-back reaction,
detached, for every red row the red ledger does not show done when none is alive,
and writes `desk: ended` for entries a later deployed row ended. The first pass
only begins the ledger (what was red before it is not a reaction's to make);
none starts under STOP or UPDATE; a tick that throws is said (`take back: …`) and
asked again on the next pass. See [`mc-deploy.md`](mc-deploy.md) § *The take-back*.

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
time, then goal name; a selected draft waiting on Martin or held (`.hold.json`, which a draft created without `MC_HEADLESS=1` carries from creation) cannot be bypassed.

That is a sequential programme's trigger. For a programme whose record states
its phases the trigger reads each phase: a phase whose goals are all `draft`,
`done` or `dropped` and which is open offers its first draft when that draft is
ready, not held and not decision-claimed; one that is not offers none, and holds
only its own phase. Goals building, held or waiting on Martin in other phases do
not hold it, but at most one plan session runs in the programme at a time, told
from a delivery session by its kind in the current record, so a plan session
whose draft has moved to build still counts and a build, review or mend session
on another phase does not. The recheck after admission asks the same.

The runner offers this assignment after build in the existing lane picker.
Claims and live current records prevent concurrent planning in one programme,
including across runner handover. Recheck the programme and the hold after admission awaits
before spawning. Use the selected goal's first repository worktree, role `plan`,
kind `plan`, `MC_GOAL` and `MC_HEADLESS=1`; keep the normal routing, admission,
provider refusals, offline holds, STOP and UPDATE behavior. Interactive planning
checkouts are not runner work areas. The assignment is to finish the brief and
reconcile the README and phases, then move that draft to build. An unresolved
choice goes through goal-bound mc ask. An ordinary completed plan session
leaving draft ready waits on Martin with an incomplete-session diagnostic,
preventing an unchanged-work launch loop. A goal that is held when its session ends, of any kind, gets no status, stage or entry from the runner; after release it is taken up from the state its holder left. Provider refusals and offline endings
retain normal retry behavior and are not evidence of planning failure.

No draft means no plan session. Proposal arrival and daily proposal processing
remain outside this trigger. See [next draft planning](mc-goals.md#next-draft-planning).


## Programme planning turn

Martin, 2026-11-15, 2026-11-16: a programme whose record Martin signed is cut
into its phases and goals from the signed document, with nobody present. The
signature is the trigger, not the absence of goals: `mc programs sign` writes
it, and a programme with no record, an invalid one, a draft one, a legacy one
or an area record starts nothing (the programmes' rules are in
[mc-plan.md](mc-plan.md#a-programme-with-a-record)). `programmeDue`
(`programme-turn.js`) is model-free and reads at every pick. A turn is due when
all hold:

- the record is valid, `open`, signed (`signed_text` set) and not `legacy`, and
  `README.md` exists;
- `cut_text` is not `signed_text`: the signature has not been cut yet. Goals
  already in the programme do not stop a turn, so a re-sign is cut again from
  the new document and the goals of an unchanged part stay;
- no open desk item of kind `programme` has the reference `programme:<p>`;
- when the record names a horizon, that horizon reads `open`.

Otherwise no turn starts. A horizon that is missing or not open, a record that
is invalid and a state file that is unreadable are each said once in
`runner.log`; a programme that simply is not due is silent.

**The session.** One turn runs per programme and it is named `programme:<p>` in
the claim and the current record, kind `plan`, class large, with a `runs.tsv`
row and the programme directory as its cwd. Role `plan`, `MC_HEADLESS=1`,
`MC_PROGRAMME=<p>` and no `MC_GOAL`; routing, admission, provider refusals,
offline holds, STOP and UPDATE are those of every session. It never uses a
`plan/<programme>` worktree and commits nothing: the served repositories are
given as read checkouts at `runner/work/programme-turn-<p>/<repo>`, detached at
origin/main. The prompt is `programmePlanPrompt` (`run-plan.js`), and the plan
role's headless programme-turn section says the rest. SIGNED.md is the only
source: the session cuts the programme from it, one or more goals per part,
each naming the part it carries as `Part <n>` in the label of a `documents`
entry whose path is the programme's SIGNED.md (a path that resolves to another
file counts for nothing, and no part range is read). It copies the part's
Solution, Design and Proved by into the goal and decides nothing the document
does not; a part already built gets a goal for the difference only, and the
goals of an unchanged part are kept. Dependencies of a stated programme are
stated with `mc programs after`. A choice the document leaves open is not
settled and not asked by the session: it returns the programme with
`mc programs return <p> --reason "<part and choice>"` and ends (the record is
`draft` again and no turn starts until the next sign-off). Only a question that
is not such a choice is asked, with a goal-bound `mc ask` on the draft that
needs it (one way to ask: jev, then a reader), and the other drafts go on. Drafts it
leaves are not set to Martin: the next-draft sessions take them. Proposals are
not processed.

**The cut.** After the session `finishTurn` reads the record again under the
runner lock and reads the signed Part headings (`### Part <n> — …` inside
`## Parts`, fenced blocks ignored) against the parsed live and archived goals
(`partsCut`, no stage excluded). The ending is one of:

- `cut`: SIGNED.md still matches the signature the turn launched on and every
  part is named by a goal. `cut_text` is set to that signature in the record's
  one atomic write, and the other fields are read fresh and kept;
- `returned`: the record is `draft` again (the session returned it). Success; the
  earlier `cut_text` is kept and no turn starts while it is draft;
- `resigned`: the record carries a newer `signed_text` than the turn read.
  Nothing is cut and nothing counts; the next pick cuts the new signature;
- `settled`: the record is `done`, `dropped`, legacy or gone, or carries no
  signature. Nothing is written and nothing counts;
- `incomplete`: the record is as launched but SIGNED.md is missing or does not
  match it, names no part, or a part is named by no goal. A failure (below).

`runs.tsv` notes say `cut from the signature`, `returned to draft` or
`not cut (<problem>; …)`.

**Next-draft planning waits.** While a programme turn is claimed or current in a
programme, no next-draft plan session starts in it: the sequential pick filter,
the stated-programme pick filter (`planSessions`) and the recheck after
admission (`skipped:programme-changed`) each ask it, and the turn holds the
programme until it ends.

**Read checkouts.** Before the launch the runner fetches every served
repository (a fetch failure ends the pick for that programme and counts
nothing), then makes each checkout. A leftover is replaced only if it is clean
(`status --porcelain` empty) and its HEAD is reachable from origin/main
(`merge-base --is-ancestor`): it is removed with `git worktree remove`, without
force, and added again. A dirty or unreachable leftover is never touched: the
turn does not launch, the refusal is a failure with the reason
`read checkout retained: <path>`, and the line is said once in `runner.log`. A
checkout made earlier in the same setup is undone. Another add failure is a
failure with the reason `setup: <git's last line>`. After the session the
checkouts are removed, and any a refusal kept are named.

**Failure.** A session that ends `incomplete` or fails to read the record is a
failure, with its reason (`planning session exited <n> without a goal naming every
part of the signed document (<problems>)`) and its log kept in
`runner/programme-turn/<p>.json`; a `cut`, `returned`, `resigned` or `settled`
ending counts none.
Provider endings (quota, offline, refused login), a refusal at admission and a
fetch failure count nothing. The first failure retries on the next pick. The
second opens a desk item of kind `programme`, reference `programme:<p>`: the
first such item is `prepared`, with a model-free `prepared.md` of the failures
and their logs, so a decision session repairs it; a later one is `for-martin`,
sort `mechanical`, `reversible: false`, `due_at: null`, with a `brief.md` in
Swedish. No turn starts while an item is open. A failure is counted again only
after the item closed. The item closes by source when the signature is cut (every signed part is
named by a goal), the record carries no signature, no longer reads valid and open,
or the directory is gone, and
by decision otherwise ([mc-martin.md](mc-martin.md#durable-desk-items)). A state
file that cannot be read starts no turn and counts nothing; the runner says it
once in `runner.log`, the desk sync reports it and the item stays open.

## Programme archive turn

Martin, 2026-11-15: a programme with a record is bounded. Once every goal is
done or dropped, the runner checks that what the programme made true is written
into `docs/technical/` and the area pages, archives the programme and sets its
record to `done`, with nobody present; the manager's horizon turn then follows
the horizon without it. Only a programme **with a valid record** is touched: one
without a record, or with an invalid one, is never read or archived by the
runner, and `mc plan <p> --archive` stays that programme's person's act
([mc-plan.md](mc-plan.md#archiving-a-programme)). The write-back is also judged in
each goal's own review (`write-back:` line, [mc-goals.md](mc-goals.md#the-verdict)).

`archiveDue` (`archive-turn.js`) is model-free and reads at every pick. A programme
is due when all hold:

- the record is valid and `open`;
- `goals/` holds no live goal (a dot-entry is none), and `goals/.archive/` holds at
  least one done goal: a programme whose goals were all dropped made nothing true
  and is never read or archived;
- no desk item of kind `archive` with the reference `archive:<p>` is open;
- no reading of it runs (the claim `archive:<p>`);
- no OK reading is kept for exactly the current done goals (then only the archive
  is retried, below).

**The reading.** One headless read-only session per programme, role
`archive-reader` ([mc-roles.md](mc-roles.md)), kind `plan`, class large, with a
`runs.tsv` row, the programme directory as its cwd, `MC_HEADLESS=1`,
`MC_PROGRAMME=<p>` and no `MC_GOAL`; routing, admission, offline holds, STOP and
UPDATE are those of every session. It commits nothing. The served repositories of
the done goals and every repository that declares areas are given as read
checkouts at `runner/work/archive-turn-<p>/<repo>`, detached at origin/main (the
rules of the *Read checkouts* of the planning turn: fetch failure counts
nothing, a dirty or unreachable leftover is never touched). The session writes
`WRITE-BACK.md` in the programme directory: one `read: <repo> <sha>` line per
checkout (the sha the runner read at the checkout, so a reading is of a known
tree), one line per done goal (`<goal>: OK — <repo>/docs/technical/<page>.md §
<section>[, …]`, `<goal>: OK — none — <reason>` or `<goal>: NOT OK — <what is true
that no page says>`) and a last `verdict: OK` or `verdict: NOT OK`. A line is
parsed without a model (`parseWriteBack`); a missing or malformed file, a done
goal with no line, a wrong sha or `verdict: OK` beside a NOT OK line is a failed
reading.

**What follows a reading.**

- *OK:* the reading is kept in `runner/archive-turn/<p>.json` for the done goals it
  judged, and the archive follows in the same pass.
- *NOT OK:* a finding, not a counted failure. It opens one desk item of kind
  `archive`, reference `archive:<p>`, `prepared`, sort `mechanical`, with a
  model-free `prepared.md` carrying the NOT OK lines: a decision session writes
  the missing statement and closes it by decision, and the programme is read
  again. A NOT OK reading after an item was closed by decision opens it
  `for-martin` (sort `mechanical`, `reversible: false`, with a Swedish `brief.md`).
- *A failed reading* (malformed file, no file, a session that ended without
  one) is a failure counted in the state file with its reason and log. The first
  retries on the next pick; the second since the last item opens the `for-martin`
  item. Provider endings (quota, offline, refused login), a refusal at admission
  and a fetch failure count nothing.

No reading, archive or record write starts while an item is open. The item closes
by source only when the programme directory is gone from the programmes home (and
no destination named in the state still has a record that does not read `done`)
or `goals/` holds a live goal, and by decision otherwise ([mc-martin.md](mc-martin.md#durable-desk-items)).

**The archive.** After an OK reading, and again on the next pick when the state
keeps one (no new reading, no session), the runner:

1. refuses when `~/mc/restricted/<p>/` holds entries: deleting data is a person's
   act. It opens one `for-martin` item at once, sort `reserved`, with a Swedish
   brief naming `mc plan <p> --archive`; the programme stays as it was;
2. moves the top-level `proposals/*.md` to `~/mc/proposals/`, each with a first
   line naming the programme, never over a file already there;
3. calls `archiveProgramme` with the runner's own git, gh, docs merge and release
   and a `fence`, the same function `mc plan <p> --archive` calls. The fence
   re-reads `goals/` and `~/mc/restricted/<p>/` after each docs PR merge, before
   release and before shelving; a live goal or a restricted entry that has
   appeared stops the archive with nothing local released, deleted or moved
   (a landed docs PR stays). With a fence, `clearRestricted` is never called;
4. records the destination it returns in the state file at once, then sets the
   record there to `done` (`setRecordState`) and clears the state.

A state that names a destination whose record still reads `open` (the move
happened and the write did not) is due that write alone on the next pick: no
reading, no session, no second archive. A write that throws (a filesystem
error) is a refusal like any other: the destination stays, the failure is
counted, and the second opens the `for-martin` item. While that item is open the
write is not tried, and sync keeps it open although the directory has left the
programmes home, so a write that keeps failing opens no further item; a record
that already reads `done` is only cleared from the state. An archive that fails is a counted
failure like a failed reading, and a retry is made with the kept reading while
the done goals are the same; a goal that has appeared stops the retry.

**State and mixed versions.** `runner/archive-turn/<p>.json` holds
`{schema: 'mc-archive-turn', version, programme, failures, items, reading,
destination}`. A missing file, and an older version of this schema, read as no
failures and no kept reading, so a runner of this version reads a programme an
older one left alone; a file that cannot be read starts no turn, counts nothing
and is said once in `runner.log`, the desk sync reports it and the item stays
open. An older runner, which knows no archive turn, starts none, and its decision
lane may take a prepared `archive` item with its generic prompt: that is safe,
since it holds no reserved act and closing the item makes the new runner read
again. A programme an older runner or `mc plan --archive` has already moved is no
longer in the programmes home and is no candidate. The cases are in
`tests/mc/run.test.js` (*programme archive: mixed versions*) and
`tests/mc/archive-turn.test.js`.

## The manager's turns

The runner starts the headless manager ([mc-manager.md](mc-manager.md)) for two
turns, with nobody present. Both are one session of the `manager` role, class
large, named `manager:<slug>` (a horizon turn) or `manager:curation` in the
claim, the current record and `runs.tsv`; routing, admission, provider refusals,
offline holds, STOP and UPDATE are those of every session. They share the one
claim `manager`, so only one runs at a time, and they come last in the pick,
after the programme planning turn (`rank 7` in `lane-pick.js`). The session has
`MC_HEADLESS=1` and `MC_ROLE=manager`; a horizon turn also has `MC_HORIZON=<slug>`,
which a curation turn leaves unset. Its note in `runs.tsv` ends `,programme`,
`,reached` or `,text` for a horizon turn that ended in that way, and `,curated`
for a curation turn. `manager-pulse.js` holds the model-free parts.

**The horizon turn is due** when an open horizon has no valid open programme
record that names it. The horizons are taken in the desk's order; the first one
that is due and not held is the turn's. A horizon is held by any of: an open
text item `horizon:<slug>`; an open desk item `manager:<slug>`; a state file
`runner/manager-turn/horizon/<slug>.json` that cannot be read; and, for every
horizon, a programme record that is invalid (said once in `runner.log`). The
record is the trigger and a horizon is never made by the runner. The turn goes
before curation and is checked again after admission: when the horizon has
changed (reached, dropped, named by a record, held), the turn is deferred
(`skipped:horizon-changed`) and counts nothing.

**Read checkouts.** Before the launch the runner fetches every repository that
declares areas (`.mc/areas.json` at origin/main), then makes
`runner/work/manager-horizon-<slug>/<repo>` for each, detached at origin/main,
with the rules of the programme planning turn's read checkouts: a clean leftover
that is reachable from origin/main is replaced, a dirty or unreachable one is
kept and the turn fails with `read checkout retained: <path>`, and another add
failure is `setup: <git's last line>`. A fetch failure ends the pick and counts
nothing. The checkouts are removed afterwards; the session changes nothing in
them.

**A horizon turn ends** in one of three ways, judged without a model after the
session: a valid open record naming the horizon (`mc programs create`), the
horizon no longer open (`mc martin horizon reached`) or an open text item
`horizon:<slug>` (`mc martin propose`). Anything else is a failure with its
reason and log in the state file. Provider endings (quota, offline, refused
login) and the admission and fetch skips count nothing. The first failure
retries on the next pick. The second since the last item opens a desk item of
kind `manager`, reference `manager:<slug>`: the first such item is `prepared`,
with a model-free `prepared.md` of the failures and their logs, so a decision
session repairs it; a later one is `for-martin`, sort `mechanical`,
`reversible: false`, `due_at: null`, with a `brief.md` in Swedish. No turn starts
for that horizon while an item is open, and a failure is counted again only after
it closed. The item closes by source ([mc-martin.md](mc-martin.md#durable-desk-items)).

**The curation turn is due** at most once in 24 hours from the start of the last
one, and then only when the origin/main of a repository that declares areas has
moved past the commit the last successful curation read; the first turn is due
at once. Inside the 24 hours a tick reads no git. `runner/manager-turn/curation.json`
holds `{ started, bases }`: `started` is written when a turn starts (so a failed
turn waits the 24 hours too) and restored when a provider ending stopped it, and
`bases` is each repository's origin/main commit at the setup of the last turn
that succeeded. A state file that cannot be read starts no turn; it is said once
and the desk sync reports it.

**Worktrees.** The runner fetches, then makes for each repository that declares
areas a branch `manager/curation-<stamp>` from origin/main in
`runner/work/manager-curation/<stamp>/<repo>`. The prompt names them and lists the
proposals. The session publishes what it changed with plain `mc publish`, which
opens the pull request and queues it for the merger, where the docs form lands a
pull request whose every file is under `docs/` (never `--no-merge`: nothing
would queue a `manager/curation-*` branch);
its refusals are the manager's guard ([mc-manager.md](mc-manager.md#what-the-manager-may-write)).
After the session a worktree that holds nothing, or whose branch is published
and clean, is removed with its branch; any other is kept and named in
`runner.log`. A turn that ends with nothing to change succeeds. A failed
curation turn is said in `runner.log` and opens no desk item.

## Goal-less main-red mend

Queued `runner/main-mend/<repo>.json` requests share merge-failure mend's
earliest rank, ahead of a repair build, review and build, within the unchanged
machine-wide lane total. A newly queued request wakes idle lanes at the existing
30-second control poll instead of waiting the ten-minute idle delay. `mainMendWork` groups files by repository and finder,
preserving a used batch on retries. Before launch fetch origin and use the
same branch-worktree helper as goals to make
`runner/work/mend-main-<repo>-<digest>/<repo>` on
`mend/main-<repo>-<digest>` from origin/main. Keep that branch and tree on retry.
`runMainMend` runs `mend-session` with its default catalog list and class fast,
normal capacity/billing, disk and memory admission, current-lane ownership,
scratch and session logs. Goal/programme identity is unset. The main-red prompt
carries the files, errors, base and finder, each red test's place and stack, the
retained record of the measuring run, and earlier finished repairs of the same
file; no goal files or proposal are written.

The [merge contract](mc-merge.md) defines request deduplication, acceptance,
publication and the two attempts (a third waits on Martin), without a goal.
The runner records sessions ending without publication and recovers a dead
runner's running request. Its settlement pass restores missing published queue
handoffs, recognizes merged/closed PRs and retries safe finished (landed or dropped) worktree cleanup.
Martin requests show on the page, in `mc repo status` and `mc martin get`.
A person, `martin` or `decision` answers one with `mc repo mend <repo> <id>
requeue|drop --reason "<text>"` ([merge contract](mc-merge.md)): a requeued entry
(failures 0, same branch and worktree) is offered again and its mend prompt
carries the reason; a dropped one is finished and a new red for its file queues
afresh. The settlement pass and `runMainMend`'s finally remove a finished
entry's worktree through the one function in `src/mc/main-repair.js`, `removeFinishedWorktrees`,
keeping a tree an unfinished entry, a `current-*.json` or a live claim still
names.
The full run's cadence (it follows main) and existing repair goals are unchanged.


## Deploy mend

A technical deploy stop ([`mc-deploy.md`](mc-deploy.md), *A stop that is repaired*) queues one request in
`runner/deploy-mend.json`, offered at the main-red mend's rank by `deployMendWork` (an idle lane notices it on the control
poll through `deployMendTicket`). `runDeployMend` is `runMainMend`'s machinery for both repositories: worktrees of memoro-cli
and memoro on `mend/deploy-<digest>` from each `origin/main`, the session in memoro-cli's, `MC_ROLE=mend-session`,
`MC_DEPLOY_MEND=<id>`, class fast. Two attempts; a dead runner's `running` request is a failed attempt. `settleDeployMends`
(every `SETTLE_EVERY_MS`, with `settleMainMends`) restores a published handoff, reads each landed pull request's merge commit,
marks the request repaired, and runs the **one retry** in the runner's own process through `run` of `commands/deploy.js`
(holder `runner for …`, `retry: true`, no `MC_HEADLESS`), only when the runner's code (`runner.json` `commit`) and the pick
contain the landed merge commits; the retry's stop is reported by `onStop`, never queued. The retry is marked `retried` when
it starts and is never made twice: its technical stop is `retryFailed`, the request on Martin. A request whose retry owner is
gone is settled from `deploys.tsv` first: deployed ends it, still running waits, anything else is `retryFailed`, never started
again. Finished requests' worktrees are removed
unless git refuses (files that are not mc's stay, and the line says so).

## Decision lane

Prepared desk items share the
machine-wide lane total, behind mend and ahead of other delivery sessions.
`decisionWork`, `decisionPass` and `runDecision` use the same slot, disk,
capacity, billing, worktree, watch/check-in and log machinery as main-red mend.
Two items of the same goal cannot run together; goal delivery also honours the
decision claim. A decision current file carries the item id as `name` and the
goal reference separately, so handovers exclude the goal, not just that item.
The role runs headless with goal identity only for a goal item. Each launch
adds a `decision` row named by item id. The same launch is exposed to the person
as `mc decision [<id>]`; nesting it inside a session is refused.

The shared daily desk ceiling is rechecked before launch; unset means no
ceiling. One unfinished ending retries once; a second in the item's current
state, not counting a quota, offline or provider-refusing login ending, makes a
non-reversible mechanical brief that waits on Martin instead of looping. A
for-martin brief is never lane work, and no clock carries one out. See [mc-martin.md](mc-martin.md#unattended-decision-pass)
for item state, failure evidence, authority and the fixed Swedish brief shape.
