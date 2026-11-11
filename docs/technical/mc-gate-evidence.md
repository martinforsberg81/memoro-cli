# Local gate evidence

`mc gate` freezes the base commit and fingerprints the launch worktree before
starting its detached session worker. The worker checks that content before
selection and after all checks. A temporary Git index computes the prospective
commit tree without changing the real index. It starts from a copy of the real
index (its stat cache, with the original's mtime for Git's racy-entry check) when every
entry is ordinary, and from `HEAD` when any is assume-unchanged, skip-worktree
or unmerged; on memoro that is about 5 s rather than 27 s. A second fingerprint includes raw tracked and
non-ignored untracked bytes, executable bits and symlink targets. Ignored
untracked dependencies/output are excluded. Submodule content cannot currently
be fingerprinted: those runs produce no reusable evidence.

Completed attempts are stored as exclusive, immutable JSON files under
`<mc home>/gate-evidence/<gate run id>.json`. They identify the repository name
and common Git directory, gate run, optional session run and goal revision,
frozen base SHA, measured tree/raw fingerprint, measurement version, timestamps,
actual selected files/commands/flags/pattern, configuration (the effective gate
declaration and test-flag hash), execution (the executed timeout, Node version and
each batch's argv), members (files and commands reused from earlier passing
content), selector (the sidecar reference, or why it could not be written), phases
(`phaseLedger`) and execution outcome. What makes a receipt green is the
`executionComplete` paragraph of [mc-merge.md](mc-merge.md). A repeated
write must have identical bytes. The detached worker, not the waiting command,
writes the receipt before publishing its result and exit marker. The waiting
command then clears the matching worktree exclusion lock.

Only completed checks with known successful exits and unchanged content produce
a green receipt. No checks, zero executed tests, unknown exits, interruption,
failed checks and content mutations are not green. An explicitly allowed
unavailable command gives the verdict `incomplete` (`ok` false, `complete` false,
printed `INCOMPLETE`, no receipt line; `gate-local.js`, `commands/gate.js`). Its
exit is 0, because the process held, and its stored receipt's outcome is
`incomplete`, never green (`session-gate-evidence.js`). An interrupted worker may leave no receipt; absence is not green.
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

## Raw and normalized selection

The session route keeps the selector's answer twice. The selector sidecar,
`<mc home>/gate-evidence/<gate run id>.selector.json` (`session-gate-run.js`,
`selectorSidecar`), holds the raw selector stdout and its sha256 beside the
normalized plan: `selected`, `added_tests`, `main_only_excluded`, `reused_files`,
`run_files`, `deferred`, `covered`, `commands` and `classes`. The receipt's
`selector` names the sidecar and the raw hash. A sidecar that cannot be written
records `selector.status` `unavailable` with its reason; it changes neither the
verdict nor the membership. The phase ledger (`phaseLedger`) takes its total from
the enclosing execution interval, never the sum of its overlapping children
(selection, tests, commands, the fingerprints and the sidecar). It names the pairs
that overlapped, and the clocks it did not observe: `caller` and `fixture`.

## Retention

Selector sidecars are attribution and are kept 7 days. Receipts are kept 30 days, and longer while a retained gate-greens.jsonl entry names them. A pruned receipt only costs reuse: resume and candidate reuse treat a missing receipt as no evidence, never as green. Pruning runs at most hourly after a session gate and never affects its verdict.

Ages are file mtimes. The prune (`pruneGateEvidence`, `src/mc/session-gate-evidence.js`) also removes temporary files over a day, content-index markers whose receipt is gone, and content directories left empty. It touches only names the writers produce; `gate-evidence/.pruned` records the last run. A selector sidecar is written by the session route only (`session-gate-run.js`); the candidate route (`repo-gate.js`) keeps `raw_sha256` and `report.intervals` and writes no sidecar.

## Settling a red

A command gate that exits nonzero in the round is not called red at once. Its
round line says `red in the round` and no `command <id>: fail` line is written,
so a green verdict never names it failed. Once both halves have finished, it
runs once more alone, with the same invocation, environment and timeout, and
nothing else of the gate beside it. A pass there is `command gates green alone`
in the SETTLED line and a passed member of the receipt; the receipt is not
green, because its round had a failure. A command still red alone is red after
its second run, and the verdict names it `command <id>: fail`. A command cut by
its timeout, killed by a signal, unavailable at its declared exit, whose shell
threw, or whose gate was aborted is not run again, and stays red as it was. No
command runs at the base. `mc gate --command <id>` runs one command gate of this
change's selection alone, reusing nothing, and a red there is counted at once.

A session's gate shares the machine with the runner's sessions and the merger,
and a test red on main is red in every branch's gate. A red whose only cause is
failed files, every one of them finished, is therefore settled before it is
called the change's (`src/mc/gate-settle.js`, called from
`session-gate-run.js`): the red files run once more alone, one file at a time
(`lanes: 1`), with the same flags and per-test limit, through the same tracker.
A file that passes there is `green alone`. A file still red that the change
does not touch (`git diff --name-only <base>` and untracked files) runs alone at
the frozen base in a temporary detached worktree under
`<work root>/runner/gate-base/`, with its dependencies attached, removed
afterwards. When every test it failed on the candidate fails there by name, it
is main's. What remains is the change's red. A crash, unknown exit, cut or
unfinished file, an unattributed failure, more than `SETTLE_FILES_MAX` red
files or a test over its limit alone is never settled. The verdict says
`SETTLED` and names both groups; the result and `--json` carry `settled`. A
settled attempt exits 0 but its receipt is not `green` (its round had a
failure), so it grants no reuse beyond its members: files that passed alone
are `passed` members and resume, main's red files stay `failed` and run again.

Session authorization and receipt reuse are distinct. Martin, 2026-11-11:
a completed final whole selection with only adjudicated untouched-baseline
failures authorizes review/finish/mend handoff under
[publish-and-merge](../../canon/tasks/publish-and-merge.md); delivery does not
wait for the owning repair. Retain the frozen base and named failed members.
The receipt remains incomplete and its failed members cannot be reused as
passed. The ordinary merger measures and adjudicates against its current base.
This rule does not admit partial execution or a change-caused criterion failure.

## Waiting and recovery

Three mechanisms are distinct:

- **Worktree exclusion:** `src/mc/commands/gate.js` uses a short atomic
  `mc-gate.json.launch` claim to serialize launch, then stores the worker PID
  and log in `<worktree git dir>/mc-gate.json`. A second launch there refuses
  while that worker lives without an exit marker. Other worktrees are not
  excluded by this lock.
- **Detached child lifecycle:** `src/mc/session-gate-run.js` owns selection,
  test/command children, receipt, result and exit marker. It starts at low
  priority without a merger lane; for memoro it waits for a deploy/iOS build
  before execution. Budget expiry returns `RUNNING` (exit 3), leaving this
  worker and the worktree lock intact. The command's budget includes that
  build wait, not a merger-lane queue. `mc gate --wait` observes the same
  request/log; its own budget expiry neither starts nor stops work. SIGINT,
  SIGTERM and the repository ceiling propagate abort to active test/command
  children; an interrupt or ceiling is not a completed green measurement.
- **Merger-lane reservation:** `src/mc/gate-lock.js` uses an atomic
  `gate-running-<repo>.json.claim` plus a status file under mc home, owned by
  a live PID, for repository rounds/builds. `takeGateLock`/`releaseGateLock`
  guard ownership; `repo-gate.js` takes/releases this reservation. The local
  session worker does not. Evidence reserves no lane or extra resources.

After an exit marker or observed worker death, the waiting command removes
only its matching worktree lock. Standard/sqlite test-process concurrency and
heavy-batch exclusivity are resource batching, not merger-lane reservations.

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
not measured until `mc gate --whole-selection` or the merge round measures them.
Every goal pull request now goes through the merge round (#1449;
[publish-and-merge](../../canon/tasks/publish-and-merge.md)), which does not defer
(`commands/gate.js` defers only a bare session gate). `mc gate --whole-selection`
is the complete affected-selection measurement;
timeouts, interruption and incomplete execution remain red.

Named runs and name-filtered runs retain exactly that limited scope, even when
the resource selector names additional tests or commands. Only an entire,
unfiltered affected selection can populate the existing `gate-greens.jsonl`
cache, after its receipt is durable. The shared measurement contract's current
version (`GATE_MEASUREMENT_VERSION`, 5, `src/mc/gate-greens.js`; see
[mc-merge.md](mc-merge.md)) invalidates older cache entries. Added-test discovery, repository
imports, resource batching and lane reservations remain the existing gate's.

A valid full receipt may serve a smaller selection of the same tree when its
files and command invocations cover that selection and the version, configuration,
flags and execution identity still match.

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
and checks the current declaration, content tree and coverage of the selection. Delta
reuse reads a compatible full receipt for the PR head, then asks the existing
dependency-aware selector about main's movement and derived paths. Newly selected
or newly configured commands/checks are measured; missing receipts, changed
configuration, untraceable ancestry or uncertain selector output cause normal
relevant measurement, never assumed green. Required merge gates and PR-specific
tests still run. Legacy cache entries remain readable to v1 callers, not to
opt-in receipt-bound callers.
