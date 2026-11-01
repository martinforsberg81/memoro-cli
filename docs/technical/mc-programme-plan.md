# Programme planning and goal operations

Goal assignments are ordinary, foreground `mc goal` operations. Programme
metadata is descriptive context, not an approval contract. `mc programme`
exposes programme reads, metadata, operator controls and the planning verbs
`events list|ack`, `wait`, `stop`, `phase` and `operation cancel`; it does not
expose planner decision envelopes.

## Current availability

The durable planner event queue, operation journal, locks, retry receipts and
recovery state remain on disk and keep their crash-consistent boundaries. The public
`draft`, `approve`, `decide`, `complete` and `cancel` programme commands have
been removed. The old operation-shape validator was folded into the shared
goal-state boundary; `programme-plan-contract.js` is no longer needed.

`runProgrammePlan` (`src/mc/programme-plan-run.js`) is the headless queue
consumer. A runner reaches it only with the `autonomous.programmePlan`
capability, which `mc run` carries (`src/mc/autonomous-capability.js`), and it
claims only with programme autonomy on. With autonomy off it launches no planner
and pending events remain durable. This is distinct from build/review lifecycle
handling: a sent goal needs neither autonomy nor the planner.

Given the capability, the consumer holds a claim file and the queue lease, so a
programme has one headless planner. It refreshes a detached inspection checkout
of each repository, starts one bounded session with the planner context and
renews the lease while the session runs. A normal exit needs exact
acknowledgement: every claimed event acknowledged by ID, or a recorded completion
covering the snapshot. An exit that leaves one open, a failed process, a lost
lease or a changed inspection checkout yields the delivery with a bounded retry;
the unacknowledged events stay pending. `finishProgrammeJob` itself only releases
the lease and never consumes an event.

`mc programme status` shows the pending events with their age and the next
actor, with autonomy on or off: the foreground planner while autonomy is off,
the headless planner otherwise. Phase rows count premerge criteria reported and
follow-ups pending. An event's observation time is recorded once, when a
transaction first sees it, and is not part of the event's identity.

## Planner context

A planner session's context (`mc-programme-plan-context`) carries the programme
metadata and brief, every phase with its purpose and closure reference, the
autonomy stop condition, every goal in state (legacy v1 goals as read-only
summaries), each goal's pending follow-ups, the events the lease claimed and any
operation not yet reconciled. Immutable detail is referenced, not inlined. The
context is bounded to the session-start size; an oversize programme fails with an
explicit error rather than dropping a constraint or a goal.

A scripted session (`tests/mc/programme-plan.test.js`) drives the real `mc goal`
and `mc programme` handlers under a lease: it creates and sends a next goal when
a goal lands, acknowledges the events it claimed by ID and exits. A crash during
a send leaves the landed event pending and the send is replayed once by the next
lease. A session with nothing to plan records a bounded `mc programme wait`, so
the idle scan does not wake the programme again before the wait ends. Further
scripted sessions run through the consumer itself. Installed provider support
remains unclaimed.

## Ordinary goal lifecycle

`mc goal new`, `criterion add`, `send`, and `revise` author assignments and
preserve goal identity, revision history and role boundaries. Sending an
unblocked goal makes it ready. Selected dependencies remain pending until the
scanner observes verified landing of the exact selected goal revisions, then
releases the waiting goal. A revised goal may be sent again; recovery guards
continue to fence active or failed attempts. Landing completes execution;
after-integration observations remain separate follow-ups recorded with
`mc goal criterion evidence` and inspected with `mc goal done`.

## Retained durability boundary

Planner operations that already exist in the durable journal are still
validated before effect. The exact intent is persisted before applying the
goal-state mutation; an immutable operation receipt is committed with the
effect, then projection writes and journal acknowledgement can be replayed.
The programme/project/register locks, append-only history, fail-closed
ownership checks and retry behavior remain. A process exit alone is never an
acknowledgement. The queue must not be discarded as part of removing its old
CLI envelope.

The activation capability stays disabled in production. V1 projects retain
their fixed-step behavior and are read-only to goal assignment operations.
