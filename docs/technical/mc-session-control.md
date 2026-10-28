# Autonomous session control (inactive)

`src/mc/session-control.js` is a pure decision policy, not a launcher. Existing
v1 prompts, watches, gates, lane reservations and recovery are unchanged.
Autonomous execution remains disabled. No provider capability or live context
measurement has been established by these synthetic control tests.

## Trusted inputs and bounded outcomes

`createSessionControl` starts a run bound to programme, project, assignment
revisions and run ID. `decideSessionControl` consumes ordered runner observations;
identical sequence replays are idempotent and conflicting/out-of-order samples
are refused. Neither function reads a clock or performs I/O. Profiles are explicit
runner configuration, **not model callback input**; no production calibration or
universal minute/token defaults are implied.

A profile sets soft/upper/emergency active time and current context fractions,
active/context closing reserves, an overall closing deadline, individual tool/gate
and lane wait deadlines, total awake time, no-progress active time, stagnant
session and failure ceilings. Profile validation requires space between upper
and emergency thresholds for gate, fixes, commit/push and handoff. Total awake
time also requests closing with a complete closing window still reserved. Sampling must
be frequent enough to observe a closing boundary before that reserve is spent.

- A newly measured completed criterion at/above a soft threshold requests
  `finish-session`. A checkpoint without criterion completion does not.
- An upper threshold requests `finish-session` even mid-criterion.
- Closing is sticky, disallows new work, and preserves its original deadline.
  Gate/fixes/publication/handoff may use the reserve; further criteria are not
  authorized. The pure policy does not itself enforce process interruption.
- Emergency active/context/total-awake/closing limits and expired tool/lane waits
  persist an `incomplete` result, `normal_exit: false`, `pending_plan: true`, and
  `stop-session`. Known running tools/gates are not an infinite exemption, even
  if they produce output or complete in the sample that exceeds their wait.
- Repeated failures or no measured progress produce `needs-plan` with a pending
  plan result, not a repair role or a human question. Incomplete emergency attempts
  count as failures across runs; measured checkpoints do not erase failure history.

Control outcomes are never publication evidence, a green handoff, planner
confirmation or permission to merge. Normal handoffs still require the separate
[session-result contract](mc-session-handoff.md), including measured gate,
committed/pushed content and observed successful process completion.

## Clocks, tools and progress

Every sample has integer millisecond `at_ms` (wall time), `awake_ms` (a normalized
monotonic clock excluding machine suspend) and a contiguous `sequence`. The old
sample's activity accounts for the intervening awake interval: `model`, `lane`,
`tool` or `gate`, with a stable job ID except for model work. Wall minus awake is
recorded sleep. Only model time consumes active/no-progress budgets; known waits
consume their own bounds and total awake/closing time. Replacing one job with
another cannot evade total awake time. The [observation boundary](mc-session-observation.md)
requires the trusted runner to supply these clocks; this policy does not infer sleep from silence.

`context` is either null or `{ fraction, at_ms, source, quality }`, where quality
is `measured` or explicitly `estimated`. Missing/stale readings become `unknown`
with null fraction, not zero. Fresh time/checkpoint limits remain effective.
Cumulative token counts are not accepted as current-context fields. Responses
include the observation timestamp/sequence, so cached control is not represented
as a fresh telemetry sample.

Only runner-verified `progress: { id, reference, criterion_id }` resets the
no-progress clock. A null criterion ID is a measured checkpoint; a new criterion
ID also provides a criterion boundary. Output bytes and model callback claims do
not count. Unique measured checkpoint/failure IDs prevent replay from resetting
history. The latest measured checkpoint and failure references are retained. Histories are bounded (256
IDs per collection); exhaustion returns a pending plan result rather than
truncating deduplication history. Fresh runs reset session clocks/context, not
no-progress active time, stagnant-session counts, completed criterion IDs or
failures. An unresolved pending-plan result refuses another build session, even
with a larger supplied profile. Revision mismatches fail closed; this seam does not implement plan
revision/recovery orchestration or silently relabel old evidence.

## Atomic persistence and common callbacks

Trusted `startProjectSessionControl` and `observeProjectSessionControl` in
`autonomous-state.js` store `session_control` inside `AUTONOMOUS_STATE.json` under
the existing programme/project/register locks, active step-run ownership and
expected state revision. Actions are returned only after the atomic write.
Runner callers must verify measured references, reserve the run, reconcile prior
workers/gate children before another start, and subsequently publish pending
results to plan. These functions store durable results; they do not dispatch
plan work or launch/terminate processes. The explicit inactive
[transport seam](mc-session-observation.md) adds process supervision separately.

Both tools can read the same durable signal without live stdin steering:

```
mc session-control status <programme>/<project> --expected-revision <n>
mc session-control checkpoint <programme>/<project> --expected-revision <n> --input-file <json>
mc session-control criterion <programme>/<project> --expected-revision <n> --input-file <json>
```

Checkpoint input is `{ "reference": "evidence/partial.json" }`; criterion input
also has an assigned `criterion_id`. Status has no input file. These callbacks
require the active step run/role (`MC_AUTONOMOUS_RUN` / `MC_AUTONOMOUS_ROLE`) and
return `next_action`, phase, reason, context quality, observed timestamp/sequence,
result and state revision. They cannot initialize control, choose a profile,
inject clocks or measurements, reset history or extend a closing deadline.
Checkpoint/criterion requests replace one bounded durable request for subsequent
runner verification; submitting a request is not measured progress. Existing
`autonomous-project show|progress` also returns a `control` response when control
has been initialized; without it, the earlier response is unchanged. None of
these commands activates execution or changes the v1 step/status commands.

Verification: `mc gate tests/mc/session-control.test.js` uses fake clocks and
isolated real state files for boundaries, reserves, bounded waits, machine sleep,
unknown context, persistent stagnation/failures, command ownership, durable
responses and failed atomic writes. Synthetic transport events and ignored-control
real process fixtures are covered separately by `tests/mc/session-observation.test.js`;
no paid provider telemetry is inferred from those fixtures.
