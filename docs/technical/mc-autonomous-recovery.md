# Autonomous continuation and recovery (inactive)

The injected v2 runner reconciles a published build before releasing its owner.
This does not enable a live programme, launch independent review, confirm a goal
or queue merge. V1's step selection, failed-to-person and archive behavior remain
separate. V2 cannot enter the legacy project archive, even when a legacy register
entry says done. Its records stay until plan has confirmed it and the
programme itself is archived with `mc plan <programme> --archive`
([mc-plan.md](mc-plan.md#archiving-a-programme)).

## Continuation states

- `publishing`: the previous run owns the checkout through gate, commit, push,
  PR resolution and immutable handoff/current-pointer writes. Publication phases
  are described in [autonomous finish](mc-autonomous-publish.md).
- `ready`: a normal, verified publication has settled but at least one premerge
  criterion lacks a current verified builder report in the published handoff.
  The next build gets a new run ID, fresh bounded context and the same branch/PR.
  Its normal starting main integration and affected gate still run.
- `review_ready`: every premerge criterion has a matching current builder report
  in the published handoff. After-integration criteria do not block this state.
  This is a report to the future independent review door, not a clean review or
  permission to merge. Even a `continue` interpretation cannot start another
  builder when all those premerge reports are done.
- `plan_pending`: an incomplete attempt, missing/unknown completion, stale or
  changed publication, failed recovery, or an explicit out-of-scope/needs-plan
  attempt. The durable reason, commits and existing handoff reference remain.
  Ownership stays held; there is no automatic failed-to-person fallback, retry
  builder or archive. Only later plan operations can authorize more work.

A zero exit code alone never selects `ready` or `review_ready`. The trusted
supervisor must have observed successful transport completion, persisted its
bound control/result and snapshot, and reconciled child processes and gates.
The runner then rechecks the current assignment, criterion reports, complete
relevant gate receipt, commit/raw content, actual remote SHA and marked open PR.
The handoff and continuation transition are independently idempotent; a crash
between them does not launch another builder.

## Interrupted publication

A process-owned project claim spans preparation, supervision, publication and
continuation. Competing runners use the same claim and durable run owner.
Recovery uses an existing capacity slot but no model route or implementation
session. It takes the session/finish claims and checks the process group and
gate completion before touching publication. Live or unreadable claims remain
held. Unknown children produce plan-pending, never an inferred green result.
No recovery path signals a process found in a manifest.

With durable successful supervisor completion, recovery resumes the identical
saved finish input and phases. A commit made before its phase write is recognized
by the measured tree; an already-pushed SHA is read from the remote and is not
pushed again. PR lookup includes closed PRs and never replaces an owned PR. A
lost create response finds the original PR by its branch. Handoff writes replay
the same immutable artifact before repairing its current pointer.

If recovery itself committed the already measured bytes before crashing, it may
recognize that same-tree descendant on the bound run/revision. It must still
pass the publication receipt checks. Recovery saves a fresh snapshot outside the
checkout before advancing the manifest; the earlier snapshot stays immutable.
Changed staged, unstaged or untracked bytes are never reset, stashed or folded
into an unchecked publication. A crash without proven supervisor completion is
an incomplete attempt for plan, even if a commit or push already exists.

`tests/mc/autonomous-recovery.test.js` exercises these crash boundaries with real
temporary Git repositories/bare remotes, stubbed GitHub and synthetic completed
gate observations. No hosted model, live programme or deployment is exercised.
