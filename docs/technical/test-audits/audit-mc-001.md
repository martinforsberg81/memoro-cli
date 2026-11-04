# Opening mc command and billing batch: audit-mc-001

2026-11-04. All twelve subjects and their cited mechanisms were examined at
`1d3d736dc6e5b615d18287bdfb9ae9a772330bf3` (the common **examined revision**
for every decision below). This applies the approved installed
`/Users/martinforsberg/.agents/skills/mc/tasks/references/test-strategy.md`,
with repository source at [test-strategy.md](../../../canon/tasks/references/test-strategy.md),
and reads [first-batch.md](first-batch.md) as historical evidence, not a new run.

Only the twelve exact paths in [CLI-tests-mc-001](migration-map.md#cli-tests-mc-001--testsmc--12-subjects)
are decision subjects. The batch is selection, archive, ASC, waiting, billing
and shared readers, **not** canon/role guidance delivery despite the map's
sequencing rationale. Other tests below were inspected as complementary evidence,
not audited or newly certified. Recommendations authorise no implementation,
retirement, selection change or residual-risk acceptance. No deliberate source
mutation, provider call, browser run or whole-estate campaign was performed.

## Execution, setup and evidence boundary

The commissioned focused command ran **once**, before documentary edits:

```sh
mc gate tests/mc/affected-tests.test.js tests/mc/archive-plan.test.js tests/mc/archive-programme.test.js tests/mc/asc-build-device.test.js tests/mc/asc-build-testflight.test.js tests/mc/asc-build.test.js tests/mc/asc.test.js tests/mc/await-deploy.test.js tests/mc/billing-gateway-session.test.js tests/mc/billing-gateway.test.js tests/mc/billing.test.js tests/mc/brief-collect.test.js
```

**GREEN: 162 tests, 25 suites, 0 failed/cancelled/skipped/todo; gate wall 6 s**
(the gate's rounded elapsed result). Selected Node round, including file loading,
preload, fixtures, callbacks and process exit: **4854.453458 ms** from TAP.
Exact log:
`/Users/martinforsberg/mc/runner/scratch/goal-mc-tests-audit-mc-001-20261104T173259Z/gate-20261104T173335Z-740be916-b7bb-47f4-a816-d31ab08c97f2.log`.
No prerequisite failure or timeout occurred in this round. These are one-machine
observations, not future budgets or an estate pass. Publication's affected gate
is recorded separately in the goal log and PR; a documentary green does not
certify these subjects.

All callback times are transcribed in the appendix. Summary (milliseconds):

| Subject basename (`tests/mc/`) | Callbacks | Sum of leaf callbacks | Maximum callback |
| --- | ---: | ---: | ---: |
| affected-tests.test.js | 15 | 176.102626 | 115.576958 |
| archive-plan.test.js | 13 | 13.715791 | 9.459375 |
| archive-programme.test.js | 16 | 40.482668 | 13.764333 |
| asc-build-device.test.js | 26 | 130.156336 | 56.084750 |
| asc-build-testflight.test.js | 28 | 1943.635499 | 249.890250 |
| asc-build.test.js | 15 | 59.692540 | 7.518458 |
| asc.test.js | 13 | 6.582416 | 1.195000 |
| await-deploy.test.js | 3 | 6.587042 | 4.537125 |
| billing-gateway-session.test.js | 4 | 601.429667 | 547.865459 |
| billing-gateway.test.js | 12 | 109.256127 | 29.306083 |
| billing.test.js | 13 | 9.148292 | 2.441083 |
| brief-collect.test.js | 4 | 1.722458 | 1.310208 |

**Attribution limits:** leaf sums are not file process durations; suite durations
include their children and must not be added again. Independent file startup,
setup phases and cleanup were **not separately measured**. The 4854.453458 ms
round includes them, but subtraction of leaf sums cannot isolate startup:
concurrency, runner scheduling and reporting also contribute. Parent interpreter
bootstrap before the TAP clock is not separately instrumented; the rounded gate
wall result is the broader elapsed observation. No per-file startup saving is claimed. No callback exceeded one second here.

### Shared fixture mechanism actually used

[tests/_isolate-home.mjs](../../../tests/_isolate-home.mjs) creates a per-process
temporary root, HOME with Git identity, conditional MC_HOME/MC_WORK_ROOT, removes
session identity variables and deletes its temporary root on exit. It writes and
warms a Git PATH shim with an unlogged `--version` call before callbacks. These
startup/cleanup costs are included in the Node round, individually unmeasured.
This is not proof of OS sandboxing or total absence of host capabilities.

[tests/_fake-git-default.mjs](../../../tests/_fake-git-default.mjs) patches
child_process and installs [FakeGit](../../../tests/mc/_helpers/fake-git.js)
through `useGitRunner`. Non-Git children get a model snapshot/preload and reload
on return; this is real serialization/process cost, not just an in-memory call.
The model implements index lists, file reads/writes, refs, ancestry and worktree
operations; e.g. `cmd_grep` searches tracked working files, `cmd_ls_files` uses
its index, and `cmd_diff` compares model trees. Its three-dot diff is not a proof
of real Git merge-base semantics. Modeled cleanup can remove real fixture files,
but does not prove Git's worktree safety checks, merges, conflicts or leases.

Of these twelve, **only asc-build-testflight.test.js is in the current
[real-Git exception list](../../../tests/_real-git-files.mjs)**. The log reports
**133 instrumented Git calls in that file**; the preload warm-up is not included
in that count. Other apparent `git init/commit/clone` fixtures use the model.
[Fake-default tests](../../../tests/mc/fake-git-default.test.js) inspect the
patching, child sharing and off-list real-Git rejection, not model/real semantic
equivalence. Neither policy nor exception membership changes here; reconciliation
of real-Git evidence with the zero-call policy remains Martin's decision.

## Decisions

For every entry: the common revision above applies; setup costs refer to the
round/table/appendix above unless separately labelled. “Unique” means protection
not established by the **named inspected** complements, not an exhaustive claim
about every unexamined test. Missing proof remains a gap. No protection is lost
by this documentary audit.

### 1. affected-tests.test.js — REBUILD conservative edge evidence

**Mechanism / consequence.** [Subject](../../../tests/mc/affected-tests.test.js)
exercises real `main` / `selectAffected` in
[scripts/affected-tests.js](../../../scripts/affected-tests.js#L199): tracked
inventory, changedAgainst, import closure, pins, data-directory readers, and
unexplained-path full fallback. An under-selection can publish a falsely confident
green. Cheapest credible level: actual selector on minimal disk fixtures with
modeled inventory answers for decisions, plus the retained CLI-child check.

**Assertions / unique obligations.** Exact selected members and selected_by
reasons cover transitive imports, text pins, changed-test self-selection,
unexplained manifest/orphan fallback, direct data readers, directory-reader
propagation versus tree-walk narrowing, one-segment exclusion, manifest even
when named, deleted orphan/root docs, deleted read doc, empty known reach and
CLI `--changed-path`/realpath behavior. Several empty-reach/deletion cases only
check reason, not the full member set. No deleted imported source, rename,
uncommitted-change matrix or Git/read-failure assertion establishes conservative
behavior. Source inspection exposes a specific concern: resolveSpecifier requires
existence, so deleted imports lose edges; source paths are already considered
explained. This is an **unrun suspected under-selection**, not a demonstrated bug.
Regex imports/path literals are not a complete JavaScript dependency analysis.

**Setup / overlap.** Each callback creates model history, copies the selector,
writes small files and cleans up; the last launches real Node with model sharing.
[selector-miss.test.js](../../../tests/mc/selector-miss.test.js) checks attribution
and exact-SHA health evidence using supplied histories/TAP; it does not test this
selector's dependency graph or replace its fallback obligations.

**Bounded next action.** Propose editing only `tests/mc/affected-tests.test.js`
and, if needed, `scripts/affected-tests.js`: add a deleted source still imported
by a surviving test (direct and through a wrapper), asserting required members
or conservative full selection, and retain **every obligation above**, especially
unexplained fallback. No new parser, scanner, lane, helper-policy or exception edit.
A future fix may conservatively widen uncertain deletions; do not narrow other
changes. Proposed fault proof: after the new case passes, deliberately restore
existence-only resolution/empty deleted-source reach; its membership assertion
must fail, not merely setup. Separately suppress full fallback: the existing
manifest case must fail. Restore each fault and run the acceptance command in
the follow-up matrix. All faults and added cases are **UNRUN** here.

### 2. archive-plan.test.js — KEEP pure retention and history rules

**Mechanism / consequence.** [Subject](../../../tests/mc/archive-plan.test.js)
calls [archive-plan.js](../../../src/mc/archive-plan.js): `logRows`, `appendRow`,
`duplicateRow`, `namedFiles`, `keptFiles`, `relinkRemoved`, `remoteSlug` and
`keptParagraph`. Wrong retention removes data tests/code still read; wrong log
or link edits erase navigable history. Direct text calls and explicit Git-result
stubs are the cheapest credible decision evidence; real Git is not proved.

**Assertions / limits.** Thirteen callbacks cover dated rows vs header, placement
before notes, idempotence across dates and programme/project identity, duplicate
key, missing table, cell escaping, remote URL forms, exact retained/remove sets
and provenance, no-match short circuit, templates/directories/sibling boundaries,
wrapped comments, and removed blob/tree links preserving anchors, kept/external
links and inline code. The pipe test only checks formatted text and row count,
not a full escaped-cell round trip. Relinking has no full Markdown grammar proof.
The worktree stub treats any `grep.ok === false` as no match: source also does
this, so a Git error can look like permission to remove the whole directory;
failed ls-files/read paths are not established safe. Record that as a failure-path
planning gap, not permission to retire retention or assert fail-closed behavior.

**Setup / overlap / uniqueness.** A constant log and small in-memory command/text
stubs; no repository/service setup. [archive-programme.test.js](../../../tests/mc/archive-programme.test.js)
checks one code-read file kept in a model-backed archive PR. It does not replace
template, wrapped-comment, row/link parsing boundaries. Conversely these direct
checks cannot replace the consumer's refusal/release ordering.

**Next action.** Retain all thirteen checks at this level. Before commissioning
Git-error handling, decide the error/no-match contract and carry it through the
caller; no such fix or retirement is authorised here. Maintenance fault candidate
and executable command are in the matrix; no fault was run.

### 3. archive-programme.test.js — REBUILD consumer refusal evidence

**Mechanism / consequence.** [Subject](../../../tests/mc/archive-programme.test.js)
uses [archiveVerdict / archiveProgramme / shelveProgramme / removedKind](../../../src/mc/archive-programme.js)
and [plan command archive wiring](../../../src/mc/commands/plan.js#L134).
`programsGoals` excludes FINISHED stages before verdict; release is forecast,
archive PRs must land, then the planning area is released/moved. Incorrect
ordering can destroy unfinished work or strand the only local record.

**Assertions / limits.** Pure verdict checks refuse a build-stage goal, forecast
kept/held files and unknown programme; permit own documents. Removed-kind checks
limit relinks to actually emptied programme subtrees, not ancestor/sibling trees.
Consumer checks assert a closed row and model remote tree, temporary cleanup,
layout-2 whole-directory move and collision suffix, kept read file with PR/body
provenance, no PR for unfinished goal, kept area/no final release when merge
fails, existing-PR reuse, and argument refusals. A **pure forecast refusal is not
a consumer test** that real collection passes it through. The unfinished-goal
consumer asserts no PR but not every destructive operation. One-repository merge
stub success is not real main landing; no multi-repository partial failure,
unreadable-goal consumer or release-change race establishes retention.

**Setup / overlap / level.** Per-consumer model bare origin/clone and real small
Markdown/GOAL.json files; GitHub, docsMerge and release are stubs, with release
sometimes deleting the fixture area. `shelveProgramme` really renames disk files.
This is appropriate decision + local persistence evidence, not real Git semantics.
[goal-archive.test.js](../../../tests/mc/goal-archive.test.js) checks a different
single-goal archive's due time, dirty/open-PR refusals and moves, not programme
closure. Archive-plan covers named retention parsing, not release sequencing.

**Bounded next action.** Edit only `tests/mc/archive-programme.test.js` first:
exercise archiveProgramme with forecast.kept and forecast.held_by, asserting
no PR/merge/final release, unchanged area bytes and no shelving; add two repo
homes where the second docs merge fails, retaining the planning area. Strengthen
unfinished-goal consumer to assert no destructive effects. Preserve **all current
verdict, path-boundary, move/collision, kept-file, row, retry and CLI obligations**.
Keep dependency substitution at existing boundaries; no new Git exception.
Fault proof proposed: ignore forecast in the consumer and separately release
before successful completion of all repo merges. New retention assertions must
turn red; restore and run the archive matrix command. No proof yet; this rebuild
is additional decision evidence, not replacement integration or claimed savings.

### 4. asc-build-device.test.js — KEEP device decisions and orchestration

**Mechanism / consequence.** [Subject](../../../tests/mc/asc-build-device.test.js)
uses [ASC command](../../../src/mc/commands/asc.js#L340),
[devicePreflight / resolveTarget / readBack / makeStep / buildIos](../../../src/mc/ios-build.js).
Wrong revision, device choice or read-back approval installs an incompatible,
misconfigured or unsigned app; missing finalization strands a lane/running row.

**Assertions / limits.** Pinned [devicectl fixture](../../../tests/fixtures/devicectl-list-devices.json)
and modified inputs assert paired iOS only, absent/ambiguous/selected phone,
production containment refusal with no builder/row, production default and older
SHA, running-build preflight refusal, follow-none, declared bundle/commit/URL/
plugins/build/signature read-back, setup/sync/install arguments, inherited build
number removed for device, clean existing worktree recipe, lane take/release,
running→installed/failed and notes, no install on bad read-back, npm failure,
wrong HEAD, signing hints and thrown-step finalization. Start/follow checks real
TSV state around inline builder and log output; makeStep spawns a shell and a
50 ms timeout sleep, and refuses after stop.

External `run`/`step`, plist and codesign readers are controlled; these assertions
do not build, sign or install a binary. The two-commit revision fixture is the
Git model, not proof of real ancestor/worktree/clean semantics. Negative tests
for every preflight, dirty status, unknown SHA/main exclusion and real detach/
signal behavior are not all present. Exact command order is valuable where it
precedes install/read-back, but argv/text pins alone are not a successful build.

**Setup / overlap / uniqueness.** Fixture JSON is read at module load; callbacks
create model repos and temp work/home roots plus actual locked TSV rows. The
real shell/sleep helpers add process cost. [asc-build.test.js](../../../tests/mc/asc-build.test.js)
protects declaration/native-change reporting, not installing. TestFlight shares
build orchestration but uniquely verifies export/upload; it cannot replace device
selection, install exclusion, signature problems or makeStep timeout evidence.
[deploy-gate-wait.test.js](../../../tests/mc/deploy-gate-wait.test.js) checks lane
acquisition waiting, not builder final rows. Cheapest credible level is this
controlled boundary integration plus direct read-back predicates. **Next:** keep
all obligations and model/real limits; no fixture consolidation is justified by
this round's subsecond callbacks. Maintenance fault/command: matrix.

### 5. asc-build-testflight.test.js — KEEP consent, exported revision and upload checks

**Mechanism / consequence.** [Subject](../../../tests/mc/asc-build-testflight.test.js)
uses [buildTestflight](../../../src/mc/commands/asc.js#L371) and
[listBuilds / exportAtRev / atRev / buildIos](../../../src/mc/ios-build.js).
An accidental upload or stale script/revision/duplicate number ships an unintended
binary. Retain the existing real-Git export cases: model refusal of `archive`
cannot prove revision export or Node's real entrypoint behavior.

**Assertions / limits.** Max unordered ASC number + 1, main's list script and
cleanup, actual exported helper with checkout's fake installed package from a
behind checkout, entrypoint guard execution, missing script/export failure and
cleanup, readable error, secrets-path precedence and non-Node passthrough;
ASC/signing preflight failure, no/yes/headless/--yes/--no-upload/contradictory
flags with rows and no starts; archive→read-back→export→IPA read-back→number
recheck→upload order and argv/env; no upload for wrong IPA number/Distribution
identity or newly taken number, built vs uploaded state, delivery UUID, attach
printed never executed, archive pruning including exact members/current oldest.
The integrated pruning case's count is supplemented by the direct member test.

Real Git + tar/Node are used for script export; ASC, Xcode, unzip, plist and
codesign behavior are injected, not real Apple/signing/upload validation. The
number-taken test models the race, not an atomic reservation at ASC; malformed
number/JSON variants and every builder failure are not all covered. The real
export test exercises scripts/helpers/packages, not a real marketing data export.

**Setup / overlap / uniqueness.** Repeated real repositories and committed script
fixtures, actual temp exports and some child Node executions, filesystem archive
pruning; builder tests use small fake steps and real TSV persistence. The 133
Git calls and 249.890250 ms largest callback are measured; independent export/
startup cost is not. [asc.test.js](../../../tests/mc/asc.test.js) asserts revision
and script_paths requests with stubs; it does not replace actual git archive,
helper resolution or entrypoint execution. Device tests cover shared readBack
predicates but not IPA renumbering, Distribution authority, upload consent or
number recheck. **Next:** keep all 28 at their present evidence levels; don't
remove the real cases or hoist history to hide cost. Policy reconciliation stays
with Martin. Matrix gives future fault/check; no timing rebuild is warranted by
this single round.

### 6. asc-build.test.js — KEEP question, declaration and seed decisions

**Mechanism / consequence.** [Subject](../../../tests/mc/asc-build.test.js)
exercises [readIosDeclaration / nativeChanges / iosQuestion / recordShipped](../../../src/mc/ios-build.js#L96)
through the ASC command and [ios-builds register](../../../src/mc/ios-builds.js).
Wrong native classification misleads a release decision; wrong seed revision
corrupts future comparisons. Direct rules with small model histories and real
register files are the cheapest credible decision evidence.

**Assertions / limits.** Native paths/packages exclude web changes, same-commit
empty result, declaration from origin/main despite dirty checkout, missing
scheme/nested env key and absent declaration, deploy-enough/new-binary/deploy-first
messages, missing production refusal, no-shipped baseline, invalid flags,
injected version-fetch URL/failure, invalid SHA/no row, numeric seed build and
resolved full-SHA seed/lastShipped. No assertion proves all schema validation,
malformed lockfile safety, missing native package variants or real diff/ancestry.
Question cases assert output rather than a universal “no build/worktree mutation”
spy. Model fixtures do not establish real Git semantics.

**Setup / overlap / unique protection.** Two model commits with a declaration,
native/web file and lockfile; fresh work root with seeded/recorded TSV rows.
Device/TF tests cover actual start/upload decisions with controlled commands,
not the no-build question's native-only comparison or manual seed validation.
[asc.test.js](../../../tests/mc/asc.test.js) checks script-subverb arguments and
consent, not native change reporting. **Next:** retain these cheap direct/command
checks and the origin/main-vs-working-tree discriminator; no consolidation of
these distinct decisions. Matrix fault is proposed, not run.

### 7. asc.test.js — KEEP submit/release consent and declared-script routing

**Mechanism / consequence.** [Subject](../../../tests/mc/asc.test.js) exercises
[parseScriptArgs / declaredScript / runScriptSubverb](../../../src/mc/commands/asc.js#L132)
and real atRev coordination with Git/export/run/ask boundaries replaced. A
headless or refused act reaching live execution could submit/release the wrong
store version. Controlled orchestration is cheapest for mc's consent decisions;
it cannot prove the provider's version-state rules.

**Assertions / limits.** Routing/help rejects old build verb; missing/unknown
subverb and selected grammar errors; status uses origin/main scripts + marketing,
checkout secrets path/cwd and user args; script exit forwarding, review-notes
pass-through/no question, absent declared script/no live call; submit/release
without terminal make no capture/export/live calls; dry run asks nothing;
refused reading/no question/no live, no consent/no send, yes executes once
without dry-run. Tests use `n`, not empty/default answer, for interactive denial;
malformed JSON/nonzero-without-refused readings and positive submit are not all
separately asserted. These are gaps, not proof that every consent refusal holds.

**Setup / overlap / uniqueness.** One module-level temp checkout cleaned after
file; tiny declaration and tracked exports in arrays, no Git/service launch.
TestFlight's actual exported script test complements mocked export, but not the
marketing path materialization. TestFlight consent concerns upload and allows
explicit --yes; submit/release grammar deliberately does not. Keep both: shared
ask wording is not interchangeable authority. **Next:** retain all; maintenance
fault and gate in matrix. No installed Apple CLI or live App Store claim.

### 8. await-deploy.test.js — KEEP wait-policy evidence

**Mechanism / consequence.** [Subject](../../../tests/mc/await-deploy.test.js)
calls [deployHolding / awaitDeploy](../../../src/mc/await-deploy.js) around real
[gate-lock persistence](../../../src/mc/gate-lock.js). Waiting on merges would
unnecessarily block work; ignoring live deploy/build holds allows resource
contention. Local file integration plus deterministic holding/sleep callbacks
is cheaper and more credible than real waits for this decision.

**Assertions / limits.** Empty/merge/dead-deployer ignored, live deploy and iOS
pid/mode recognized, exact BUILD_MODES membership, poll totals, once-only
wait/start narration, immediate no-hold silence. No real five-second polling
elapsed-time assertion, concurrent claim race, or proof that every gate caller
actually invokes this wait. File cleanup is explicit in finally.

**Overlap / uniqueness / next action.**
[gate-lock.test.js](../../../tests/mc/gate-lock.test.js) covers real claim/status
files, dead/malformed holders, repository isolation, owner-only release and
no-force policy; not the deploy-vs-merge wait filter. [deploy-gate-wait.test.js](../../../tests/mc/deploy-gate-wait.test.js)
checks the reverse direction (builder waits for a merge lane then acquires it).
Neither replaces this caller's modes/polling/narration; keep all three callbacks.
Temp directory/file setup is small but separately unmeasured. Matrix gives the
future narrow fault check; no new concurrency framework is proposed.

### 9. billing-gateway-session.test.js — REBUILD bounded-grant plumbing evidence

**Mechanism / consequence.** [Subject](../../../tests/mc/billing-gateway-session.test.js)
uses [gatewayToolConfig / runGatewaySession](../../../src/mc/billing-gateway-session.js)
and [runtime-secret scrubbing](../../../src/mc/runtime-secrets.js). The wrapper
checks API enablement before opening the key, makes a random 500-request/12-hour
grant, starts a loopback server, hands the child scrubbed configuration and closes
the gateway in finally. Bad plumbing can expose a reusable key or create an
unbounded spending capability.

**Assertions / limits.** Direct Claude/Codex config checks selected key omissions,
Claude grant/base, Codex grant/WebSocket setting and arg tail. A real synthetic
Claude child verifies absent API/vault env values and calls its actual loopback
gateway; disabled Codex opens no key/starts no tool; nonterminal child gets pipes.
The test title calls the grant bounded, but **no assertion inspects the wrapper's
maxRequests, expiry, exact models/provider or single-provider key set**. It does
not prove child/process/socket/namespace isolation or absence of secrets from
all streams/auth files. The Codex config is inspected, not exercised by a real
Codex binary. No vault is decrypted; readKey and upstream are controlled.

**Setup / overlap / uniqueness.** Synthetic executable temp script, real Node
children and local HTTP listener: 547.865459 ms largest callback, no independent
startup attribution. [runtime-secret-names.test.js](../../../tests/mc/runtime-secret-names.test.js)
checks arbitrary registered env names and corrupt-registry refusal, not launch
plumbing. Gateway tests prove enforcement for supplied grants, not that this
wrapper supplies the promised limits. Retain the child-to-gateway canary and
API-off ordering; configuration-only assertions cannot replace them.

**Bounded next action.** Edit only `tests/mc/billing-gateway-session.test.js`:
capture createGateway's input while retaining the real gateway, inspect one
provider/model grant, positive configured request ceiling, finite near-12-hour
expiry using before/after time bounds (no real wait), matching child token, and
absence of the *other* key. Preserve all four existing obligations and the real
child case, not a mock of the scrubber. Relevant faults: wrapper supplies a
wildcard model/unbounded maxRequests or leaks opened.key into child env; the
new grant assertion or existing child canary must fail. Restore faults and run
the gateway matrix command. No mutation or equivalence proof performed here;
OS trust separation remains unresolved evidence, not accepted risk.

### 10. billing-gateway.test.js — REBUILD expiry and shared-budget evidence

**Mechanism / consequence.** [Subject](../../../tests/mc/billing-gateway.test.js)
exercises [createBillingGateway / grantFor / admit / relay](../../../src/mc/billing-gateway.js)
through actual HTTP and WebSocket listeners, with controlled HTTP fetch and a
loopback WebSocket upstream. Wrong grants/models/budgets permit cross-provider
use or unauthorised spending. Real local transport is cheapest for HTTP upgrade,
streaming, close/error and cross-socket enforcement; canned return values would
mock the mechanism being proved.

**Assertions / limits.** Correct upstream routes and own-key headers, streamed
answer, cross-provider/path/model refusal with no provider calls, HTTP request
ceiling, Claude alias-family restrictions, benign models response excludes key
canary, oversized-body 413/no upstream and recovery, compact route; WebSocket
key/beta header + frame relay, invalid handshake/path, wrong-model close/no frame,
request ceiling shared across sockets while other events pass, bidirectional
close and refused provider handshake with no relayed secret body. These are
unique transport outcomes, not just invocation-count checks.

All grants are future-valid at fixed NOW. No expired/invalid expiry, missing key,
malformed JSON/frame or **HTTP plus WebSocket combined** budget case exists.
The response-canary tests use upstream content that never includes a key; they
do not prove scrubbing a key reflected by a provider. Source streams HTTP bodies
and provider frames unchanged; it allowlists response headers, not body content.
Do not claim arbitrary upstream secrecy, hostile-process isolation or provider
compatibility from this. GET models is not counted by admit (POST/create are);
no claim that every HTTP request consumes budget. `until` polls every 5 ms with
no local bound, relying on the existing runner timeout on a lost event.

**Overlap / setup.** Session tests cover scrubbed launches and API switch, not
expired grants or shared transport limits. Temp listeners are closed via hooks;
WebSocket cases set up two servers and use synthetic responses, never live keys.
No new lane is needed for these local boundary checks.

**Bounded next action.** Edit only `tests/mc/billing-gateway.test.js`: retain all
12 current checks and add expired HTTP/upgrade grant denials with zero upstream
calls, and one grant consumed once over HTTP then exhausted over WebSocket
(and the reverse), using existing local fixtures and injected now. No long wait,
new helper area or provider run. Proposed faults: remove grant expiry predicate;
separately allocate a fresh request map per socket/transport. Relevant denial or
cross-transport assertion must fail, then pass on restoration under the matrix
command. These new cases/faults are **UNRUN**. Broader isolation/body-reflection
questions require separate security planning, not silent test redesign here.

### 11. billing.test.js — KEEP live storage/parser plus legacy decision protection

**Mechanism / consequence.** [Subject](../../../tests/mc/billing.test.js) calls
[billing.js](../../../src/mc/billing.js), including actual atomic JSON writes,
permissions, normalization, planWindows and legacy billingFor. Wrong persisted
API switches or damaged observations can cause unintended paid launches or lose
refusal state. Direct rules and minimal real file round trips are cheapest.

**Assertions / limits.** Exact modes/default/retry day, absent/broken/unknown
mode default, round-trip/0600/invalid refusal-no-write, clearing credit mark while
keeping plan windows, bad-state null normalization, patch preserves both top-level
states, last valid stream window/reset conversion with malformed-line tolerance,
legacy explicit-credits/default/unknown/Codex/unusable/expired-mark choices,
and API defaults/one-provider switch/mode preservation/0600/invalid provider.
No crash/parallel-writer or every invalid input boundary is proved.

**Important current-consumer distinction.** The header still says runner and verb
ask billingFor; actual [billing-route.js](../../../src/mc/billing-route.js) is
plan-first for both providers and API-off controls fallback. [run.js](../../../src/mc/run.js#L1170)
has its own local billingFor calling billingRoute, **not** an import of the legacy
export. A source search found no non-test caller of exported readBillingMode or
billingFor. That is not retirement authority: storage, API controls, state patches
and planWindows remain live (run.js and [model-capacity.js](../../../src/mc/model-capacity.js#L141)).
The legacy tests do not certify today's paid-routing policy.

**Overlap / unique protection / next action.**
[commands/run-billing.test.js](../../../tests/mc/commands/run-billing.test.js)
asserts current read-only status, automatic routing/100% indication, old-mode
rejection and per-provider switches with in-memory boundaries; it does not
replace real file preservation/permissions or stream parser cases.
[model-choice.test.js](../../../tests/mc/model-choice.test.js) checks capacity
candidate selection, review API reserve and 99/100% decisions, not legacy state
serialization. Keep the 13 cheap callbacks. Legacy-only mode decisions and
storage interoperability would be lost by wholesale retirement; **no inspected
replacement proves those legacy obligations**, and their consumer/compatibility
retirement decision remains unresolved for planning. No residual risk accepted.
Temp root per storage case and fixed NOW, no provider or repository fixture.
Future maintenance fault/command: matrix.

### 12. brief-collect.test.js — KEEP small shared-reader checks

**Mechanism / consequence.** [Subject](../../../tests/mc/brief-collect.test.js)
uses [listProposals / parseRuns / runsFor](../../../src/mc/brief-collect.js).
Missing proposal names hides work; wrong project/limit ordering misrepresents
history. Real small directory reads and direct TSV calls are cheapest; no command
launch/Git fixture is required.

**Assertions / limits.** Names sorted, Markdown only, headingless file included,
only file/path fields, missing directory empty; project filtering, absent project,
last limit with oldest-first exact PR membership. It does not prove no content
read by spying on reads, permission-error distinction, all row fields or
zero/negative limit semantics. `listProposals` catches every directory error as
empty. No assertion covers listProgrammes, proposalSystem, runsSince or
summariseRuns simply because they share a module.

**Overlap / uniqueness / next action.**
[commands/brief.test.js](../../../tests/mc/commands/brief.test.js) proves foreground
launch with no gathered prompt and rejection of retired --collect/--offline; not
shared reader correctness. Source inspection finds listProposals used as the default reader in
[helper-collect.js listAllProposals](../../../src/mc/helper-collect.js#L231),
consumed by [helper-turn.js](../../../src/mc/helper-turn.js#L296); no external
src caller of runsFor was found. Lack of a
caller is a planning input, not proof that deleting the filter/order protection
is safe. Keep all four near-zero-cost checks; no rebuild/consolidation saving is
established. Fixtures are one directory/two md files/non-md and inline TSV;
preload cleans leftovers. Matrix maintenance fault remains unrun.

## Executable follow-up acceptance and fault discipline

**Every command in this section is proposed, not an additional audit run.**
For each rebuilt subject, first run its command with the retained and proposed
cases and require green; introduce each listed fault separately in the named
mechanism, rerun the same command and require red **at the relevant observable
assertion**, not import/setup failure. Restore the fault, rerun green and inspect
`git diff --check`. Rebuild fixtures rather than split/hoist work to evade cost.
Record fault location/assertion, retained-obligation mapping, per-callback TAP,
setup/startup attribution limits and complete selected-round/gate cost. Existing
thresholds, gates, exception lists and model-vs-real boundaries remain unchanged.
A future red finding outside those files goes back to planning, not silent scope
expansion. No retirement is proposed; no runtime saving or replacement proof
has been measured.

| Decision(s) | Exact proposed acceptance command | Fault to expose (UNRUN) |
| --- | --- | --- |
| 1 rebuild | `mc gate tests/mc/affected-tests.test.js tests/mc/selector-miss.test.js` | Deleted imported module yields empty reach; separately unexplained manifest no longer selects all. Keep CLI/model decision boundaries. |
| 2 keep / 3 rebuild | `mc gate tests/mc/archive-plan.test.js tests/mc/archive-programme.test.js tests/mc/goal-archive.test.js` | In archive-programme.js ignore forecast or release before all merges: unchanged-area/no-final-release assertions fail. Maintenance check for archive-plan.js: drop template-named retention, exact kept-member assertion fails. |
| 4, 5, 6 keep | `mc gate tests/mc/asc-build-device.test.js tests/mc/asc-build-testflight.test.js tests/mc/asc-build.test.js` | In ios-build.js omit target containment, allow bad readBack to install, bypass number-taken check, or read declaration from dirty checkout: corresponding no-start/no-install/no-upload/origin-main assertions fail, one fault at a time. Keep actual exported-helper/entrypoint cases; do not change real-Git policy. |
| 7 keep | `mc gate tests/mc/asc.test.js tests/mc/asc-build-testflight.test.js` | In commands/asc.js run an act on no consent or bypass headless refusal: live-call/no-export assertion fails. |
| 8 keep | `mc gate tests/mc/await-deploy.test.js tests/mc/gate-lock.test.js tests/mc/deploy-gate-wait.test.js` | In await-deploy.js include merge in waited modes or ignore iOS build: mode/hold assertion fails. |
| 9, 10 rebuild | `mc gate tests/mc/billing-gateway-session.test.js tests/mc/billing-gateway.test.js tests/mc/runtime-secret-names.test.js` | In billing-gateway-session.js widen model/budget or pass opened key to child; in billing-gateway.js remove expiry check or separate transport counters. Require grant/canary/denial/shared-budget red and restored green. |
| 11 keep | `mc gate tests/mc/billing.test.js tests/mc/commands/run-billing.test.js tests/mc/model-choice.test.js` | In billing.js overwrite rather than preserve api on writeBillingMode, or take first not last windows: persisted switch/parser assertion fails. No fault in current routing is claimed detectable by the legacy billingFor cases. |
| 12 keep | `mc gate tests/mc/brief-collect.test.js tests/mc/commands/brief.test.js` | In brief-collect.js require heading/frontmatter or take first rather than last project rows: name/order membership fails. |

### Delivery and remaining decisions

Deliver only this report, twelve matching map-row links/statuses with a separately
dated note, and the required changelog fragment. Preserve map snapshot revision,
batch paths/order and all other statuses. This is **four REBUILD and eight KEEP**
recommendations; none changes protection. No consolidate/retire recommendation is
supported by inspected equivalent replacements here. The unperformed fault
proofs, failure-path/OS trust/provider gaps and legacy/policy planning decisions
above remain gaps; neither focused nor affected green accepts them.

## Appendix: measured callback times

Leaf callbacks only, in TAP/declaration order within each subject; values are
exact `duration_ms` from the single focused log above. Suite times are excluded
to avoid double counting. Names disambiguate measurements; setup inside each
callback is included, module/preload startup and process cleanup are not isolated.

### affected-tests.test.js

| Callback | ms |
| --- | ---: |
| follows imports through a chain, not just the direct one | 9.109084 |
| follows a source a test reads as text, which no import graph can see | 3.430083 |
| a changed test file selects itself | 3.881334 |
| a path it cannot trace means the whole suite, not a smaller guess | 3.765958 |
| a doc a test reads is that test, not the whole suite | 4.16175 |
| data read through a directory reaches every test that reaches the reader | 4.779417 |
| a tree a module builds paths under is not every test that imports it | 5.570125 |
| a one-segment directory literal is a path segment, not a tree | 4.005791 |
| a manifest is not data, however many tests name it | 3.655625 |
| a doc nothing reads is an unanswered question, not an inert one | 3.364083 |
| a doc that is deleted, and that nothing reads, reaches nothing | 4.133667 |
| deleting a doc a test does read still selects that test | 3.642917 |
| a deleted root document nothing reads is not the whole suite | 3.333209 |
| a change that reaches nothing selects nothing, and says so plainly | 3.692625 |
| run as a script from a temporary directory, it answers for the repository it sits in | 115.576958 |

### archive-plan.test.js

| Callback | ms |
| --- | ---: |
| the header and the \|---\| rule are not rows; a row starts with a date | 0.864125 |
| a row is appended after the last row of the table, not at the end of the file | 0.296875 |
| a row already in the log is not appended a second time | 0.156167 |
| duplicateRow names the first row that occurs twice by date, programme and project | 0.50075 |
| a log with no table at all still gets its row | 0.213333 |
| a cell is one line and its pipes are escaped, so the table survives a plan that uses them | 0.121375 |
| the repository slug comes from the remote, in either URL shape | 0.163375 |
| a file under the plan that a test names is kept, and everything else is removed | 0.488625 |
| nothing named is the whole directory, as before — and git ls-files is not asked | 0.131458 |
| a template names every file under the directory its fixed prefix points at | 9.459375 |
| a directory named literally keeps what is under it; a file that is not there keeps nothing | 0.223 |
| a link to a removed file points at it on GitHub at the archive's commit; the rest are left alone | 0.929667 |
| a path a comment wraps at its slash names the file on the next line, not the directory | 0.167666 |

### archive-programme.test.js

| Callback | ms |
| --- | ---: |
| refuses while a goal of the programme is not finished | 0.572209 |
| refuses what release would keep, and anything somebody put in the area | 0.466875 |
| refuses a programme that is nowhere | 0.0825 |
| lets a programme with only its own documents go | 0.10175 |
| names a removed file a blob and a directory it emptied a tree | 0.131167 |
| leaves a directory with a kept file, and every directory above the programme's | 0.065167 |
| names the programme's own directory a tree when nothing under it is left | 0.115125 |
| removes the directory on main with one closed row, then releases the planning session | 13.764333 |
| in layout 2 the planning session's worktrees go, the programme's directory moves whole to archive/programs/, and the archive exits 0 | 5.602292 |
| a programme archived under a name archived before goes beside it, never over it | 0.870209 |
| keeps a file a test reads, removes the rest, and names it in the PR body | 7.936667 |
| touches nothing while a goal of the programme is not finished | 3.169458 |
| keeps the planning session when the archive PR does not merge | 4.694167 |
| lands an archive PR still open from an earlier attempt instead of opening another | 2.219916 |
| needs a name and takes none of the session flags | 0.623708 |
| a programme row is the programme, with no project | 0.067125 |

### asc-build-device.test.js

| Callback | ms |
| --- | ---: |
| reads the paired iPhone from the pinned fixture | 1.034375 |
| leaves out a phone that is not paired and a device that is not iOS | 0.160958 |
| refuses without a paired iPhone, and starts nothing | 6.199917 |
| lists two phones with --device-id and builds on neither | 2.865209 |
| takes the phone --device-id names among several | 7.5525 |
| refuses a --sha production does not contain | 3.576834 |
| builds what production runs by default, and an older --sha it contains | 7.053875 |
| refuses while another build runs, before anything else | 3.841917 |
| --follow says so when no build runs | 0.855334 |
| passes an app that matches the declaration | 0.558667 |
| names each field that differs | 0.137833 |
| checks the build number only when one was set, and the signature always | 0.096083 |
| says missing for a commit key the app does not carry | 0.077417 |
| runs npm ci, the setup, the sync and xcodebuild in order, then installs | 3.211708 |
| moves an existing worktree with checkout and clean -ffdx | 1.517917 |
| takes its repository lane as ios-build and the row goes running → installed | 1.401125 |
| never installs an app whose read-back fails, and says why on the row | 1.538792 |
| goes running → failed at the step that failed, releasing the lane | 1.6975 |
| fails at worktree when HEAD is not the commit | 1.589125 |
| puts the keychain fix in the note when xcodebuild cannot sign | 1.636833 |
| completes the row as failed on a throw, releases the lane, and rethrows | 1.754084 |
| writes the running row, names the builder on it, and follows it to installed | 5.548291 |
| marks the row failed at start when the builder does not start | 3.57275 |
| prints the label, streams the output and keeps it | 16.384583 |
| stops a command past its timeout | 56.08475 |
| starts nothing after stop | 0.207959 |

### asc-build-testflight.test.js

| Callback | ms |
| --- | ---: |
| is one more than the highest version, in whatever order they come | 1.444375 |
| asks with origin/main's script, not the checkout's working tree | 200.531542 |
| runs the script with the rev's helpers and the checkout's packages, the checkout behind and on another branch | 249.89025 |
| runs a script that calls main() only when it is the entry point, as memoro's do | 210.648375 |
| refuses a script the rev does not have | 0.192083 |
| refuses in words when the tree cannot be written out, and leaves no directory | 0.414875 |
| names the error, not the place in Node that threw it | 0.236458 |
| names the secrets file in memoro's checkout for the script | 0.112083 |
| keeps a secrets file the caller named, and names none without a checkout | 0.1035 |
| runs anything but node <relative path> as declared | 0.176667 |
| exits 1 when App Store Connect does not answer, and builds nothing | 180.732708 |
| asks for an Apple Distribution identity | 93.668625 |
| a no records a refused row and builds nothing | 167.072875 |
| a yes goes into the job | 181.767083 |
| is refused without a terminal unless --yes or --no-upload | 93.754417 |
| --yes uploads without asking, even without a terminal | 186.681583 |
| --yes and --no-upload together are a bad argument | 96.061125 |
| --yes without --testflight is a bad argument | 90.885458 |
| --no-upload asks nothing, even without a terminal | 168.250084 |
| archives, reads back, exports, reads the IPA back, and uploads, in that order | 4.222791 |
| --no-upload stops at the verified IPA and completes the row built | 2.254041 |
| a wrong CFBundleVersion in the IPA stops at export-read-back and never uploads | 1.9605 |
| an IPA without Authority=Apple Distribution stops the same way | 1.853375 |
| a number taken between the question and the upload fails number-taken and uploads nothing | 2.21675 |
| captures the delivery id when the upload prints one | 2.44075 |
| prints the attach command and never runs it | 2.137084 |
| prunes the archives after a build | 2.596 |
| keeps the five newest and never the current one | 1.330042 |

### asc-build.test.js

| Callback | ms |
| --- | ---: |
| reports only the native path and only the native package | 7.518458 |
| is empty between a commit and itself | 3.528291 |
| reads origin/main, not the working tree | 3.746125 |
| names a missing key, nested ones too | 4.783208 |
| says memoro has none yet when origin/main lacks it | 4.181583 |
| says mc deploy is enough when nothing native changed | 6.658583 |
| names the native paths and packages when they changed | 4.358875 |
| says to deploy first when origin/main has a native change production lacks | 4.41425 |
| is exit 1 when production does not answer | 3.251084 |
| gives the seed hint when nothing has shipped, and counts every native path | 2.985875 |
| refuses another platform, and flags without their build | 2.963209 |
| reads production through the injected fetch, and null when it fails | 0.4205 |
| refuses a sha that does not resolve, and records nothing | 3.581166 |
| refuses a build that is not digits | 3.543541 |
| records a seed row that lastShipped then returns | 3.757792 |

### asc.test.js

| Callback | ms |
| --- | ---: |
| replaces mc build: asc is routed, build is not | 0.963875 |
| refuses no subverb and an unknown one with exit 2 | 0.335833 |
| parses each script subverb's words | 0.690166 |
| runs status with its words, scripts/ and marketing/ from origin/main, and MEMORO_DEV_VARS set | 1.195 |
| passes the script's exit code on | 0.5595 |
| runs review-notes with --dry-run and the words it was given | 0.460958 |
| refuses in words when origin/main declares no such script | 0.196833 |
| mc asc submit 1.1.2 44 without a terminal exits 2 and runs nothing | 0.231542 |
| mc asc release 1.1.2 without a terminal exits 2 and runs nothing | 0.13125 |
| --dry-run asks nothing, needs no terminal, and passes the refusal on | 0.473542 |
| a refused reading stops before the question | 0.453708 |
| a no at the question sends nothing | 0.4815 |
| a yes runs the act once, without --dry-run | 0.408709 |

### await-deploy.test.js

| Callback | ms |
| --- | ---: |
| deployHolding is the lock of memoro only when a live deployer wrote it | 4.537125 |
| awaitDeploy polls until the hold is gone and says so once each way | 0.678958 |
| waits for an iOS build in the lane of memoro, and names it | 1.370959 |

### billing-gateway-session.test.js

| Callback | ms |
| --- | ---: |
| tool settings carry only a bounded gateway grant, never a provider key | 1.118292 |
| a gateway session can call its provider without seeing the provider key | 547.865459 |
| API off: the key is never opened and the tool never starts | 0.251 |
| off a terminal the tool gets pipes of its own, not this process's stdout | 52.194916 |

### billing-gateway.test.js

| Callback | ms |
| --- | ---: |
| Claude and Codex requests use only their own upstream key and stream the answer | 29.306083 |
| gateway refuses cross-provider grants, unknown paths, model changes and extra requests | 12.341667 |
| a Claude grant on a family alias admits that family's model ids, fable among them | 4.527334 |
| gateway never sends upstream credentials back to a session | 2.387666 |
| an oversized body is answered 413 after it is read, and nothing reaches the provider | 4.534917 |
| codex remote compaction is a route of its own | 1.802834 |
| a Codex websocket is carried to the provider with the key, which never comes back | 13.093709 |
| an upgrade without a grant, or on another path, is refused before the handshake | 3.700667 |
| a response.create for another model closes the socket with 1008 and is not forwarded | 3.35525 |
| each response.create counts against the session request limit, across sockets | 15.899667 |
| closing either side closes the other | 16.331 |
| a provider that refuses the upstream handshake closes the session with 1011, relaying nothing | 1.975333 |

### billing.test.js

| Callback | ms |
| --- | ---: |
| constants: two modes, plan the default, a day | 1.019834 |
| readBillingMode: absent, broken and unknown files read plan | 0.753459 |
| writeBillingMode: each mode round-trips, 0600, and an unknown one is refused naming both | 2.441083 |
| writeBillingMode: a write clears the credit mark and leaves the plan windows | 0.906542 |
| readBillingState: absent or broken is empty, any bad field is null | 0.688458 |
| patchBillingState: merges per top-level key and writes the whole file | 0.78575 |
| planWindows: the last event carrying unifiedWindows, resets made ISO | 0.184833 |
| planWindows: a stream without unifiedWindows is null, a broken line is passed over, a bad window is null | 0.141708 |
| billingFor retired auto reads as plan | 0.167042 |
| billingFor credits: the credit only when Martin set the mode, whatever the windows say | 0.148666 |
| billingFor: a credit marked unusable is plan in every mode | 0.129417 |
| billingFor: plan and credits are themselves, an unknown mode is plan, codex is plan | 0.103 |
| readBillingApi/writeBillingApi: both on by default, one switched, the mode kept and kept by a mode write | 1.6785 |

### brief-collect.test.js

| Callback | ms |
| --- | ---: |
| lists the markdown names and nothing about what is in them | 1.310208 |
| an absent directory is empty, not an error | 0.107916 |
| keeps the last rows of one project | 0.196834 |
| keeps only the last `limit` of them, oldest first | 0.1075 |
