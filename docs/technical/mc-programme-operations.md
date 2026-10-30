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

`mc programme autonomy <programme> on|off` records the operator's preference;
`on --stop "<condition>"` adds a stop condition in prose for the planner, and
each `on` states the whole preference. Autonomy on does not create a planner
consumer, enable autonomous execution or launch an agent, and it refuses when
required capabilities are missing. Off needs no capability. Headless sessions
cannot change the preference.

Autonomy controls only new headless planner claims. Off grants no next lease,
while a held lease may finish its claimed snapshot; sent goals, reviews and
admitted merges continue, and events keep accumulating for foreground planning
or a later claim. The global runner stop remains the execution stop. A wait, an
exception or a reached stop survives off and on, except that `on` is the
operator's explicit restart from a reached stop.

`mc programme stop <programme> --reference <evidence>` records that the stop was
reached. Foreground and leased planning share the operation; it refuses while
goals are owned and leaves the autonomy preference as the user set it, with the
planner resting in mode `stopped`.

## Phases

`mc programme phase add <programme> <n> <name> --purpose <text>` declares an
ordered phase; a number below a closed phase is refused.
`mc programme phase close <programme> <n> --reference <evidence>` is explicit and
available to foreground and leased planning. It refuses until every earlier
phase is closed, every goal in the phase has a verified landing, every follow-up
has a passed measurement and no goal is owned or under a live builder claim. A
phase with no goals closes only through this verb, so an empty phase holds later
ones. A repeated close with the same reference is a read; another reference is
refused.

Only the earliest unclosed phase dispatches. Goals in it run in parallel under
the existing caps, and `mc goal send --after` orders them further. A goal cannot
be created or revised into a closed phase, nor into an undeclared number once a
programme declares phases. Goals whose number was never declared are not held by
it, so programmes that predate phases keep working. `programme_phase` orders a
goal; its runtime `phase` is its lifecycle state, and the two are never mixed.
Dispatch is held at the same door as dependencies (`assertProgrammeDispatch`),
so a clean review already routed to the merger continues.

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

`mc programme status <programme> [--json]` is read-only. It reports mode, autonomy, phases,
installation capability, pending planner events/effects, goal phases, evidence,
waits and the next action. Pending planner events say they await headless queue
consumption; they are not silently acknowledged or dropped.

`mc plan <programme> --archive` remains the explicit archive boundary. It
refuses while goals have unfinished follow-ups, active/unknown ownership,
pending work, queued merges or unresolved shared-main incidents. No confirmation
transition is required.

## Verification

`tests/mc/programme-phases.test.js` covers explicit closure, ordered release,
parallel readiness, follow-up blocking, repeated close, autonomy off with sent
work and the shared stop. `tests/mc/commands/programme.test.js` covers removal of the obsolete envelope
verbs and revision/role checks. `tests/mc/programme-status.test.js` covers
read-only status and unavailable planner reporting. `tests/mc/programme-cli-smoke.test.js`
uses a temporary root and fake provider CLIs to verify that no model is
launched. `tests/mc/autonomy-lifecycle.test.js` and
`tests/mc/autonomy-coexistence.test.js` cover ordinary goal setup, lifecycle
recovery and unchanged v1 behavior.
