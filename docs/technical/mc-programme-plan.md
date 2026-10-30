# Programme planning and goal operations

Goal assignments are ordinary, foreground `mc goal` operations. Programme
metadata is descriptive context, not an approval contract. `mc programme`
exposes programme reads, metadata and operator controls; it does not expose
planner decision envelopes or event acknowledgements.

## Current availability

The durable planner event queue, operation journal, locks, retry receipts and
recovery state remain on disk. They preserve existing records and the
crash-consistent boundaries needed by the future queue consumer. The public
`draft`, `approve`, `decide`, `complete` and `cancel` programme commands have
been removed. The old operation-shape validator was folded into the shared
goal-state boundary; `programme-plan-contract.js` is no longer needed.

Headless queue consumption is not implemented. The runner does not launch a
planner; `mc programme status` reports `planner unavailable` and pending events
remain durable. This is distinct from build/review lifecycle handling and does
not enable autonomous execution. The operator sets programme autonomy on or
off, but autonomy on does not supply a queue consumer.

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
