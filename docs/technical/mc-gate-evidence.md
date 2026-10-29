# Local gate evidence

`mc gate` freezes the base commit and fingerprints the launch worktree before
starting its lane-owning worker. The worker checks that content before selection
and after all checks. A temporary Git index computes the prospective commit tree
without changing the real index. It starts from a copy of the real index (its
stat cache, with the original's mtime for Git's racy-entry check) when every
entry is ordinary, and from `HEAD` when any is assume-unchanged, skip-worktree
or unmerged; on memoro that is about 5 s rather than 27 s. A second fingerprint includes raw tracked and
non-ignored untracked bytes, executable bits and symlink targets. Ignored
untracked dependencies/output are excluded. Submodule content cannot currently
be fingerprinted: those runs produce no reusable evidence.

Completed attempts are stored as exclusive, immutable JSON files under
`<mc home>/gate-evidence/<gate run id>.json`. They identify the repository name
and common Git directory, gate run, optional session run and goal revision,
frozen base SHA, measured tree/raw fingerprint, measurement version, timestamps,
actual selected files/commands/flags/pattern and execution outcome. A repeated
write must have identical bytes. The detached worker, not the waiting command,
writes the receipt before publishing its exit code and releasing ownership.

Only completed checks with known successful exits and unchanged content produce
a green receipt. No checks, zero executed tests, unknown exits, interruption,
failed checks and content mutations are not green. An explicitly allowed
unavailable command may retain its existing v1 gate verdict, but cannot mint a
green receipt. An interrupted worker may leave no receipt; absence is not green.
A command reporting `RUNNING` does not create a receipt on the worker's behalf.

## Waiting and recovery

The command's budget includes lane waiting. Budget expiry returns `RUNNING`
(exit 3) and leaves the worktree lock in place; the detached worker continues
holding its own lane and test children, not the short-lived command's. Another
caller in that worktree is refused while it runs. `mc gate --wait` observes the
same log/result and can itself time out without starting or releasing anything.
An orderly worker interrupt stops the active child group before releasing the
lane. Standard/sqlite batches retain the selected lane count; heavy batches
remain exclusive. Evidence does not reserve additional resources.

A worker that disappears without its exit marker is a red command, even if its
log printed passing counts or its result file exists. A failure before receipt
persistence leaves no discoverable green evidence. A failure after persistence
but before the result/exit marker or reuse-cache update leaves the completed
receipt intact: a later session can read that run's receipt idempotently through
`readGreenReceipt` or the stricter `findPublicationReceipt`. Neither lookup
reconstructs success from log output. Missing/truncated receipts are not green;
start a fresh measurement with a new run ID rather than overwrite an attempt.
An absent cache entry simply causes the merger to measure again.

## Coverage and autonomous consumers

Named runs and name-filtered runs retain exactly that limited scope, even when
the resource selector names additional tests or commands. Only an entire,
unfiltered affected selection can populate the existing `gate-greens.jsonl`
cache, after its receipt is durable. Version 3 of the shared measurement
contract invalidates older cache entries. Added-test discovery, repository
imports, resource batching and lane reservations remain the existing gate's.

Receipts alone grant no autonomous execution, publication or merge authority.
`findPublicationReceipt` is used by the inactive autonomous finish boundary,
not by v1 publication. The caller supplies the frozen local commit and
an independently observed remote SHA; both must be the current local HEAD. Its
tree and current raw worktree content must match the receipt. An equal-tree
commit after an uncommitted measurement is valid, including additions/deletions;
post-gate edits, another repo/gate run/session/goal revision, missing evidence,
and obsolete measurement versions are not. The required final relevant selection
must match the full, unfiltered receipt, including test flags and command
invocation semantics. Focused checks are never broadened into that selection.

Receipts also retain a hash of the effective repository gate declaration and
test flags, covering operator-table changes outside Git. Autonomous callers of
`runGate` explicitly supply an `evidence` binding (`repository`, gate `run`,
optional `sessionRun` and `goalRevision`). Exact reuse reads the durable receipt
and checks the current declaration, content tree and complete selection. Delta
reuse reads a compatible full receipt for the PR head, then asks the existing
dependency-aware selector about main's movement and derived paths. Newly selected
or newly configured commands/checks are measured; missing receipts, changed
configuration, untraceable ancestry or uncertain selector output cause normal
relevant measurement, never assumed green. Required merge gates and PR-specific
tests still run. Legacy cache entries remain readable to v1 callers, not to
opt-in receipt-bound callers.

The [autonomous finish operation](mc-autonomous-publish.md) binds its complete
session gate to the reserved run/goal revision and revalidates this evidence at
publication and settled process completion. Evidence lives under mc home;
handoff artifacts remain under work root. This does not activate autonomous
programmes or alter v1 publication/admission lifecycle dispatch.
