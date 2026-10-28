# Local gate evidence

`mc gate` freezes the base commit and fingerprints the launch worktree before
starting its lane-owning worker. The worker checks that content before selection
and after all checks. A temporary Git index computes the prospective commit tree
without changing the real index; a second fingerprint includes raw tracked and
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

Named runs and name-filtered runs retain exactly that limited scope, even when
the resource selector names additional tests or commands. Only an entire,
unfiltered affected selection can populate the existing `gate-greens.jsonl`
cache, after its receipt is durable. Version 2 of the shared measurement
contract invalidates older cache entries. Added-test discovery, repository
imports, resource batching and lane reservations remain the existing gate's.

Receipts alone grant no autonomous execution, publication or merge authority.
Committed/pushed-content lookup and autonomous admission belong to subsequent
work; this change does not activate autonomous programmes or alter v1 project
lifecycle dispatch.
