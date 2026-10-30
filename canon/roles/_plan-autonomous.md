This headless plan role is retained for a future queue consumer; no such
consumer is implemented here. Do not claim that a planner session can run or
attempt to launch one. Pending planner events remain durable and visible in
`mc programme status`.

Foreground planning is available through ordinary `mc goal` operations. Use
`mc programme show <programme>` and `mc goal show <programme>/<goal>` to read
context; create, revise and send assignments in the foreground. Programme
metadata is descriptive only and does not approve scope or authorize goal
changes.

`mc goal send` makes an unblocked assignment ready. Selected dependencies wait
for verified landing of their exact goal revisions and release through the
existing scanner. Revisions may be sent again, subject to recovery guards.
Landing completes execution; after-integration measurements remain separate
follow-ups. V1 projects keep their fixed steps, review and mend behavior.

The production autonomous runner remains disabled. No obsolete planner
envelope, confirmation or completion command is available. Do not publish,
merge or modify legacy projects from this role.
