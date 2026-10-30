# Durable programme jobs (inactive)

`src/mc/programme-jobs.js` adds a planner outbox to the existing
`PROGRAMME_STATE.json`, not another service or a replacement v1 register.
Normal execution remains disabled. There is no production launcher or automatic
activation. `mc programme autonomy on` ([programme operations](mc-programme-operations.md))
is the only door from `inactive`, and it refuses on an installation without every
control capability. Opening `mc plan` is unchanged.

## Events, ownership and restart

The optional `planner_jobs` record starts inactive. It retains immutable event
IDs and references, one coalesced pending job, a leased event snapshot,
operation intents/results and recovery history. Activation commits its event
before a claim can be made. Review, landing, failure, dependency, red main,
follow-up result, phase completion and idle events use the same queue, with
autonomy on or off. Repeated IDs must have identical content and are deduplicated
even after acknowledgement. An event's ID comes from its immutable source and goal
revision, never from when a scan ran, so `planner_jobs.pending` is not re-filled
by polling.

Only a named acknowledgement consumes an event: `mc programme events ack`, or
`completeProgrammePlan` for a whole snapshot. Finishing a lease, its expiry or a
process exit consumes nothing, and the events go to the next delivery. A lease may
name only its snapshot, so events arriving during it remain pending. Each ack is
recorded in `acknowledgements` with its reference and who made it.

All mutations check an expected **state revision** inside the existing programme
plan lock and strict register lock, then use the existing atomic JSON writer.
Claims reserve `active_run` and a unique lease generation together. Another plan
or foreground owner cannot claim concurrently. Independent project builders keep
their own reservations and existing shared resource accounting; the planner
lease is not a repository or gate resource reservation.

Leases are bounded to five minutes and require renewal. Reconciliation detects
an expired lease or dead owner, records why, clears only that planner reservation
and preserves pending events and unacknowledged intents. Run IDs cannot be reused;
old writers are rejected by active ownership and expiry checks. Reconciliation
never signals a process or rewrites a project's builder ownership.
Programme-wide fencing of planner project claims, attempts and releases applies
once the outbox is present; pre-outbox v2 reservation behavior is preserved.

`reconcileProgrammeJobs` scans durable project review/merge events and incomplete
attempts. Dependencies can also be supplied as immutable trigger records.
[Programme recovery](mc-programme-recovery.md) automatically observes verified landed
dependencies, selected releases and shared-main failures. Active
programmes without a next action receive an idle trigger, deduplicated for the
same project-state snapshot rather than spinning up planners on unchanged work.
Broken source records refuse reconciliation rather than becoming empty results.
Missing or repeated source IDs cannot silently coalesce distinct outcomes;
failed scans preserve both the programme journal and the damaged source.
The optional, injected runner capability `autonomous.programmeJobs` enables this
scan during `queue()` and returns pending programme IDs. It does not launch them;
without the capability the v1 queue and its return shape remain unchanged.
The former `programmePlan` launcher no longer consumes those IDs. This
installation reports the planner unavailable; the pending events and journal
remain durable for a future consumer. The public planner envelope commands are
removed, and no capability launches a headless planner here.

## Effects, not exactly-once processes

A durable operation ID identifies a decision across planner sessions. Its intent
binds the project, expected target state revision and complete input (including
the goal revision for a revised assignment). Intent persistence precedes the
effect. Reusing an ID for a different decision is refused. A stale target state
revision cannot authorize a new effect; unrelated goal revisions and programme
metadata changes are not evidence authority.

The implemented concrete effect is **create-project** with expected target
revision zero. `createProgrammeJobProject` first journals its intent, then uses
`createAutonomousDraft` to atomically commit the new project and an operation
receipt together. Receipt identity canonicalizes object keys, not array order.
The compatibility DRAFT projection and the programme acknowledgement follow.
A receipt-created draft has no active project reservation: it records the
creating run in its immutable receipt but does not strand its ownership after a planner crash.
A planner must reserve that project before further guarded goal operations.

On repeated delivery, the matching receipt reconciles a committed creation and
repairs a missing DRAFT projection. It never creates another project or silently
adopts an unrelated existing one. A crash after acknowledgement returns the same
result. Pending effects prevent job acknowledgement. Goal revision and send
have their own operation receipts/readback in the
[guarded planner facade](mc-programme-plan.md). The original creation seam stays
compatible. Explicit uncommitted cancellation is journaled; committed effects
must be reconciled. No arbitrary external effects are claimed exactly-once,
and process exit alone never establishes success.
Receipt readback checks the expected programme state revision before repairing
the projection, just like a new effect checks it before writing project state.

## The ordinary verbs

`runPlanningOperation` in `src/mc/programme-plan.js` is the door for the ordinary
goal verbs, for both planners. It first replays any pending intent whose receipt
exists, then prepares the intent, applies it and records the receipt. The
operation ID is a digest of the command (kind, goal, expected revision, input),
so repeating a command is a replay, and the project receipt commits in the same
write as the effect. Programme metadata and phases commit effect and receipt in
one write, so no crash separates them.

Headless needs its unexpired lease at every step. Foreground never reserves a run
or a lease: it refuses with `contention:` while either is held, or while another
intent on the same goal is unresolved. A refused effect marks its intent
`refused`, so the same command can run again; a crash leaves it `pending`, which
holds that goal and every ack until it is replayed or cancelled.

## Explicit dispatch holds

Autonomy off preserves the queue and refuses only new claims; a held lease keeps
its effects. Quota, network and
resource waits require a retry instant; an external dependency may instead have
no retry instant and stays explicitly waiting. Timed waits become eligible at
reconciliation. Existing atomic effects can still be acknowledged while held.
A planner stop records a reference and reason. Its acknowledgement is
idempotent and subsequent events remain visible. It holds new planner claims,
not already sent goals; programme context is not an approval boundary.
`execution_enabled` stays false throughout.

## Verification

`mc gate tests/mc/programme-events.test.js` covers concurrent authors in real
processes, a real crash either side of the effect, expired leases, duplicate
replay, autonomy off and on, and events arriving during an ack.
`mc gate tests/mc/programme-jobs.test.js` covers trigger coalescing, late delivery,
competing processes, failed atomic persistence, lease renewal/expiry/dead owners,
stale-writer fencing, independent builders, source reconciliation, explicit
holds/stops, the capability-only runner seam and immutable operation effects.
Real child-process crash fixtures exit after claim, intent, project-state commit,
DRAFT projection and acknowledgement. Recovery checks one project/contract,
one receipt, repaired projection and retained continuation under repeated delivery.
No model calls, live programme changes or new test-resource paths are involved.
