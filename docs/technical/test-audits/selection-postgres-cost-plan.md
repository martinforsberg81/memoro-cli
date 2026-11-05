# Selector and PostgreSQL cost: CLI invocation and clocks

2026-11-05. **Documentation-only diagnosis and bounded future contracts.**
The [Memoro report](https://github.com/martinforsberg81/memoro/blob/goal/selection-postgres-cost-plan/docs/technical/test-audits/selection-postgres-cost-plan.md)
owns `selection.mjs`, `import-graph.mjs`, `selection-cache.mjs`, the one
cold/warm list pair, its exact full output, and PostgreSQL phase diagnosis and
real-DB acceptance (S1/P1). This report owns CLI invocation, selection consumption,
receipts and overlapping clocks (C1). Neither changes or certifies protection.

## Exact revisions and evidence limits

`git rev-parse HEAD` at inspection, in the two goal worktrees:

```text
memoro     6218994d4bc74b9118741c3aef5733c79ce512dc
memoro-cli b68fb4eb1e8d719b3c80f4b92952731992016770
```

No source/test/config/threshold/lane/input membership or conservative fallback
was changed. Delivery commits are document-only descendants and are recorded
with final gate receipts in the goal log. The mc test strategy and writing-tests,
publication and scratch/probe guidance were read before contract design. Existing
real-Git enforcement/exception policy is unchanged; no new scanner or framework.

**Historical user observations:** selection 89 s and PostgreSQL 257 s came
without matching exact command, revision or receipt. They are not our timings.
They overlap other clocks and must not be summed into 346 s, subtracted from
round time, or used to predict a saving. No historical full-round replay,
selected-suite execution for the selector probe, Docker/image/container run or
SQL run was made. The earlier Memoro study diagnosis describes other interrupted
rounds and missing historical reasons, not a reconstruction of these observations.

Only one list-only pair was executed, in Memoro, at the pinned HEAD with explicit
fixture `scripts/testing/selection-cache.mjs`. Cold whole-child wall 76.771264 s,
warm 11.460956 s, both exit 0, stderr empty; full JSON bytes equal (21 file paths,
21 reason entries, three complete command descriptors). The companion embeds
that exact JSON, commands, load/dependency setup, hashes and cache isolation.
This is a current fixture observation, not a controlled implementation speedup
or the historical 89 s. There was no CLI selector benchmark and no per-component
phase measurement. No callback, test-file or affected-round timing is inferred
from this list pair.

Retained evidence root `$E`:

```text
/Users/martinforsberg/mc/runner/scratch/goal-mc-tests-selection-postgres-cost-plan-20261105T090118Z
```

`selector-pair/probe.cjs`, `metadata.json`, `result.txt`, both stdout JSONs and
empty stderr files retain the exact commands/output; both stdout SHA-256 values
are `9cce1fa4647be2888079200440bd0f51148604c01bb3e363f8c4146531edf3d2`.
A bounded `mc log --repo memoro --verb gate --limit 3 --json` returned `[]`.
A separate five-invocation snapshot (`recent-mc-log.json`) contained repo/who,
not the SQL observation. Missing matching historical logs remain a gap, not
proof of no execution. Safe next step: retain the next authorised invocation's
full selection and phase ledger, not another historical/full-suite campaign.

## Invocation and selection consumption

Inspected `src/mc/{commands/gate,session-gate-run,repo-gate,repo-gate-table,
gate-greens,session-gate-evidence}.js`, `scripts/affected-tests.js`, and relevant
existing tests at the pinned CLI revision. Memoro's printed JSON is richer than
what CLI carries through today.

### Session route

1. `commands/gate.js` obtains the frozen base and branch/tree changes and uses
   `selectorCommand` (`session-gate-run.js:19–24`) to remove the old `--base-ref`,
   shell-quote the new base and append every explicit changed path. This includes
   working/untracked changes and rename sides as collected by the gate. Named
   tests also ask selection for classes but intentionally retain only the asked
   files and **do not** run the affected command list. A focused green is not an
   affected green.
2. Memoro's declared command is `node scripts/testing/ci.mjs --list --json
   --base-ref origin/main`; CLI's is `node scripts/affected-tests.js --base-ref
   origin/main`. `repo-gate.js:1410–1475` executes the command, refuses nonzero,
   non-JSON, missing `files` array, malformed `commands` or nameless command
   entries. Absent commands is valid (CLI's selector returns none). It stringifies
   file entries and removes declared main-only files **unless that removes all**.
3. Memoro explicit paths mean no merge base for its impact analyser, even when
   `--base-ref` is a SHA: path-prefix fallback remains. PostgreSQL has its own
   path-only binding, so this is not evidence that every source diff runs PG.
   The probe selected SQL budgets, validators and better-sqlite pin, **not PG**.
4. `selectFiles` normalises command fields: `id`, `packageScript`, `passBaseRef`,
   `resourceClass`, `selectedBy`, declared unavailable exit code and `needs`.
   It returns files, classes, `full`, `why` and selection hash, **not Memoro's
   `selectedBy`, `selectedBindings`, `impacts` or `deferred` maps**. CLI's own
   selector does embed its reasons under `why.selected_by`, so those survive this
   return, but are not a universal Memoro reason ledger. `selectionHash` compares
   sorted files and script/base booleans only, not reasons/classes/all descriptor
   fields. `checksHash`/`commandIdentity` add flags, unavailable code and needs
   for bound receipt reuse; neither replaces retaining raw output.
5. `executeSessionGate` unions added tests, validates test paths remain inside
   the worktree, and optionally cost-defers files using the existing cost table.
   `coverage.kind` is named, partial or affected; pattern/flags are kept. Goal
   whole-selection requests must not be treated as complete if files are deferred.
   Zero files and zero commands stops `no-checks`, not a green measurement.
6. `session-gate-run.js` starts tests and the **serial** selected command sequence
   together (`Promise.all`), awaiting both for the verdict. It shell-quotes script
   and optional frozen base, clears inherited test context, preserves test
   resource batching and declares command progress pending/running/completed.
   It does not implement Memoro `ci.mjs` command-class scheduling or the candidate
   route's Docker lease preflight: session commands go directly to the shell.
   A command marked heavy retains that descriptor; this loop does not delay it
   until all tests finish. Do not quietly change this concurrency to claim a
   saving. Existing overlap/abort/receipt tests protect the current design.
7. Whole-round timeout tracks active selection/tests/command phases, finished
   file reports and pending/running commands. Cut/interrupted work never supplies
   complete-green evidence. This report does not alter timeout configuration;
   the separately commissioned timeout-enforcement diagnosis owns that question.

### Candidate route

`repo-gate.js` runs selection in the candidate, records selection in a timed
phase, and may use exact-tree bound evidence or conservative delta reuse. An
uncertain delta falls back to measuring the whole selection. `main_only`,
PR-specific tests and receipt reuse remain separate obligations, not optional
cost savings. `report.selection.selected` retains file membership; counts/hash
and `why` still do not retain Memoro's whole reason map or raw binding details.

`repo-gate.js:1043–1118,1598–1681` runs the selected tests and serial command
sequence beside one another using `Promise.allSettled`, waiting for both. Commands
carry frozen-base arguments and clear `NODE_TEST_CONTEXT`. For `needs: ['docker']`
the candidate route times runtime ensure/lease separately, adds holder/run/repo
labels to the command environment and releases the lease afterward. The command
wall timer starts **after** runtime ensure; zero command duration on failed
ensure is not zero Docker cost or successful SQL. A command after an earlier
failed command is still attempted. No higher command fanout is proposed.

### CLI selector's own enumeration/fallback is distinct

`scripts/affected-tests.js:94–158,199–372` enumerates `git ls-files -z`, computes
changed paths or accepts explicit ones, and scans tracked modules' import/path/
directory literals. Invocation-local import parsing is cached only in a Map;
there is no Memoro persistent parse cache here. Relative imports resolve existing
files via base/`.js`/`index.js`; cycles terminate. Text/data reach includes current
tracked and changed names, so a deleted literal can still have a reader. Tree
walk dependencies attach to the scanner itself, not every importer of a path
builder. Reasons keep `changed-test-file`, `imports:`, `pins:`, `reads:` (up to
three hit paths per category, existing behaviour), or the `full-suite` reason
with unexplained paths.

Unexplained manifest/lockfile/config/tooling paths select the entire tracked test
list. Unread data is not assumed inert; named data and directory readers retain
reach. A committed deleted source under src/tests/scripts is conservatively
full-suite even for extensionless transitive imports; existing direct/transitive
fixtures assert exact membership and `why.unexplained`. **Unstaged deletion is
not established by those fixtures:** `gone` requires both absence from tracked
set and absence on disk. A tracked but missing source can therefore evade that
particular full fallback while existing-file import resolution loses the edge.
The programme already preserves unstaged-deletion protection as an unresolved
follow-up. Do not claim it solved or change it under this document-only goal.
Dirty content is reread every invocation; no persistent blob hit can rescue a
missing import. Memoro's deleted-source bookkeeping/refusal is different; neither
implementation's cold/dirty/deleted/config outcome may be silently replaced by
an optimised cache or shared-snapshot implementation.

## Clock and receipt reconciliation

| Clock/evidence | Boundary and overlap | What it cannot establish |
| --- | --- | --- |
| User selection 89 s | Historical, provenance/route not supplied | Parsing time, exact membership, cache state or current baseline |
| Current selector pair 76.771 / 11.461 s | Spawn→exit of list child; registry/graphs/cache/output included | Individual phase cost, callback time, affected-green or optimisation saving |
| Candidate `timings.selection` (milliseconds) | Selector shell invocation including its child work | Memoro parsing-only cost; session phase timing not persisted equivalently |
| Candidate Docker timing | Runtime ensure before command timer | Image/SQL/container time |
| Candidate command `duration_ms` | Launch command→return (includes runner's image/start/SQL/cleanup); tests overlap it | SQL-only duration; sum with suite wall as round time |
| `gates_beside_suite_ms` | Encloses simultaneous suite and serial command sequence | Sum of child durations or a decomposition of round overhead |
| Memoro `ci.mjs` execution report | `selectionMs` starts after registry/dependency/impact await; standard commands overlap standard tests (cap 2), exclusive commands later | Same clock/route as mc's list-driven execution |
| User PG 257 s | Unknown exact script/flags; overlaps other clocks | Separate image, launch, init, schema, family/behaviour SQL, plans or cleanup costs |
| Node callback duration | Callback only; setup/import can precede it; nested tests can overlap | Finished-file wall or aggregate round attribution |
| Finished-file reporter | File process with import/setup/callback/teardown; files can overlap | Callback-only cost or additive round budget |
| Receipt started→ended | Around snapshots plus execution and final evidence work; command caller may add wait/setup | Sum of recorded phases, or test execution time alone |

`session-gate-evidence.js:83–106` requires unchanged captured content, a valid
bound run/base, coverage, passing completed test totals (when files exist), and
one **exit-0 successful** execution per selected command for green. A local
runner may call declared exit 69 non-red, but such a session command does not
satisfy the receipt's exit-0 completeness condition. Candidate selected-command
reporting explicitly distinguishes unavailable/ran=false. Neither route's local
unavailable result proves real PostgreSQL passed. A named/partial receipt is
not complete affected evidence. Configuration/flags/content binding and full
coverage checks remain authoritative; do not loosen them for timing convenience.

Current historical evidence does not allocate the 257 s: Memoro's source has
only the readiness message inside launch/schema/family/behaviour/cleanup work.
There is no separately supplied image digest or phase log. The companion phase
table explicitly leaves all missing attribution unknown. No new container was
started to fill these gaps. No callback, file or round cost was moved outside
its timer by this report.

## C1 — retain exact selection and non-additive phase evidence

**Implement only after commissioning; no claim of protection added here.**

- **Fault and consequence:** a reason/class/command descriptor disappears while
  file/script totals stay constant; a later audit mistakes partial/unavailable
  execution for green or attributes overlapping test time to PostgreSQL. Current
  raw JSON is parsed then largely discarded. The probe's full byte equality is
  stronger than the current legacy selection hash, but covers only one fixture.
- **Existing protection/overlap:** `tests/mc/repo-gate.test.js` covers unreadable
  selection, command omission/refusal, unavailable, Docker leasing, selected
  command order, overlap and candidate reuse; `session-gate-run.test.js` covers
  serial overlap, path quoting, additions, abort and timeout progress;
  `session-gate-evidence.test.js` protects complete-green and content binding.
  `affected-tests.test.js` covers existing data/import and committed-delete
  fallback. Retain all, including current Git enforcement and exception policy.
  Do not add permanent wording tests or duplicate real DB acceptance in CLI.
- **Bounded implementation:** change `src/mc/repo-gate.js` selection consumption
  to optionally persist validated raw JSON to a run-local versioned sidecar with
  SHA-256 and source command/base/cwd/content identity. Keep original files,
  `selectedBy`, bindings/matchedBy, impacts, deferred, resource classes and every
  command field exactly; also retain the separate normalised execution plan,
  main-only exclusions and added/deferred files. Preserve the existing returned
  selection and hash/reuse semantics. Sidecars must be atomic and never silently
  overwrite another run. A persistence error is an explicit evidence gap, not
  invented reasons or permission to skip selection. Do not collect environment
  dumps, credentials, SQL data or external service output.
- **Clock implementation:** in `src/mc/session-gate-run.js`, record monotonic
  start/end plus wall timestamps for selection, tests, each serial command and
  overall execution, tied to that sidecar. In `repo-gate.js`, retain existing
  Docker and command/suite clocks and identify their overlapping intervals.
  Keep receipt validation in `session-gate-evidence.js` strict; add optional
  references without treating a sidecar as executed-check evidence. Include
  pre/post fingerprint/caller overhead separately when available, otherwise mark
  unknown. Do not relocate work or increase concurrency/limits to improve clocks.
- **Cheapest credible level:** extend the three existing CLI gate test files
  with a small injected selector JSON/process-I/O boundary and deterministic
  clocks. Invoke the **real** `selectFiles`, session execution and receipt
  functions; fake only child output/time, not the mechanisms being asserted.
  Exact fixture must include at least two different reasons for one file,
  binding reason, a deferred member, class, a pass-base command and a declared
  Docker/unavailable command. Assert full raw deep equality separately from
  normalisation and the unchanged execution order/verdict/receipt outcome.
- **Fault-sensitive proof and commands:** `mc gate tests/mc/repo-gate.test.js
  tests/mc/session-gate-run.test.js tests/mc/session-gate-evidence.test.js`, then
  complete affected `mc gate`. In disposable exact-head replay, deliberately
  strip only `selectedBy` or change only `needs` from the persisted raw fixture:
  full sidecar equality must fail although file/script counts match. Restore
  for pass. Deliberately make round time the **sum** of overlapping test and
  command intervals: deterministic interval assertion must fail; restored
  enclosure with simultaneous starts must pass. Supply exit 69 for the PG
  descriptor: expect unavailable/not SQL pass and a non-green complete receipt;
  drop a pending command and require completeness rejection. These are expected
  assertions, not executed proof in this audit.
- **Resources, cost and gaps:** Node, normal attached CLI deps, isolated
  `MC_HOME`/`MC_WORK_ROOT` for direct mc-code probes and scratch sidecars, no DB,
  daemon or credentials. Measure new callbacks plus sidecar serialization/file
  startup and affected round including setup; no threshold changes. This supplies
  missing attribution, **not an immediate runtime saving**. Timestamp/sidecar
  overhead and actual command phases are unmeasured. If output persistence or
  clock evidence is partial, report it and retain existing selection/receipt
  obligations; do not call the result an attribution success.

## Ownership and next decisions

1. C1 first: retain exact output and route/interval ledger; no selection narrowing.
2. Memoro S1 only after phase evidence supports repeated enumeration as worthwhile:
   share graph invocation input, never a persisted final plan or narrower input.
   Its existing cold/warm/dirty/parser checks and exact full-plan comparison must
   fail on deliberate stale-snapshot faults and pass restored. No retirement.
3. Memoro P1: preserve fresh real PostgreSQL and instrument runtime/image/launch/
   readiness/core/family/behaviour/teardown. Real acceptance later uses
   `npm run sql:reference:postgres` on an authorised preprovisioned isolated
   database, the transaction-local-context fault (`true`→`false`) causing the
   actual `account context survived commit` exception, and restored pass with
   complete cleanup. The companion gives exact paths, proposed output command,
   prerequisites and negative-result procedure. Cheap CLI mocks prove only
   invocation and receipt decisions, never SQL equivalence.

Missing historical phase evidence does not block this diagnosis. It **does**
block a claimed PostgreSQL saving or decision to reuse/drop database work.
Inventory/deletion/invalidation risks remain explicit planning inputs, not
silently broadened implementation in a cost report. None of these contracts
changes the existing selected files, reasons, command bindings, thresholds,
resource lanes, tracked-input membership, policy exceptions or production.
