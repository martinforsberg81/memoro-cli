# Autonomous finish and publication (inactive)

V2's goal step uses `mc goal finish <programme>/<goal>
--expected-revision <n> --input-file <json>`, not ordinary `mc publish`.
Neither command activates a programme. V1 publication still pushes and queues
its PR, or books a branch-flow step built, as before.

Finish's JSON contains exactly `goal_revision`, `message`, `title`, `body` and
`result`. The latter is the bounded, revision-bound `mc-session-result` from
[session handoffs](mc-autonomous-run.md), with `handoff.published_sha: null`.
The command fills the observed commit SHA; the model cannot supply publication,
process-completion or gate facts. Handoff criterion IDs/references must match the
latest verified builder evidence for the current assignment. A review-ready
result also needs evidence for every premerge criterion and no remaining work.
Builder reports are not independent review or plan confirmation.

## Preparing a publication

The operation requires the active **step** owner, the sent current assignment,
the owned checkout branch and session control in `closing`. Time/context close
requests do not relax verification. A worktree claim serializes competing finish
calls; the durable project owner remains reserved through every phase.

The project's `publication` record pins the run and goal revision,
branch/PR and bounded input. Resume and completion reject a publication from
another goal revision even when its content still matches. Programme metadata
changes do not invalidate its evidence. It advances through:

1. `started`: intent saved before external work.
2. `gate_verified`: the complete affected session gate completed green. Finish
   calls the existing `mc gate --json`, with no named files or name filter, using
   its selector, command gates, bounded runner and shared lane reservation.
3. `committed`: that measured prospective tree is committed. An already matching
   commit needs no empty commit. Both commit tree and raw worktree fingerprint
   must still match the immutable receipt.
4. `pushed`: non-force publication through mc independently confirmed the exact
   head with `git ls-remote`, not a tracking ref or a push exit code alone.
5. `pr_resolved`: GitHub confirmed the same open PR, owned branch, exact head,
   main base and persistent review-required marker.
6. `handoff_committed`: the trusted runner observed successful process closure,
   quiescent tools/gates and unchanged publication, then committed the immutable
   session result/current handoff pointer.

The first five phases run inside finish. A `pr_resolved` command response means
**exit the session**, not a normal handoff already recorded. Only the runner can
perform phase six after process completion. It rechecks current criteria, gate
coverage/configuration/base, content, remote SHA and GitHub identity. The owner
and `publishing` phase remain held until the runner's
[continuation/recovery door](mc-autonomous-recovery.md) verifies and routes them;
publication itself grants no continuation, review or merge permission.

## Retry and refusal

Retry the identical finish input with the latest state revision. Saved phases
resume without redoing implementation or requiring another commit. A push error
keeps the local commit and green evidence; an already-pushed head is observed
and reused. PR lookup includes closed PRs so a closed or ambiguous PR cannot
silently become a second one. The known PR number is recorded as soon as it is
located, before final read-back; the external marker also preserves identity
across a local bookkeeping failure. Immutable handoff writes accept identical
replay after a pointer-write failure.

The required selection is recomputed with the gate's own diff/declaration/flags
and added-test discovery. Receipt session/goal binding, measurement version,
configuration, base, full coverage, known completed execution and current
content must match. Named/filtered, red, RUNNING, unknown, interrupted, empty or
missing receipts cannot close normally. Post-gate edits invalidate the measured
publication; they do not get folded into an unchecked push. Unknown process or
gate ownership also prevents normal handoff. Failures retain ownership and
commits, never queue merge or start another builder.

## Persistent ownership and independent merge admission

Before publication, a durable branch marker is written under
`<work root>/runner/autonomous-prs/`. It binds repository, branch, programme,
project and (when known) PR number, independently of PLAN/STATE readability.
New PRs are drafts and their bodies contain
`<!-- mc-autonomous: review-required -->`. Subsequent publication preserves it.
Ordinary publish refuses a known autonomous branch even without runner env.

The [independent merge door](mc-autonomous-merge.md) validates these PRs at
queueing and again at landing. Docs and admin shortcuts still refuse them;
automatic docs-only routing sends an admitted autonomous PR to the leased
merger instead. Existing v1 behavior is unchanged.
Missing/corrupt project state cannot downgrade a marked PR to unchecked v1.
Publication cannot clear the marker or authorize merge by itself.

`tests/mc/autonomous-publish.test.js` uses real temporary repositories/bare
remotes and stubbed GitHub, with synthetic completed execution observations for
receipt-reader tests. It does not make hosted model/provider calls or claim a
live autonomous programme has run. Normal execution remains disabled.
