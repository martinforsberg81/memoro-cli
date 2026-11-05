# Named gate scope discrepancy: bounded diagnosis

## Finding

The two preserved incident requests do **not** show a different named-file
selection. Both requested `tests/mc/tidy.test.js`, both have
`addedTests: []`, both have `pattern: null`, the same flags, the same selector
string, the same frozen base, and the same candidate tree and fingerprint.
Their saved TAP logs nevertheless report different execution results: 54
tests in 12 suites versus 67 tests in 14 suites. The 13-test, two-suite
difference is real in the saved logs, but its cause is **unresolved**. A
different `addedTests` claim is unsupported by these requests.

The evidence is consistent with test-process inputs outside the recorded
candidate/file selection differing, but does not establish which input. In
particular, the request records the explicit pattern (`null`), not the
effective Node process environment. `suiteEnv` preserves `NODE_OPTIONS`; the
test launcher also preserves inherited `NODE_OPTIONS` after stripping only
reporter flags. An inherited test-name filter, preload/loader, or other process
setting is therefore a concrete hypothesis, not a demonstrated cause. The
logs do not preserve the child environment or actual child argv, so this
hypothesis cannot be tested against the historic runs.

**Decision:** no runtime change and no test change from this diagnosis. Do not
infer that identical GREEN counts or fingerprints alone prove identical test
execution. If exact scope matters again, make one bounded replay at the same
clean pinned HEAD with the same named file, capture the effective child argv,
Node version, `NODE_OPTIONS`, and all relevant environment values (redacting
secrets), then repeat with `NODE_OPTIONS` removed. Compare TAP suite names and
counts. That is the smallest discriminating check for the leading hypothesis;
commission any runtime change separately only if it demonstrates a fault.

## Preserved incident reconciliation

Source: the two `.log`, `.log.request.json`, `.log.request.json.result`,
`.log.exit`, and evidence receipt files named below. No incident file was
modified. Both request/result pairs identify candidate tree
`e748bad856c4f8aa63a33af56f28d587c11b4eae`, fingerprint
`22a7840822e44a65411bf8c6ef1963e62b82dc871e01133d480782f4ae3d1fcd`, base
`9e951b601d37ea173c5c5da888ded59b4e85f1ef`, configuration
`4ce9e075ba31eed5eabd562d66584470fd4d20449a180ae578e2371bbcac5fb6`, and
`mainOnly: []`. Neither has a test-name pattern.

| Saved request | Recorded cwd | Named files / added tests | Flags / pattern | TAP suites and result | Gate receipt interval |
| --- | --- | --- | --- | --- | --- |
| `gate-20261105T192926Z-c6e0d7d2-7b4d-41d5-878d-25021d235189` | `/private/tmp/mc-review-tidy-953dfeb-KBSeSb/replay` | `tests/mc/tidy.test.js` / `[]` | `--import ./tests/_isolate-home.mjs --test-timeout=30000` / `null` | 54 pass, 0 fail; 12 suites; TAP `duration_ms 4624.737` | 2026-11-05T19:29:27.241Z–19:29:38.861Z |
| `gate-20261105T193007Z-d94ca802-6fd5-44ef-b0d5-a3309c46918e` | `/Users/martinforsberg/mc/programs/mc/goals/tidy-legacy-replays/memoro-cli` | `tests/mc/tidy.test.js` / `[]` | `--import ./tests/_isolate-home.mjs --test-timeout=30000` / `null` | 67 pass, 0 fail; 14 suites; TAP `duration_ms 2173.598` | 2026-11-05T19:30:08.305Z–19:30:18.532Z |

Both recorded selector strings are exactly:

```text
node scripts/affected-tests.js --base-ref '9e951b601d37ea173c5c5da888ded59b4e85f1ef' --changed-path 'tests/mc/tidy.test.js'
```

The 54-test log ends after `the list file and the apply`; the 67-test log adds
`the printout` and `(S) worktrees and DerivedData in ended runner sessions'
scratch directories`. Both are complete TAP runs, not `SKIP`-marked omissions.
The logs print the selector invocation and declared flags, but not the full
child command/argv or its environment. The execution path in the source builds
`node --test` with the named files, TAP reporter, concurrency/timeout/force-exit
defaults and declared flags; the saved request does not preserve those computed
defaults or inherited process environment.

The request/result pairs agree internally on their respective counts, and
both evidence receipts say `green`; this confirms what each saved run reported,
not why their reported TAP differs. `addedTests` is not the explanation: for a
named request `gate.js` leaves it empty and `session-gate-run.js` uses the named
file list as the test input. The selector can supply resource-class metadata
for a named request; it does not replace that explicit file list.

## Source inspection and identity limits

Inspected the gate request construction, worker, test launcher, content
fingerprint/evidence helper, and selection/flag helpers. At the inspection
revision (`9e951b601d37ea173c5c5da888ded59b4e85f1ef`, clean), SHA-256 source
hashes were:

| Source | SHA-256 |
| --- | --- |
| `src/mc/commands/gate.js` | `ac3a2eb75d9589dcdbdf0787a0e0117beb24421173d379109b685b0b8d497de2` |
| `src/mc/session-gate-run.js` | `0028522ce48aa5f72610093c7fc7a68e8213ffdcf410dc2cb59f8c0dbb3f3f67` |
| `src/mc/repo-gate.js` | `1c6fe2ce94a98cace40f2a1fc4d0f3a3d3d6825fa6f3c4dadba1530fe9ea7de3` |
| `src/mc/session-gate-evidence.js` | `f58a37a994f0081b62121137aa5277cc3a3812aa70fa9a61083ed6c1f68d27f7` |

Those hashes also match the preserved 953 scratch worktree and the current
tidy-legacy-replays worktree. The replay worktree is currently clean at
`953dfeb56d74b36f8fcad4ccf773edd29ddbd0dc`, real path
`/private/tmp/mc-review-tidy-953dfeb-KBSeSb/replay`, with root tree
`e748bad856c4f8aa63a33af56f28d587c11b4eae`. The tidy worktree is currently
clean at `14c8f4c42953f7dfee2c5e46feefa0ae31260bf2`, real path
`/Users/martinforsberg/mc/programs/mc/goals/tidy-legacy-replays/memoro-cli`,
root tree `1cb309e8daeaea36fb05329cd0b89a69fe0400ef`. Its later test-file
change relative to 953 adds 13 assertion lines inside an existing S test and
renames that test; it does not add the `printout` and S suites, which are
already present in the 953 test blob. This post-incident tree difference does
not explain the historical 54/67 suite delta.

Measured from source:

* `commands/gate.js:149–190, 223–236` validates named paths, reads declared
  flags and declaration, builds the request, captures a candidate snapshot,
  and starts the worker. It stores files, `addedTests`, flags, explicit
  pattern, selector, base and candidate identity, but not HEAD or environment.
* `session-gate-run.js:95–120` fingerprints before and after a measured run
  and invalidates evidence if the content differs. Lines `123–180` run the
  selector, retain `request.files` for named requests, and pass the request's
  flags plus only an explicit pattern to `realTests`.
* `repo-gate.js:2234–2249` (`suiteEnv`) removes `NODE_TEST_CONTEXT`, `MC_WORK_ROOT`
  and `MC_HOME`, but leaves `NODE_OPTIONS`. Lines `2363–2404` resolve effective
  flags and construct the Node test child; inherited `NODE_OPTIONS` is retained
  after reporter-option stripping.
* `session-gate-evidence.js:12–79` hashes a prospective Git tree and tracked /
  nonignored untracked file bytes. This is content identity, not an identity for
  Node version, argv defaults, ambient process environment or runtime hooks.

The two receipts' same tree and fingerprint plus their green outcomes are
evidence that mc accepted each run against the same recorded candidate
identity. The receipts do not retain the actual before/after snapshots, and
the requests do not record historical HEAD/status, child argv, Node version,
or environment. The current clean status of the preserved worktrees is not
proof of their status at gate start. No claim is made that mocks in the tidy
fixture prove real Git/lsof concurrency behavior.

## Probe accounting and scope

Additional named-file gate runs: **0 of 4 permitted**. No direct test command,
runtime mutation, test change, production operation, or mutation of an
incident/reviewed worktree was performed. Those preserved trees were read-only.
There is no demonstrated
implementation fault to commission from this evidence; the cause remains
bounded but unresolved because environmental/runtime execution inputs were
not saved.
