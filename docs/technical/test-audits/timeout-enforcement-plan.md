# Declared timeout, executed timeout and evidence

2026-11-05. Documentary diagnosis and proposed implementation contract, not an
implementation, exception, speedup claim or certification of either test estate.
The mc test strategy (`canon/tasks/references/test-strategy.md`) and installed
test-writing guidance were read. No existing protection is retired.

## Scope and identities

- Audit worktree: `mc-tests/goals/timeout-enforcement-plan/memoro-cli`, initial
  HEAD `28be11e0ee87b11ee4035bc014d4eb8cf5d204f6`.
- Installed mc: `/opt/homebrew/bin/mc` resolves to
  `/Users/martinforsberg/mc/self/memoro-cli/src/mc-cli.js`, inspected HEAD
  `d16d73673b38149229c425af4687549e457e745a`.
- The eight inspected execution/configuration files listed below are byte-equal
  between these two CLI revisions. That is a current observation, not the
  identity of the executable that produced the historical review receipt.
- Read-only Memoro reference checkout: `/Users/martinforsberg/mc/self/memoro`,
  HEAD `db36845498f760040ad5e3a80f174fc8bd1a52c2`. No Memoro worktree was opened
  or modified for this goal. Historical Memoro objects were read directly from
  `/Users/martinforsberg/mc/repos/memoro.git`.
- Local runtime: `node --version` returned `v24.10.0`; executable
  `/opt/homebrew/Cellar/node/24.10.0/bin/node`. Other supported Node versions
  were not exercised. Do not extrapolate these semantics to all Node 22+.

Only one synthetic session execution and one candidate flag-resolution
experiment were performed. Neither used dependencies, credentials, services,
real merge operations or an estate/full-suite replay. Normal delivery uses the
existing dependency attachment and affected gate, separately from these probes.

## Historical evidence reconciled

Consumed proposal:
`/Users/martinforsberg/mc/programs/mc-tests/proposals/archive/2026-11-05-mc-session-timeout-flag-discrepancy.md`.
Its reviewed Memoro revision is `361479177375afd636724492f3d128c85e4da1b9`.
`git --git-dir /Users/martinforsberg/mc/repos/memoro.git show
361479177375afd636724492f3d128c85e4da1b9:.mc/test.json` confirms the loader
and `--test-timeout=1000`. The same revision's `docs/technical/testing.md:75–83`
says that both mc routes enforce it. Current Memoro has the same declaration
and wording. This establishes intent, not execution.

Let historical `H` be:
`/Users/martinforsberg/mc/runner/scratch/goal-mc-tests-port-scan-read-scheduling-20261105T075019Z`.
All the following retained files were present and read, including complete
request/result JSON and logs; absence was not substituted with inferred green:

| Run under H | Request/result/log evidence |
| --- | --- |
| `gate-20261105T075115Z-f28c856f-f042-4b4e-90ee-d6973b2abdb3.log` | Adjacent `.request.json`, `.request.json.result`, `.exit` all present. Named port test: 1 pass, callback 397.464333 ms, TAP process 549.462792 ms, exit 0. |
| `gate-20261105T075252Z-98c9e66e-26b8-4647-a9df-f56225f69555.log` | Same adjacent files present. Affected selection: 11 files, no deferred files, 63 passes/0 failures across 2 batches, `check:bsqlite-pin` completed exit 0. Port callback 503.873583 ms. |

Both requests and both results' `coverage.flags` contain exactly
`["--import","./tests/_helpers/browser-paths.mjs"]`, not the one-second flag.
Both specify a 900000 ms round ceiling. The affected durable receipt at
`/Users/martinforsberg/.memoro/mc/gate-evidence/98c9e66e-26b8-4647-a9df-f56225f69555.json`
was present and agrees: schema version 1, measurement version 3, `outcome=green`,
`exit=0`, complete affected coverage with those flags. Its base is
`215944d81ae80d6ad8549120ee64e423654d96c7`, measured tree
`0de70323a6846a7ad798e9545d76b2ad9f045739`, configuration digest
`b4aad3091f0e57e4e4f03cae74dd2cdcdd6cf4bb31a70f63ca287b20f9197aac`.

The affected log actually contains these passing callbacks:

- “every D1 call in src/ and tail-worker/ is in a repository, under a privileged
  root, or in the driver”: **3308.272292 ms**.
- “env.DB is read only in src/index.js and in the classes wrangler.toml
  declares”: **3315.982458 ms**.

Receipt `started=2026-11-05T07:52:52.763Z`,
`ended=2026-11-05T07:53:30.157Z`: **37.394 s** worker/measurement interval,
not summed callback or file cost. These are retained historical observations,
not fresh benchmarks. The receipt really was green for what it recorded; it
does **not** establish enforcement of the repository's one-second declaration.
Historical process argv, Node version, CLI revision and a contemporaneous
operator-table snapshot are not retained in those artifacts. Do not call a
source-derived argv reconstruction an observation of that historical process.

## Trace: session route

The eight byte-compared files are `src/mc/commands/gate.js`, `gate-fast.js`,
`repo-gate-table.js`, `gate-local.js`, `session-gate-run.js`, `repo-gate.js`,
`session-gate-evidence.js` and `gate-greens.js` (the latter seven under
`src/mc/`). Source references below are at the audited CLI HEAD.

1. `commands/gate.js:145–180` captures worktree content, obtains a declaration
   through `primaryCheckoutDeclaration`, then calls `declaredTestFlags`.
   `gate-fast.js:32–48` asks Git for the common directory and maps it through
   `repositoryDir`. `repos.js:62–69` removes a final `.git` directory, but
   deliberately keeps a **bare** `memoro.git` path as-is.
2. `declarationFor(repoPath)` reads **`repoPath/.mc/test.json`**, not the
   caller's measured worktree or a Git blob (`repo-gate-table.js:315–345,
   382–402`). Layers are shipped < repository < operator, merged by field.
   An array such as `pr_tests_flags` is replaced whole, not concatenated.
   `sources.pr_tests_flags` identifies only the winning layer.
3. The real layout has `/Users/martinforsberg/mc/repos/memoro.git` as the
   common directory. Its `.mc/test.json` is **absent**; the declaration in
   `/Users/martinforsberg/mc/self/memoro/.mc/test.json` is present but is not
   read by that call. This is one independent path to losing repository flags.
4. Independently, the currently read-only operator file
   `/Users/martinforsberg/.memoro/mc/repo-gates.json` explicitly sets Memoro's
   `pr_tests_flags` to just the browser-path import. It therefore replaces an
   own declaration even when an ordinary checkout supplies one. This is not
   the old whole-entry shallow-merge bug: current field-wise merging preserves
   unnamed fields, but deliberately replaces a named array. Removing only this
   stale field would **not** fix the bare-path omission; shipped Memoro flags
   also contain only the loader (`repo-gate-table.js:262`). No operator state
   was changed by this diagnosis. Current state explains reproducible mechanisms,
   not conclusively which historical layer supplied the reviewed request.
5. `commands/gate.js:173–174,219–223` serializes `effectiveFlags` into the
   request and hashes declaration + flags through `gateConfiguration`. If
   declaration resolution fails or produces no nonempty array,
   `declaredTestFlags` returns null. `gate-local.js:48–57` then salvages only
   imports/experimental flags from a direct `node --test` script; it discards
   `--test-timeout`. A wrapper script gives no flags. This fallback is another
   gap, not proof that it caused the historical omission.
6. `session-gate-run.js:127,158–177` copies request flags into coverage and
   passes them unchanged (plus an optional name filter) to `realTests`.
   Resource batches and lanes remain `realTests`' responsibility. Tests and
   the serial selected command sequence overlap and both must settle.
7. `repo-gate.js:2371–2405` prefers nonempty supplied flags. Otherwise its
   separate `nodeTestFlags` parser also strips **all `--test-*` options**
   (`2152–2171`). It appends `--test-timeout=600000` if no declared timeout,
   `--test-force-exit` if absent, concurrency if absent, then reporters,
   declared flags and file paths in the actual spawn. Thus a loader-only
   request does not mean “no timeout”: today's implementation resolves it to
   the **ten-minute default**, not 1000 ms. The old 300000 wording in
   `docs/technical/mc-merge.md:759–762` is stale relative to this source.
8. Result/receipt `coverage.flags` are the **input** flags, not effective child
   argv: synthesized timeout/concurrency/force-exit/reporters are absent.
   `gateReceipt` checks immutable content, nonzero completed passing test
   totals, commands and identity, but not intended-versus-executed timeout
   (`session-gate-evidence.js:83–106`). It can honestly record a completed green
   with the wrong policy. Missing/partial/aborted execution cannot mint green.

## Trace: ordinary candidate route (not the goal review landing door)

`commands/repo.js:282–341` resolves `repoPath`, passes it into `runGate` for
checks, or into `runMergeRound`; `repo-merge.js:181–183` calls the same gate
before landing. `runGate` reads `declarationFor(repoPath,{root,env})` at line
418 **before the candidate exists**. In a bare-repository layout the own file
is again absent. If called with a checkout instead, its own file participates,
then the operator's explicit array still wins. This conditional trace does not
assert which path every live merger job resolves.

After candidate creation/base merge/preparation, line 743 takes flags from that
earlier declaration. The selector runs in the candidate, but does not refresh
its test flags from the candidate's `.mc/test.json`. Selected tests receive
them at `1095–1097`; changed/added PR tests receive them at `1181–1196`, for
both a single PR and each member of a batch. Both use `realTests` and the
same default-adding argument assembly. Own tests still run after selection
reuse. External whole-suite commands use `realSuite`/their own runner instead;
no claim here that mc injects the same timeout into those commands.

`gate-greens.js` has configuration/flags-aware strict receipt lookup and
`checksHash`; `repo-gate.js:971–977` supplies the resolved input flags.
This is valuable existing protection, but matching the same wrong resolution
on both routes does not prove the promised timeout. Legacy unbound cache reuse
also exists (`findGreen`); enforcement changes must invalidate its old
measurement meaning, not merely rely on the strict branch.

No live candidate/forge/merge round was executed. The one resolution probe
below exercises the real declaration and argument builders, not `runGate`'s
entire workflow. Goal review's direct landing route is not ordinary candidate
verification and is not evidence of having run this route.

## Supported semantics and the two bounded experiments

Evidence root `S`:
`/Users/martinforsberg/mc/runner/scratch/goal-mc-tests-timeout-enforcement-plan-20261105T083718Z`.
Exact scripts, stdout/stderr, requests, results and receipt remain there. The
appendix provides the scripts; the manifest retains byte identities. **Do not
rerun the experiments during this goal**: its one-per-route allowance is spent.

Local `node --help` says:

```text
--test-timeout=...          specify test runner timeout
--test-force-exit           force test runner to exit upon completion
--test-concurrency=...      specify test runner concurrency
```

Help alone does not distinguish callbacks, file startup and hooks. Inspection
of this runtime's embedded `internal/test_runner/test` (timeout assignment at
614–621), `runner` (`FileTest` sets `timeout=null` at 214), and `utils`
(`--test-timeout` parsing at 219) was combined with actual execution below.
The exact local source extraction is retained in the evidence capsule.

### One real synthetic session

Executed from this CLI worktree, using its CLI, not the installed CLI:

```sh
MC_HOME="$MC_SCRATCH/session-home" MC_WORK_ROOT="$MC_SCRATCH/session-root" \
  node "$MC_SCRATCH/session-probe.mjs" > "$MC_SCRATCH/session-probe.out" 2>&1
```

The script creates one ordinary, non-bare synthetic Memoro repo, declares
`--import ./argv.mjs --test-timeout=1000`, then invokes one named-file gate
over four fixtures. The loader prints actual child `process.execArgv`.
The fixture's 30000 ms round ceiling is below the real 900000 ms ceiling;
no production limit/lanes were changed. Fixture commit
`614f0afa3811679c2ef74d98b3cfea68e929ba99`.

| Fixture | Actual result / clock |
| --- | --- |
| `slow.test.js`, asynchronous 1500 ms callback, no explicit timeout | Named `test timed out after 1000ms`, `testTimeoutFailure`, duration 1007.138709 ms. |
| `sum.test.js`, 650 ms module startup, two sequential 600 ms callbacks | Both pass: 602.608875 and 602.190458 ms. A file can exceed 1 s; startup is outside these callback clocks. |
| `hooks.test.js`, asynchronous 1500 ms `before`, empty callback | Red/cancelled `after slow hook`, `hookFailed`, “failed running before hook”, duration 971.728292 ms. This is not a named callback timeout diagnosis. |
| `explicit.test.js`, callback 1500 ms, explicit `{timeout:2000}` | **Pass**, 1503.591 ms despite CLI 1000. Node's flag is a default, not an unoverrideable one-second maximum. This deliberate synthetic override is not an authorized repository exception. |

Every loader record contains `--test-timeout=1000` and `--test-force-exit`.
No synthesized 600000 appears. Node's child argv repeats some runner options;
that is not two independently enforced limits. Request and receipt flags agree
with the intended input. Outcome is **red**, exit 1, 5 tests/3 passes/1 failure/
1 cancelled, completed TAP. `timed_tests=[]` because no fixture test changed
against its initial commit; raw TAP, not that filtered field, supplies clocks.

Run `89aa4ddd-71c7-497b-bfbc-db0e6ff2ad7b` artifacts:

- `S/gate-20261105T084052Z-89aa4ddd-71c7-497b-bfbc-db0e6ff2ad7b.log`, adjacent
  `.request.json`, `.request.json.result`, `.exit`.
- `S/session-home/gate-evidence/89aa4ddd-71c7-497b-bfbc-db0e6ff2ad7b.json`:
  `outcome=red`, `coverage.kind=named`, no commands, `stopped_at=null`.
- `S/session-root/runner/too-slow/memoro.tsv` retains `slow callback`, limit
  1000. It does **not** retain the failed hook as a timeout: the current reporter
  recognizes only `testTimeoutFailure`. Hook attribution/persistence remains a
  separate evidence gap, not permission to classify the hook green.

Clocks are separate: TAP process 3.893107291 s; receipt measurement interval
08:40:53.111Z–08:40:59.311Z = 6.200 s; gate answer reports 8 s;
outer CLI invocation wall 10.092227167 s. Fixture creation precedes that wall
timer and was not separately timed. `session-home/test-times/memoro.json`
contains 1.5/1.0/1.0/1.2 s for explicit/hooks/slow/sum. Those are rounded
top-level test durations aggregated by the reporter, **not measured process
startup-inclusive file walls**. Actual individual file walls/setup costs are
unavailable. Do not sum overlapping clocks or claim a speedup.

Negative result / safe next step: simply restoring the CLI flag cannot certify
an absolute callback cap, and hooks do not have the same diagnosis. Commission
the configuration/execution contract below; retain the explicit-timeout and
hook limitations. No second runtime experiment or wider scanner is authorized.

### One candidate flag-resolution experiment

```sh
MC_HOME="$MC_SCRATCH/candidate-home" MC_WORK_ROOT="$MC_SCRATCH/candidate-root" \
  node "$MC_SCRATCH/candidate-resolution-probe.mjs" \
  > "$MC_SCRATCH/candidate-resolution-probe.out" 2>&1
```

One script makes four small resolution cases. The candidate has its own
one-second declaration in **every** case. Actual `declarationFor`,
`declaredTestFlags` and `realTests` argument assembly run; only `spawn` is
replaced, capturing argv and emitting controlled TAP. No child test, selector,
forge or merge runs; the synthetic passing TAP is **not protection evidence**.

| Declaration path | Operator array | Winning source | Resolved Node timeout |
| --- | --- | --- | --- |
| Ordinary checkout with own file | absent | repository | 1000 |
| Bare path, no own file there | absent | shipped | 600000 |
| Ordinary checkout with own file | loader only | override | 600000 |
| Bare path, no own file there | loader only | override | 600000 |

In each case the session resolver returned that same declared input array.
All captured argv preserve the loader, two automatically resolved lanes and
force-exit. In the bare cases the candidate's own file is ignored. This
independently demonstrates both loss mechanisms and real default synthesis;
it does not measure candidate execution or receipt issuance. No callback,
file or round timing claim is made for this non-launching experiment.

## Existing protection: retain, extend narrowly

These are inspected assertions, **not tests rerun for this documentation**:

| Existing area | Protection and missing case |
| --- | --- |
| `tests/mc/repo-gate-table.test.js:34–89,438–450,531–560` | Field-wise precedence, null removal, retained unrelated fields and non-removable round ceiling. No measured-tree/bare-path or timeout-floor assertion. Preserve general precedence. |
| `tests/mc/gate-fast.test.js:80–89` | Reads primary declaration; empty/failed lookup falls back. It accepts a fake declaration and does not prove measured worktree policy is read. |
| `tests/mc/gate-command.test.js:133–140`; `gate-local.test.js:98–108` | Declared loader propagation, script import/experimental fallback and command display. No timeout preservation or invalid-declaration refusal assertion. |
| `tests/mc/session-gate-run.test.js:115–134,341–346` | Flags, resource batching/lanes/order and name filters cross the worker boundary. It does not resolve declarations itself. Preserve command overlap and completion tests. |
| `tests/mc/repo-gate.test.js:771–820,1136–1140,2861–2870` | Selected/own-test declared flags and a real 300 ms named hung-test cut with subsequent tests passing. Strong execution overlap; missing real configuration-to-receipt linkage. |
| `tests/mc/session-gate-evidence.test.js:168–306,380–435,525+`; `repo-gate.test.js` receipt-reuse cases | Immutable content, complete/nonempty execution, named/filtered/partial limits, configuration mismatch, legacy/missing/corrupt receipt rejection in strict mode. None records the synthesized timeout as an executed policy. Keep all these safeguards. |

No new framework, permanent wording tests, scanner, lane, Git-policy exception,
selector narrowing, threshold changes or protection retirement is recommended.

## Correction contract for a separately commissioned implementation

The following is executable acceptance to commission, **not work implemented or
fault replay performed here**. Keep Memoro's 1000 ms declaration, CLI's current
ratchet, all lane/resource-class membership, tracked-input membership,
conservative selection/fallback and whole-suite ownership. Do not replace a
real execution assertion with a mocked `tests` result. Use unit boundary
substitution only for configuration/argv decisions and external forge/Git
answers; no new claim about real merge/conflict semantics.

### A. Resolve policy from the tree actually measured; reject silent weakening

**Fault/consequence:** a bare/common directory or stale override hides
`.mc/test.json`; long tests pass and unattended decisions claim the wrong
policy. Existing overlap is the table/fast/command/candidate flag tests above.
Cheapest credible protection is tiny real file fixtures for layer resolution,
then existing injected command/candidate harnesses for propagation.

**Files:** `src/mc/repo-gate-table.js`, `gate-fast.js`, `commands/gate.js`,
`gate-local.js`, `repo-gate.js`; extend the existing tests of those modules.
Separate repository identity (e.g. `memoro`) from the **declaration content
directory**. Session timeout/flags must come from its measured worktree;
candidate timeout/flags from `headDir` after the base/derived candidate is final,
before **any** selected/previous-red/own test starts. Do not move early lane
reservation ceilings, preparation or other declarations later to achieve this.
Use an explicit identity, not the final path segment `candidate`, for shipped
and operator layers. Content changes during a session still invalidate evidence.

Retain ordinary field-wise precedence, but reconcile the repository's declared
timeout as a required maximum default: an explicit operator flag array that
removes it, sets 0/Infinity, duplicates it ambiguously or increases it must stop
with both source paths/values named, **before spawning tests**. Do not silently
union arbitrary loader arrays or silently rewrite the operator's file. Accept
valid equal/tighter timeout values; retain unrelated override fields/loaders.
Malformed present repository config must stop the session too, not fall through
to bare/script execution. Preserve a valid script timeout when no declaration
exists; unify the two parsers' timeout handling without treating file globs as
flags. These are proposed timeout-specific reconciliation rules, not a general
revocation of operator override authority.

**Exact checks after implementation:**

```sh
mc gate tests/mc/repo-gate-table.test.js tests/mc/gate-fast.test.js \
  tests/mc/gate-command.test.js tests/mc/gate-local.test.js
mc gate tests/mc/repo-gate.test.js --test-name-pattern 'declared flags|timeout policy'
```

Add named cases containing `timeout policy`: ordinary vs bare identity with
different primary/worktree/candidate declarations; unchanged unrelated fields;
stale override rejection; equal/tighter accepted; absent config script 1000
preserved; malformed config refuses without spawn. Candidate harness must assert
**selected and own** test options use final candidate 1000 even when the source
repo says loader-only, and previous-red execution cannot precede reconciliation.
Assertions compare complete flag members/source directories and no-spawn state,
not just a timeout substring or test count.

**Fault-sensitive acceptance:** in an exact-head disposable scratch replay,
change only the declaration content directory back to common/bare (guard exact
source match). The new measured-tree assertion must fail with expected 1000
versus actual missing/default, not setup failure. Independently restore whole
array override acceptance: the stale-override `ok=false`/no-spawn assertion must
fail. Independently restore timeout-dropping script parsing: its exact flag
assertion must fail. Restore each source and repeat the corresponding commands
to complete green. Record patch, assertions and clocks, not inferred protection.

**Resources/gaps:** Git/Node, scratch fixtures and normal dependency attachment;
no network, real candidate merge or suite. Existing real-Git enforcement and
exceptions remain unchanged. Operational removal of only Memoro's stale
`pr_tests_flags`/associated explanation needs an explicitly authorized operator
edit, saved before/after evidence and re-resolution; do not touch other fields.
That edit alone is not the code fix, and is not authorized by this report.

### B. Make the receipt describe the executed timeout, not just requested flags

**Fault/consequence:** default synthesis or execution divergence is invisible
in a green receipt; same wrong policy can match reuse. Existing overlap is
worker propagation, real hung-test execution, and immutable/full receipt checks.
Cheapest credible protection: extend their direct decision cases and the
existing one tiny real child test, not a second integration suite.

**Files:** `src/mc/repo-gate.js`, `session-gate-run.js`,
`session-gate-evidence.js`, `gate-greens.js`; extend
`tests/mc/repo-gate.test.js`, `session-gate-run.test.js`,
`session-gate-evidence.test.js`. Resolve semantic execution flags once, before
both configuration hashing and spawn. Retain requested flags separately; add
per-batch executed Node identity/argv, effective timeout/default provenance and
the actual lane/resource class. Stable reuse identity must include resolved
timeout policy, not ephemeral reporter destination paths. A child/receipt
timeout mismatch is invalid/incomplete, never reusable green. Bump measurement
meaning/version so old bound **and legacy unbound** greens cannot skip work.
Missing execution evidence must not be retroactively invented for old receipts.

**Exact checks after implementation:**

```sh
mc gate tests/mc/session-gate-run.test.js tests/mc/session-gate-evidence.test.js
mc gate tests/mc/repo-gate.test.js --test-name-pattern 'timeout policy|a test that never ends|receipt'
mc gate
```

Extend the existing real `a test that never ends` fixture rather than launching
a real one-second sleep inside a timed unit callback. Use its existing 300 ms
synthetic timeout (never alter Memoro's 1000): real configuration -> request ->
worker -> child -> receipt. A hanging asynchronous callback must be red by name
with `testTimeoutFailure`/300 ms, subsequent quick tests pass, process closes
without the round ceiling, receipt red/nonreusable with matching effective
timeout and actual argv. This is an intentionally faulty child inside a passing
protection test, not an expected-green gate over hung code. In the restored
quick-child case, require complete passing totals/commands, green receipt and
recorded timeout, no skipped/deferred/missing evidence; named coverage must
still never authorize affected reuse. Preserve command overlap, classes/lanes,
unknown exit, no-test, interruption and content-change refusal assertions.

For decision-only receipt fixtures, assert independently that missing executed
timeout, a requested 1000/executed 600000 mismatch, older measurement version,
and differing timeout with equal files all refuse reusable green. Existing
strict publication/reuse assertions must still pass. Test actual argument
assembly too: timeout precedes paths and the loader/force-exit remain present.

**Fault-sensitive acceptance:** bounded guarded scratch faults (one at a time):
drop the effective timeout at the spawn boundary while leaving the receipt
claim intact; the execution/receipt comparison must fail. Restore the old
receipt validator/version acceptance; missing/mismatched/legacy rejection
assertions must fail. Do not wait ten minutes to prove the first fault: capture
actual argv, or use a sub-second outer bound in the existing real-child case
and assert failure is missing named timeout, not a generic harness hang. Restore
source and rerun each exact focused command, then complete affected `mc gate`.

**Resources/cost:** one isolated short child in the existing approved area,
real temporary Git only where existing receipt identity requires it, Node and
normal attached dependencies. Record callback durations, setup/startup-inclusive
file walls and affected-round wall separately, including first fixture consumer.
No callback over 1 s may be declared compliant by moving work into a hook.
No implementation timing saving or restored-green fault proof exists yet.

### Meaning that documentation must preserve

Update `docs/technical/mc-merge.md` with the implemented default/provenance and
separate clocks, not the stale 300000 value. In the follow-up Memoro worktree,
correct `docs/technical/testing.md:75–83` to describe **Node's default** for
tests and applicable hooks, not an absolute file or unoverrideable callback cap.
Leave `.mc/test.json` at 1000. This wording follows the same A/B behavioural
acceptance; no new wording test is justified.

An explicit test-local timeout can exceed that default, synchronous CPU work
cannot be preempted by a blocked JavaScript timer, module startup/file wall is
not a callback clock, and round cancellation is a different safety bound.
This report does not commission a repository-wide explicit-timeout scanner or
new cap-enforcement framework. Planning must separately decide any stronger
absolute-cap implementation and hook-specific diagnostic/persistence work; until
then those gaps remain explicit. Do not claim them solved by shipping A/B.

## Delivery checks and limitations

Only this report is commissioned in this repository. No tests, limits, selectors,
input lists or runtime code changed. Delivery evidence is recorded separately
below/with the goal log and PR after running the affected gate. The intentional
synthetic red is successful diagnosis, **not** delivery verification green.

`origin/main` advanced independently after branch creation. Compare
`git diff origin/main` as requested, but distinguish upstream-only differences
from this branch's `git diff origin/main...HEAD`. Never merge moving main just
to hide those differences. No historical round, full suite, live service,
candidate merge, absolute-cap certification or unmeasured cost is claimed.

## Appendix: exact bounded probe scripts

These are retained scratch artifacts, not installed test protection.

### `session-probe.mjs`

```js
import { mkdirSync, writeFileSync } from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';
import { join } from 'node:path';
const source = process.cwd();
const root = join(process.env.MC_SCRATCH, 'session-probe');
const cwd = join(root, 'memoro');
mkdirSync(cwd, {recursive:true});
const write = (p, v) => { mkdirSync(join(cwd, p, '..'), {recursive:true}); writeFileSync(join(cwd,p), v); };
write('package.json', JSON.stringify({type:'module'}));
write('argv.mjs', "console.log('ACTUAL_ARGV ' + JSON.stringify(process.execArgv));\n");
const prefix = "import { test, before } from 'node:test'; const wait = ms => new Promise(r => setTimeout(r, ms));\n";
write('slow.test.js', prefix + "test('slow callback', async () => { await wait(1500); });\n");
write('sum.test.js', prefix + "await wait(650); test('sum first', async () => { await wait(600); }); test('sum second', async () => { await wait(600); });\n");
write('hooks.test.js', prefix + "before(async () => { await wait(1500); }); test('after slow hook', () => {});\n");
write('explicit.test.js', prefix + "test('explicit callback', {timeout:2000}, async () => { await wait(1500); });\n");
const files = ['slow.test.js','sum.test.js','hooks.test.js','explicit.test.js'];
write('select.mjs', `console.log(JSON.stringify(${JSON.stringify({files,commands:[]})}));\n`);
write('.mc/test.json', JSON.stringify({pr_tests_flags:['--import','./argv.mjs','--test-timeout=1000'],select:'node select.mjs',session_whole:true,round_timeout_ms:30000,round_timeout_why:'bounded synthetic fixture, below production ceiling'}));
const git = (...args) => execFileSync('git', args, {cwd,encoding:'utf8'}).trim();
git('init','-q','-b','main');git('config','user.name','Timeout Probe');git('config','user.email','probe@example.invalid');git('add','.');git('commit','-qm','Synthetic timeout fixture');git('update-ref','refs/remotes/origin/main','HEAD');
console.log('FIXTURE_REVISION '+git('rev-parse','HEAD'));
const start=performance.now();
const ran=spawnSync(process.execPath,[join(source,'src/mc-cli.js'),'gate',...files,'--json'],{cwd,env:process.env,encoding:'utf8',timeout:45000});
console.log(ran.stdout);console.error(ran.stderr);console.log(JSON.stringify({status:ran.status,error:ran.error?.message,wall_ms:performance.now()-start}));
if (ran.status !== 1) process.exitCode=1;
```

### `candidate-resolution-probe.mjs`

```js
import cp from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { EventEmitter } from 'node:events';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
const source=process.cwd(), dir=join(process.env.MC_SCRATCH,'candidate-probe');
const primary=join(dir,'memoro'), bare=join(dir,'memoro.git'), candidate=join(dir,'candidate');
for(const p of [primary,bare,candidate,process.env.MC_HOME]) mkdirSync(p,{recursive:true});
const own=['--import','./loader.mjs','--test-timeout=1000'];
for(const p of [primary,candidate]) { mkdirSync(join(p,'.mc'),{recursive:true}); writeFileSync(join(p,'.mc/test.json'),JSON.stringify({pr_tests_flags:own})); }
const captures=[];
cp.spawn=(file,args,options)=>{
 captures.push({file,args,cwd:options.cwd});
 const child=new EventEmitter();child.stdout=new EventEmitter();child.stderr=new EventEmitter();
 child.stdout.setEncoding=child.stderr.setEncoding=()=>{};
 queueMicrotask(()=>{child.stdout.emit('data','TAP version 13\n1..1\n# tests 1\n# pass 1\n# fail 0\n');child.emit('close',0);});
 return child;
};
syncBuiltinESMExports();
const load=p=>import(pathToFileURL(join(source,p)));
const {declarationFor}=await load('src/mc/repo-gate-table.js');
const {realTests}=await load('src/mc/repo-gate.js');
const {declaredTestFlags}=await load('src/mc/gate-fast.js');
const override=join(process.env.MC_HOME,'repo-gates.json');
for(const stale of [false,true]){
 if(stale) writeFileSync(override,JSON.stringify({memoro:{pr_tests_flags:['--import','./loader.mjs']}}));
 else rmSync(override,{force:true});
 for(const repoPath of [primary,bare]){
  const d=declarationFor(repoPath,{root:process.env.MC_HOME,env:process.env});
  const session=declaredTestFlags({git:()=>repoPath.endsWith('.git')?repoPath:join(repoPath,'.git'),declaration:(p)=>declarationFor(p,{root:process.env.MC_HOME,env:process.env})},{root:candidate,env:process.env});
  await realTests({cwd:candidate,files:['only.test.js'],flags:d.declaration.pr_tests_flags,env:process.env,timeoutMs:1000});
  console.log(JSON.stringify({stale,topology:repoPath===bare?'bare':'checkout',source:d.sources.pr_tests_flags,declared:d.declaration.pr_tests_flags,sessionFlags:session,actualArgumentAssembly:captures.pop()}));
 }
}
console.log('NO CHILD, SELECTOR, GIT MERGE, FORGE OR REAL TEST WAS RUN; spawn boundary captured argument assembly only.');
```

### Evidence integrity

`S/evidence.sha256` retains the capsule manifest. Primary artifact SHA-256:

```text
1f6c3f15a838c307dc1d249dbb7d654ef67f10786532ca528952ce382d8c2df5  session-probe.mjs
7121778b5962e69c988c4dd981d78544ee6214e75c2ae3f5647bdb8baf9a650e  session-probe.out
b396cdff36502b7008d4d9dacb9612af372dc6bbfa926444b9fd56c1cb01422f  candidate-resolution-probe.mjs
a9d44f5f8a88d97e754f1c6eb55f9572de174fc7aac7312453ae34a66e2c4cf9  candidate-resolution-probe.out
df3cd17567951fe083246cc8304b668102783ea79ffc11ba43e293d3e3ae7f7e  inspection-metadata.json
5e00e2334824ca0899293aec9a6f9fef8fcc60d901ccd60a4fcd8c6422cf2504  local-node-timeout-source.out
```

`inspection-commands.out`, `memoro-topology.out`, `historical-config.out`,
`historical-testing.out` and `local-node-timeout-source.out` retain inspection
commands/output; `historical/` retains the named historical logs, requests,
results, exits and affected receipt. None is a new execution of historical tests.
