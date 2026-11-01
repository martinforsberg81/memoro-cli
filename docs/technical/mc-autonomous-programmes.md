# Programme and goal lifecycle

V1 projects and goal assignments coexist under a programme. V1 `mc-plan`
version 1 files keep their fixed steps, register, independent review and
publication behavior. Version 2 goals use ordinary `mc goal` authoring and
revision-bound evidence; programme metadata supplies context only and is not an
approval authority.

`mc goal new`, `criterion add`, `send` and `revise` are the assignment surface.
Goal state validates stable identity, role ownership and append-only revisions.
An unblocked sent goal becomes ready. A goal with selected dependencies waits
for the existing scanner to observe verified landing of the exact dependency
revisions; the scanner releases it. Revisions may be sent again, subject to
recovery guards. Landing ends execution, while after-integration measurements
remain separate follow-ups.

The public planner envelope commands are removed. Durable programme event
queues, operation journals, locks, retry receipts and recovery records remain
for crash consistency and headless queue consumption, which `mc run` carries and
which claims only with programme autonomy on. A sent goal needs no autonomy.

See [goal planning and journal behavior](mc-programme-plan.md),
[programme operations](mc-programme-operations.md), and
[autonomous state](mc-autonomous-state.md) for current implementation details.
