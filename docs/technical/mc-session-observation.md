# Autonomous transport observation and interruption (inactive)

`streamSession` has an explicit `autonomous` version-1 runner seam. No existing
v1 caller supplies it; `watchFor`, `sessionStanding`, result-grace, Claude
check-ins/silence watches and unwatched Codex sessions keep their old behavior.
This does **not** enable autonomous scheduling or change any deployed programme.

## Observations, not invented context

The adapter registry's `sessionTransport` describes headless transport separately
from interactive launching:

| Path | Initial prompt | Autonomous live control | Context |
| --- | --- | --- | --- |
| Codex exec JSONL | positional argument; stdin ignored | none | unavailable |
| Claude print stream-json | first stdin JSONL user message | none added | last top-level request input, explicitly estimated |

Both tools use the durable `mc session-control status|checkpoint|criterion`
responses documented in [session control](mc-session-control.md). No live stdin
steering is claimed for Codex. Although the legacy Claude stream accepts more
user messages, this new boundary sends only the initial assignment, closing
stdin on an observed final result. No extra native control message is implemented
or required for either tool.

`createSessionObservation` consumes parsed events with runner timestamps. Codex
command/MCP item starts and completions, Claude top-level tool uses/results and
background-task changes describe bounded waits, including concurrent calls.
Subagent events are excluded. Tool IDs are normalized to stable hashed IDs;
more than 256 concurrent jobs refuses observation. The runner may override
activity with a verified gate/lane job; shell text is not proof of lane ownership.
Transport bytes, result text and model callback requests are never measured
criterion progress. `projectSessionObserver.verify` must independently measure a
checkpoint before reporting progress; its default reports none.

Codex `turn.completed.usage` is cumulative usage, never current context. Claude
assistant request input plus cache-read/cache-write input is an **estimate**,
not measured live context. A fraction requires an explicit trusted window size;
there is no guessed model default. Cumulative usage and the historical
`last_request_context` retain source, timestamp and quality separately. Only
the policy's `control.context` is a current reading: unavailable/stale readings
are `unknown`, with null fraction rather than zero. Time/checkpoint boundaries
still operate when context cannot be observed.

The runner must supply ordered wall/awake clocks, with awake time excluding
suspend. This boundary deliberately has no portable fake suspend detector or
production clock default. A missing/invalid clock interrupts the attempt, rather
than treating machine sleep as model work or exempting a stalled worker forever.
Explicit suspend and known-wait samples are covered synthetically; production
clock calibration remains an activation prerequisite.

## Supervision and recovery

The trusted runner initializes persistent control before calling the seam, and
supplies `projectSessionObserver` (or an equivalent trusted durable connector),
clocks, polling and a new artifact directory **outside** the checkout. Polling
must fit inside the configured closing/wait reserves. Callback revision races,
missing observations or failed control persistence interrupt rather than silently
overwriting state or extending a closing deadline.

The supervisor alone starts a detached process group and holds a workarea claim.
It polls and persists policy observations independently of output activity.
Closing is cooperative through durable responses. An ignored request reaches
the policy's closing/emergency bound, persists an incomplete attempt and receives
SIGTERM, then SIGKILL after the bounded `termMs` grace (at most 30 seconds). A
second grace bounds waiting for open pipes or descendants. Only the group this
invocation spawned is signalled; IDs in transport events or old manifests are
never signal targets. Unknown survivors block recovery.

Before recovery/start, the workarea manifest must show the predecessor closed,
its group dead and an on-disk checkpoint snapshot. A crash in the spawn-record
window, an unreadable manifest, missing snapshot or failed durable control write
refuses another builder. This seam does not invent evidence to auto-repair those
cases; a later controlled recovery must establish ownership and preserve work.
Checkpoint identity must match the attempt, and HEAD/raw code must still match
the snapshot. Corrupt/foreign checkpoints or code changed while a gate finished
require controlled preservation/reconciliation, not a silent stale recovery.

`reconcileSessionGate` checks the worktree's existing detached gate worker. A
live worker is left alone. A dead worker without its completed result and exit
record has **unknown detached test children** and blocks another builder. A
settled worker's lane is released only through the existing pid/generation
guards; a successor's reservation is preserved. Other projects' lane owners are
never released. Neither affected-test selection nor lane reservation is bypassed.
Unfinished observed tool/background jobs also block recovery: a dead provider
group alone cannot prove a tool that detached itself has ended. This seam does
not promise OS containment of unobserved processes or signal unknown children.

After group termination, immutable attempt artifacts contain the raw transport
JSONL, bounded output tails in the returned result, raw tracked/nonignored
untracked files (including symlinks/executable bits), the staged binary diff,
HEAD/content fingerprint, checkpoint/control, telemetry and observed process
outcome. Raw copying avoids losing files to `export-ignore` or clean filters;
content is fingerprinted before/after copying. The worktree/index are never
reset, checked out or stashed. Failed preservation blocks recovery. Ignored
dependencies and machine-local files are intentionally not copied.

Exit zero without a complete observed transport result is incomplete. Forced
closure, missing observations, unknown gate children and failed persistence or
preservation never return a successful normal exit. `control_persisted: false`
distinguishes a local fail-closed decision from a durable control write. A normal
transport exit is **not** green publication evidence: the matching committed,
pushed, relevant-gate handoff contract remains independently required. No v2
build loop, provider session, gate cancellation authority or plan dispatcher is
activated here.

## What was actually measured

Local, non-model probes on 2026-10-28:

- `codex --version`: `codex-cli 0.164.0`; `codex exec --help` advertises JSONL
  output and initial prompt input (argument or stdin), not an exec live-message
  channel. The existing mc exec launcher uses ignored stdin.
- `claude --version`: `2.1.312 (Claude Code)`; `claude --help` advertises print
  mode and stream-json input/output. Existing legacy stream behavior is retained.

These help/version probes do **not** establish live context telemetry, native
live-control delivery, production suspend clocks or behavior of a paid model.
No paid/model session was launched. All observation events in
`tests/mc/session-observation.test.js` and its Node process fixture are explicitly
synthetic, not captured provider events. Real fixture processes run both prompt
shapes, read the actual durable status command, ignore `finish-session` and
SIGTERM, and are force-closed together with their child process. The tests also
exercise cooperative exit, unknown context, persistence/preservation failure,
gate/resource reconciliation and unchanged legacy streams.
The ignored-control fixture's synthetic awake clock starts at protocol readiness,
not cold module/git startup, so machine load cannot consume its closing window
before it has a chance to read the control command. The exit-outcome fixtures
(cooperative, unexpected, pending-tool, persistence and gate cases) keep awake
time frozen, so slow startup cannot reach a boundary and kill them before they
print the events under test. Policy thresholds are unchanged.

## Provider observations

`mc programme capabilities` reports support only from real sessions, recorded in
`runner/provider-observations.json` (`src/mc/provider-observations.js`). Each
entry holds `tool`, `tool_version` (from `<bin> --version`, taken before the
process starts), `role`, `signal`, `run_id`, `project` and `at`.

| Signal | Recorded when |
| --- | --- |
| `session` | a build ended with `normal_exit` and `control_persisted`, or a review with `normal_exit`: the review transport keeps no session control |
| `control` | the process wrote a session-control request, or read status, which leaves a mark in its `MC_SCRATCH` because a read changes no state |
| `interrupt` | supervision signalled the process group (`signalled` on the session result) |

A capability is supported when the production capability can be built here and
every tool in the model catalog has, at its installed version, what it needs:
`build` a step `session`, `review` a review `session`, `control-signals` a
`control`, `interrupt` an `interrupt`, `programme-jobs` and `programme-plan` any
`session`. A new tool version has no support until observed again. That refuses
`autonomy on` only: `assertProgrammeDispatch` does not consult capabilities, so a
sent goal runs with autonomy off and with no support. A capability with
`fixture: true` records nothing.

Verification: `mc gate tests/mc/session-observation.test.js tests/mc/session-control.test.js tests/mc/run-session.test.js tests/mc/run-plan.test.js`.
