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

After selection, the local session gate starts its test run and its selected
command sequence together. Commands remain serial, in selector order, and each
receives the frozen base when requested. A normal verdict waits for both
sequences to settle; a test or command failure/throw cannot hide the other
half's result, and a thrown half is caught while the collaborating work settles.
An abort starts no later command and propagates the same signal to the active
test and command children. This removes additive command waiting; command
execution evidence is available while tests are still running.

At the repository ceiling the worker returns a red snapshot rather than
waiting beyond its bound. It reports every active phase, retains finished test
and command evidence, lists unfinished files, and identifies running and
pending commands separately. A command phase change does not discard the test
file selection. Such a partial execution is not a reusable green receipt: the
receipt constructor requires every selected command and the test half, when
selected, to have completed successfully with known exits and unchanged
content. The ceiling does not make a selected test set smaller or claim to
solve the study selector's test-selection ceiling.

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

## Coverage and bound consumers

Every completed worker result carries the selected coverage shape (`kind`,
`files`, `commands` and `pattern`) and the exact `deferred` file members in its
result JSON, whether or not the attempt can produce a reusable receipt. An
ordinary gate with deferred files is explicitly `partial`: those files were
not measured, and direct goal landing does not promise another gate. Use
`mc gate --whole-selection` for a complete affected-selection measurement;
timeouts, interruption and incomplete execution remain red.

Named runs and name-filtered runs retain exactly that limited scope, even when
the resource selector names additional tests or commands. Only an entire,
unfiltered affected selection can populate the existing `gate-greens.jsonl`
cache, after its receipt is durable. Version 3 of the shared measurement
contract invalidates older cache entries. Added-test discovery, repository
imports, resource batching and lane reservations remain the existing gate's.

Receipts alone grant no execution, publication or merge authority.
`findPublicationReceipt` has no caller in `mc publish` or the merger. The caller supplies the frozen local commit and
an independently observed remote SHA; both must be the current local HEAD. Its
tree and current raw worktree content must match the receipt. An equal-tree
commit after an uncommitted measurement is valid, including additions/deletions;
post-gate edits, another repo/gate run/session/goal revision, missing evidence,
and obsolete measurement versions are not. The required final relevant selection
must match the full, unfiltered receipt, including test flags and command
invocation semantics. Focused checks are never broadened into that selection.

Receipts also retain a hash of the effective repository gate declaration and
test flags, covering operator-table changes outside Git. Bound callers of
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
