# Autonomous merge admission (inactive)

No programme is activated by this implementation. V1 criteria, queue, review,
retry and merge paths remain unchanged. Autonomous build publication still
does not enqueue work. After independent review completes, the trusted runner
may automatically enqueue a current clean report through the existing merger;
no additional approval or model session is required.

## Every door

Persistent repository/PR/branch ownership in `runner/autonomous-prs/` identifies
autonomous changes even when GitHub, PLAN, state or the review is unreadable.
An unresolved marker, corrupt registry or marker without matching state refuses
admission, never falls back to legacy `notChecked`. A body marker or v2 branch
without durable ownership also refuses rather than guessing authority.

`criteriaDoor` checks autonomous admission before legacy step lookup. A current
settled publication, durable normal handoff, matching sent goal assignment,
all current published verified premerge criterion evidence, and a complete clean
independent report are required. After-integration criteria may remain deferred;
they do not block their own merge or count as planner confirmation. Active or
incomplete attempts are not admissions.

The report must match the full assignment and criterion digests, published SHA,
gate run, historical builders and reserved independent reviewer. New commits
(including equal-tree commits), changed criteria/evidence and findings invalidate
it. The latest report must be clean; an earlier clean report cannot override a
later finding. Revisions of other goals and changes to programme metadata do not
change admission; revising this goal invalidates its earlier evidence without
deleting history. Admission reads the immutable handoff and gate receipt, not a log
or cache claim. It reselects the publication's complete relevant checks at its
frozen base, compares configuration, exact selection, content tree/fingerprint,
successful execution and run/revision bindings, and rechecks the remote and PR.

The synchronous queue API accepts only a freshly checked single-use in-process
admission (at most 30 seconds old), bound to a private snapshot of the measured
evidence and ownership. Editing an issued ticket to match newer state is not a
measurement and refuses queueing. The queue stores its project/revision, head,
report ID/digest, gate run, criterion
evidence IDs and handoff reference. Reconstructing IDs is not a check. Queue
normalisation preserves damaged autonomous metadata rather than dropping it.
Restarted jobs must present matching persisted evidence and pass the full door
again. Direct rounds evaluate it too. A v2 round uses one PR, the existing lease,
gate lane, gate and head-pinned squash; there is no separate merge executor.

Immediately before squash the leased round rereads admission and compares its
initial evidence IDs, measured head and live base. Gate green is not permission
to omit the measured head, land without a head pin or land changed review/evidence.
A PR acquiring
autonomous ownership during a legacy round requires a new admitted round;
the docs shortcut also rereads ownership after document checks.
Derived regeneration that pushes a different
head needs a new publication/review. Docs and admin shortcuts refuse autonomous
PRs even with a clean report. Automatic docs-only routing uses the normal merger
instead of the lease-free docs shortcut.

## Main movement: tests and review are separate

The existing receipt-bound gate exact/delta selection measures changed test and
command coverage; absent or uncertain reuse falls back to relevant measurement.
Review relevance is a separate conservative decision. A forward main movement
with exactly the same integration tree can keep review: no input changed.
Substantive movement, including disjoint code or another project's documents,
is not proven semantically independent merely because test selection found no
overlap. It requires renewed review. Non-forward movement, missing trees or
unknown analysis refuse; an empty/failed path read is not an all-clear. More
permissive semantic dependency proofs are not implemented.
This rule is checked before the round and again before landing, independently
of whether the gate found any tests to rerun.

## Reports and outcomes for plan

`recordAutonomousReview` atomically appends the immutable report, its attributed
criterion summary and a `review-reported` event to `AUTONOMOUS_STATE.json`.
Every criterion remains visible, including findings, uncertainty and deferred
after-integration work. Neither the report nor routing confirms the goal or
creates a build job. Findings/unknowns stay `plan_pending` for plan.

After the review process exits, `routeAutonomousReview` rechecks the full
admission door and hands its fresh ticket to `queueMerge`. The review role
itself still cannot publish or merge. Routing has a process-owned project claim;
no model is involved in retrying an interrupted handoff. A durable `merge-queued`
event and `merge_handoff` intent put the project in `landing` **before** the
queue write/start. A crash after the report or intent can resume through the
inactive runner's routing-only continuation. An existing queue row prevents a
second enqueue; corrupt queue content is not interpreted as empty. Refused
admission produces `merge-refused`, `plan_pending` and no new job.

Merge events carry the report ID/digest, reviewed head, branch/PR and frozen
goal/programme revisions. Their digest identities exclude timestamps and round
log trivia, so duplicate completion, round/merger delivery and readback do not
append duplicates. A terminal answer requires plan and renewed review evidence
before another admission; the same clean report cannot silently retry a red.
Late old-revision events remain history without overwriting the current goal.

The direct round and queued merger both record outcomes. The merger commits
the plan event before removing/answering a queue row, including its exception
fallback and red-row sweep. If authoritative state cannot be written, the job
is retained for recovery rather than discarded. A direct round exposes a
persistence failure as `outcome_error`; its durable landing intent permits
readback recovery without repeating the merge. Successful readback requires
the admitted head, a full merge SHA and target `main`; another head/base or
missing facts remains unknown, not a goal landing.

Explicit autonomous jobs (including damaged autonomous queue metadata and
persistently owned v2 PRs) bypass legacy mend, pushed-job requeues, repeated
red-under-load/file-killed rounds and retry ownership. Red/closed/thrown results
produce `merge-failed`; an unreadable merge result produces `merge-unknown`.
Both leave `plan_pending`, with no builder session. Resource/lease waits still
wait. V1 keeps its existing mend, load retries, push handling and step booking.

A crash after the actual squash but before its event is recovered from GitHub,
either by the restarted queue job, the red-row sweep after `merge-unknown`, or
the routing continuation of a direct round. It writes `merge-landed` and
`landing` facts, never planner confirmation. `landed` is not `confirmed`.
Deferred after-integration checks still need follow-up before plan confirms;
they do not block their own merge. Existing v2 archive guards refuse the legacy
auto-archive path even after landing; autonomous archive/activation remains
future operations work. No live programme is activated here.

## Verification

`mc gate tests/mc/autonomous-merge.test.js tests/mc/merge-boundary.test.js`
exercises real temporary repositories, bare remotes, published handoffs,
receipt readers, detached review checkouts and selectors. Controlled gate and
GitHub adapters test pinned leased landings, changes during measurement,
missing/corrupt/stale evidence, main relevance, docs/admin/direct doors and
restarted queue metadata without hosted model calls or live programmes.

`mc gate tests/mc/autonomous-merge.test.js tests/mc/merge-command.test.js tests/mc/merger.test.js`
also exercises trusted runner auto-routing, duplicate report/event delivery,
report/queue-intent/landing crash gaps, unavailable state persistence,
head/main movement, lost merge replies and later readback, no premature
confirmation/archive, autonomous red ownership and the preserved v1 retries.
