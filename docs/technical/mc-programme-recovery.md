# Programme-owned recovery

Planner operation records and recovery rules remain durable, but their former
public programme command envelope is removed. `mc run` carries the
headless queue consumer, which claims only with autonomy on; otherwise events
stay pending for the foreground planner. Ordinary foreground assignment
changes use `mc goal`; the scanner still observes verified dependency landings.

This extends the injected programme jobs/plan seam. It does **not**
add a role, change v1 recovery, grant deployment authority or change
test selection/resource reservations. Plan decides; step implements; independent
review only reports. Existing immutable attempts, reports, receipts and PR
ownership remain the sources for continuation.

## Findings, incomplete attempts and landing

Reconciliation delivers review/build/merge outcomes to the same coalesced plan
job. Current review findings cannot go directly back to build, even by asking
for `resume-project`: plan must revise the goal or create different work. The
same branch/PR, reports and unsuccessful attempts survive revision and restart.
A clean reviewed landing is `landed` and completes execution of that goal
revision. After-integration criteria remain separate follow-ups: planning records
measurements with criterion ID, goal revision, integrated SHA, reference and
`passed`, `failed` or `unknown` outcome. `mc goal done` checks that the latest
current measurement for every follow-up passed; it never writes a landing.
No new permission to deploy follows from a deferred check.

`mc goal diagnose` records a `diagnose-project` operation, and `mc goal retry` a
`resume-project` one, through the [planning journal](mc-programme-jobs.md), for
either planner. The operation's input is:

```
{action: "retry", attempt_ids: [all incomplete attempt IDs],
 diagnosis: "the technical cause and evidence", approach: "a different approach"}
```

An exception instead uses `action: "exception"`, without `approach`. Diagnoses
are durable history, bound to the current goal revision and exact
attempt list. Resuming a failed goal requires a current retry diagnosis; an
already unsuccessful approach is refused. Three consecutive incomplete attempts
without another verified criterion retain a `no-progress` exception. Neither a
new run, new commits, a goal revision nor restarting plan resets that count.
A current retry diagnosis of every attempt also lets the next build start on the
uncommitted tree those attempts left; without one that tree is refused.
Verified criterion IDs, not output volume or repeated evidence IDs, define
progress. Exception handling stays with plan, never an invented design stop.

An incomplete builder keeps ownership until trusted recovery proves its process
and gates closed. With programme jobs present, the runner can reconcile this
plan-pending owner without buying another model session: it takes the existing
claims, verifies the supervisor snapshot and gate completion, then releases only
that run. This is **not** a green handoff. Unknown/live processes or damaged
snapshots remain held, without signalling a process found on disk. Pre-outbox
recovery retains its existing behavior. The planner's safe-boundary check still
refuses an active/unknown builder claim or an active publication.

## Selected dependencies

`dependencies` selects exact same-programme goal revisions, preserving the
existing cycle checks. Reconciliation automatically delivers a dependency event
when those exact revisions have verified reviewed landings on main. Open
follow-ups do not hold goal dependencies; reconciliation does not choose the next goal itself.

Plan may additionally issue `await-dependencies` (empty input) for a sent,
pending goal with selected dependencies. This explicitly authorizes its later
release. Reconciliation atomically records `ready` and a release outbox event
once all dependencies have verified landings, runs are closed, the sent contract matches
and no shared-main incident holds it. Replaying an interrupted programme
acknowledgement cannot release twice. A changed selected goal revision fences
the selection; plan must reselect it. Unrelated goals and programme metadata
changes do not invalidate it. Planner stops hold new planner claims, not sent
goal dispatch. Recording a stop still waits for live or unreadable builder
claims, not merely the project's recorded active run. An orphaned claim is not
proof of a safe boundary. Goal revision preserves the old PR, evidence and
attempts, but recovery requires a diagnosis for the new revision.

## One shared-main incident and repair

Trusted merge outcomes preserve the gate's `red_on_main` file identities. The
programme scan journals these under `runner/programme-incidents.json`, using the
same strict root register lock as project effects. Repository plus failure-file
identity coalesces observations across projects/programmes. The first observer's
programme owns the plan job; all dependents wait on that same incident. Its
source references remain immutable. A resolved incident is not reopened by
replaying old sources; a genuinely new observation can create a new occurrence.
Unreadable incident data refuses dispatch, rather than becoming an empty wait.

The owning planner uses `main-repair`, a create-project envelope with `incident`
and the usual `basis` of goal criterion IDs and scope rationale. It creates
an **ordinary v2 project**, not a repair role. A repair target is reserved before
creation; its normal receipt reconciles a crash before/after project state or
DRAFT projection. Another owner/target is refused, and a committed repair cannot
be cancelled away. An uncreated reservation can be explicitly cancelled; its
fenced history prevents replaying its cancelled intent. Send/resume/build/review/merge
remain the normal guarded operations. A repair may start implementation from a **completed red preflight**
only when its immutable affected-gate receipt still matches the checkout/base,
all reported failures name its assigned incident and no command/cancellation is
unknown or failed. That preflight stays red; final publication and merge still
require complete relevant green evidence. Other projects cannot use this path.
The rationale is mechanically referenced, not semantic proof that
prose scope permits repository-wide repairs. Without that authority, plan records
a precise programme exception rather than expanding scope.

A repair landing alone never resolves red main. Reconciliation requires a new
successful gate receipt covering the affected main check, without test filtering
or incomplete/cancelled execution. It must postdate the landing and every incident
observation, measure the exact tree of a main commit containing that landing,
and belong to the repair's repository. Premerge publication receipts cannot qualify.
The incident retains the measurement reference, integrated and measured SHAs and
outcome separately from execution state. Resolution emits
durable dependency events for affected programmes; plan then authorizes any
failed work to resume. No branch/PR, failed history or publication is discarded.
The designated ordinary repair can observe its own assigned failure again without
waiting on itself or allocating another repair. Its other incident dependencies,
the dependents' holds and the final green publication/merge requirements remain.

## External waits and exhausted continuations

Plan can atomically journal `wait-programme` with `id`,
`reference`, a stable `condition` ID and `wait: {kind, reason, until}`. Quota,
network and resource waits require a future retry within 24 hours. An external
dependency may have `until: null` and remains explicitly waiting for the external
operations seam. Timed expiry creates a fresh durable planner event, even when
the previous claimed snapshot was acknowledged before restart. Repeated IDs are
idempotent. Three waits on the same condition exhaust into a precise
`wait-exhausted` exception, with history intact. This conservative bound does not
reset at a session or goal-revision change.

`exception-programme` carries `id`, `reference` and
`exception: {code, reason}`. It records an explicit dispatch hold, not a planned
stop or a question for a new agent. Failed planner transports also preserve the
job and use bounded 30/60-second resource backoff; a third unsuccessful delivery
of the same job retains `planner-no-progress`. Explicit stale-effect yields keep
their original semantics. All these outcomes remain visible in plan context.
Only the future foreground operations seam may release an external/exception
hold; it cannot silently resume a reached planned stop.

## Verification

`mc gate tests/mc/programme-recovery.test.js tests/mc/programme-jobs.test.js tests/mc/programme-plan.test.js`
exercises findings-to-plan revision on the same PR, immutable failed approaches,
restart/revision fences, dependency release interrupted between project and
programme writes, shared-main repair projection replay, confirmed-only release,
bounded quota/network/resource waits, exceptions and a stop reached once. Real
Git fixtures and controlled adapters cover review/merge recording without hosted
model calls, live programme activation or deployment.
The recovery suite also follows a clean reviewed landing through complete
verified landing to exactly one selected next-goal release while follow-ups remain open, and
checks revision fencing, repair self-observation and unknown/live stop claims.
