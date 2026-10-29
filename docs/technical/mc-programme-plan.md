# Guarded programme planning (inactive)

The autonomous flavor of **plan** owns programme-wide decisions. This is not a
new repair role and does not activate any live programme. `mc plan` remains the
foreground conversation, with its existing workspace and behavior. Normal runner
construction still has no autonomous capability; `execution_enabled` remains
false. Only an injected `createRunner` capability with `programmeJobs: true` and
`programmePlan: true` connects pending jobs to the headless launcher. Production
activation belongs to the later operations project.

## Context, workspace and transport

`programmePlanContext` obtains one locked snapshot containing the **complete
approved programme** and every goal's concise status, revision, branch/PR,
dependencies, current criterion observations, latest review reference, attempt
count/reason, handoff and landing. Legacy goals are read-only references. Old
builder transcripts are not appended. Detailed contracts, reports and attempts
remain referenced in authoritative state. The whole prompt is bounded by the
existing 64 KiB session-start limit: overflow or an unreadable goal refuses
launch rather than silently dropping context.

The runner claims the existing programme job lease and a process-owned workspace
reservation. Its detached inspection worktrees live at
`runner/plans/<programme>/<repo>`, never in foreground planning or builder areas.
Available configured repositories are checked out; every repository named by a
goal is required. Each checkout must belong to the expected Git repository, be
detached and clean, and is refreshed from fetched `origin/main`. Dirty or
foreign trees are preserved and refused, not reset. Dependencies are not installed
and no build/gate runs in these inspection checkouts.
`WORKSPACE.json` retains expected inspection heads. Changed commits or branches,
even with a clean working tree, invalidate completion and are preserved rather
than silently refreshed on the next launch. Raw session output stays referenced
in the run's scratch log, not appended to future prompts.

Plan uses the existing large model class, capacity/reserve rules, launch adapters
and shared runner slot accounting. `_plan-autonomous.md` replaces the foreground
overlay while preserving the plan role's routing metadata. Claude receives its
prompt through stream JSONL; Codex receives it in argv with stdin closed. The
lease renews every 30 seconds. The opt-in transport deadline is 30 minutes; it
terminates only the child it started, escalates if necessary, and waits for close.
Lease expiry fences writes even if a process later returns. This is workflow
control, not OS isolation from an adversarial process or its filesystem access.

## Decisions

```
mc programme decide <programme> --expected-revision <programme-state-revision> --input-file <json>
```

The runner supplies `MC_AUTONOMOUS_RUN`, `MC_AUTONOMOUS_ROLE=plan`,
`MC_PROGRAMME` and `MC_PROGRAMME_LEASE`; there is no command for claiming a run
or choosing another role. Mutations check expected state revisions, active
run/role and lease token/expiry **under the existing programme/project/register
locks**. Independent projects retain their own running reservations.

| Kind | Input and effect |
| --- | --- |
| `create-project` | Existing durable creation envelope: ID, project, expected revision zero, programme revision and complete v2 goal. Creates an inert draft. |
| `send-project` | Empty input. Publishes the authoritative goal as an inactive PLAN snapshot, without dispatch. |
| `revise-project` | Complete v2 contract, goal revision +1. Preserves identity, branch/PR, commits, attempts, historical contracts/evidence/reports and run history. No person-held block or PR closure is required. |
| `dependencies` | `{projects: [{project, goal_revision}]}`. Selects same-programme dependencies; rejects unknown/stale goals, duplicates, self-links and cycles. Leaves work pending. |
| `resume-project` | Empty input. Requires a sent pending goal and planner-confirmed dependencies at their selected revisions. Sets ready only inside the injected execution seam. |
| `confirm-project` | `{id, reference, criteria: [{criterion_id, reference}]}`. Requires landed, current independently reviewed delivery on main and explicit evidence references for every criterion, including after-integration checks. |
| `diagnose-project` | Exact attempt IDs, technical diagnosis and a different retry approach, or a precise exception. |
| `await-dependencies` | Empty input. Arms confirmed-dependency release of this exact sent goal revision. |
| `main-repair` | Creation envelope plus incident and approved scope basis. Reserves the one ordinary shared repair project. |
| `wait-programme` / `exception-programme` | Durable bounded external condition or precise exception; see recovery policy. |
| `reach-stop` | `{id, kind, programme_revision, stop, reference}` names an approved stop. Intent and stopped mode commit together after affected runs close. New dispatch is forbidden beyond it. |

Project operations other than creation carry `id`, `kind`, `project`,
`expected_revision` (the **project state** revision), `programme_revision`,
`input`, and `basis: {criteria: [approved-criterion-id], reference: scope-rationale}`.
The approval reference and criterion IDs are checked mechanically. Interpreting
prose scope is plan's responsibility, not a semantic guarantee of JSON validation.
No decision kind can edit programme scope, authority, requirements or stops;
only foreground agreement can approve a successor programme revision. A fresh
decision can align an old goal with that newly approved revision.

Affected runs, open publication/landing phases and live/unknown builder claims
prevent revision. The pending decision remains durable: after the run closes,
refresh versions and explicitly supersede any stale uncommitted decision with
`mc programme cancel ... --input-file <json>` containing `{id, reason}`. It is
not a person-held design block. Independent running goals are not stopped.
Delivered/confirmed scope cannot be rewritten: create a new goal for further work.

Revision conservatively invalidates current handoff, publication, review session,
merge permission, landing and control/continuation bindings. Old observations and
immutable reports remain in history but cannot satisfy the new revision. Decision
history additionally retains the replaced current bindings. Retired criterion IDs
cannot be recycled. PLAN and DRAFT are recoverable projections of state, not
second authorities; readers skip any temporary contract mismatch.

## Durable effects and completion

The existing planner journal persists the exact intent **before** applying it.
Each effect atomically stores its operation receipt with the project mutation;
projection writes and journal acknowledgement follow. Replaying the exact ID and
input repairs projections and acknowledges the original result, including after
a lease change. It never increments the goal twice, adopts another PR or silently
rebases a stale decision. A cancelled operation cannot be applied; a committed
receipt cannot be cancelled. Changed agreement revisions fence new effects while
still allowing receipt readback of already committed work.

`mc programme complete ... --input-file <json>` takes
`{event_ids: [exact claimed snapshot], reference: decision-reference}`. Pending
effects prevent completion. The runner requires this durable completion **and**
normal process closure with unmodified inspection checkouts before acknowledging
the job. The completion reference remains in the programme's result history.
Events arriving during the session remain pending for the next owner. Failure,
deadline, missing completion or lease loss retains the job and pending intents;
ordinary exit code zero is not a completed planning delivery. Failure/dependency
policy and automatic recovery progression are described in
[programme recovery](mc-programme-recovery.md).

Headless command guards admit programme show/decide/complete/cancel, read-only
goal inspection, status/help and hooks. They refuse agreement edits, legacy
mutations, building, publishing and merging. Existing pre-outbox typed v2 data
operations and v1 behavior are retained; this adds no migration or new deployment
authority.

## Verification

`mc gate tests/mc/programme-plan.test.js` covers full-programme context, role and
lease denial, stale decisions, open-PR revision and invalidation, preserved
independent runs, projection failure/replay across leases, changed approved
revisions, dependencies/cycles, reviewed delivery confirmation, planned stops,
explicit completion, foreground non-activation, real detached Git worktrees and
bounded transport closure. Fixtures use temporary roots/repos and controlled
model/GitHub adapters, not live programmes or paid model calls.
