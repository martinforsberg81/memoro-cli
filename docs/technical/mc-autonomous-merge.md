# Autonomous merge admission (inactive)

No programme is activated by this implementation. V1 criteria, queue, review,
retry and merge paths remain unchanged. Autonomous publication still does not
enqueue work; this step supplies admission, not automatic outcome routing.

## Every door

Persistent repository/PR/branch ownership in `runner/autonomous-prs/` identifies
autonomous changes even when GitHub, PLAN, state or the review is unreadable.
An unresolved marker, corrupt registry or marker without matching state refuses
admission, never falls back to legacy `notChecked`. A body marker or v2 branch
without durable ownership also refuses rather than guessing authority.

`criteriaDoor` checks autonomous admission before legacy step lookup. A current
settled publication, durable normal handoff, matching sent/approved assignment,
all current published verified premerge criterion evidence, and a complete clean
independent report are required. After-integration criteria may remain deferred;
they do not block their own merge or count as planner confirmation. Active or
incomplete attempts are not admissions.

The report must match the full assignment and criterion digests, published SHA,
gate run, historical builders and reserved independent reviewer. New commits
(including equal-tree commits), changed criteria/evidence and findings invalidate
it. The latest report must be clean; an earlier clean report cannot override a
later finding. Admission reads the immutable handoff and gate receipt, not a log
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

## Verification

`mc gate tests/mc/autonomous-merge.test.js tests/mc/merge-boundary.test.js`
exercises real temporary repositories, bare remotes, published handoffs,
receipt readers, detached review checkouts and selectors. Controlled gate and
GitHub adapters test pinned leased landings, changes during measurement,
missing/corrupt/stale evidence, main relevance, docs/admin/direct doors and
restarted queue metadata without hosted model calls or live programmes.
