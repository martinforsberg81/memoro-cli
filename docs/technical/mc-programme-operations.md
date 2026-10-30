# Programme operations

`mc programme show <programme>` reads descriptive metadata. `metadata` updates
that context with a revisioned, append-only write. It does not approve scope or
grant assignment authority. `capabilities` reports the installation's
operator-control support.

## Planner availability

The durable planner event queue and operation journal remain for recovery and
future queue consumption, but this installation does not have a headless queue
consumer. No planner process is launched. `mc programme status` reports planner
unavailability and leaves pending events visible; it does not imply that the
runner will process them. Production autonomous execution remains disabled.

`start`, `pause` and `resume` record operator-controlled programme mode. A
successful start does not create a planner consumer, enable autonomous
execution or launch an agent. Normal installations refuse activation when
required capabilities are missing. A sent, unblocked goal is eligible for its
existing build/review lifecycle independently of programme planner
availability.

## Goal lifecycle

Use `mc goal new`, `mc goal criterion add`, `mc goal send` and `mc goal revise`
to author assignments. A sent goal with no selected dependencies becomes ready;
selected dependencies wait for the scanner to verify landing of the exact
selected revisions. Recovery guards continue to hold active, failed or
otherwise unsafe work. Landing completes execution, and any after-integration
criteria remain separate follow-up measurements.

V1 plans beside goals retain their fixed steps, register and merge behavior.
Goal commands refuse to mutate those v1 plans.

## Status and archive

`mc programme status <programme> [--json]` is read-only. It reports mode,
installation capability, pending planner events/effects, goal phases, evidence,
waits and the next action. Pending planner events say they await headless queue
consumption; they are not silently acknowledged or dropped.

`mc plan <programme> --archive` remains the explicit archive boundary. It
refuses while goals have unfinished follow-ups, active/unknown ownership,
pending work, queued merges or unresolved shared-main incidents. No confirmation
transition is required.

## Verification

`tests/mc/commands/programme.test.js` covers removal of the obsolete envelope
verbs and revision/role checks. `tests/mc/programme-status.test.js` covers
read-only status and unavailable planner reporting. `tests/mc/programme-cli-smoke.test.js`
uses a temporary root and fake provider CLIs to verify that no model is
launched. `tests/mc/autonomy-lifecycle.test.js` and
`tests/mc/autonomy-coexistence.test.js` cover ordinary goal setup, lifecycle
recovery and unchanged v1 behavior.
