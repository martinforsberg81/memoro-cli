# Remaining protection contracts — mc

Source inspection, 2026-11-05; mc-tests/remaining-protection-contracts.
This report is **not implemented protection or estate certification**. No
subject execution, exploratory runtime probe, fault replay or historical/full
suite ran for these recommendations. All proposed proof below is unperformed.
Only the ordinary documentary affected gate is delivery acceptance, recorded
separately in the PR/log. No source/test, threshold, lane, conservative selector
fallback, tracked input or real-Git exception changes here.

## Identity, inputs and historical evidence

Judged source HEAD and merge-base with observed fetched `origin/main`:
`da30dc7d8f15b324f3d1994097ca33f4a5040359`. Observed tracking tip:
`063dd3a5362ddb4c7c06c804bdd7139300bbd6a1`. Initial status and authored
`git diff <merge-base> <judged-head>` were empty. No branch update/merge/fetch
was performed by this session. `git diff origin/main` initially showed 14 paths,
107 insertions / 1,268 deletions: upstream-only programme-trigger and audit
deliveries appear reversed, **not authored source/test removals**. Final authored
scope is this report plus the required changelog fragment, not that two-endpoint
diff. Final commit identities belong to delivery records.

```sh
git rev-parse HEAD origin/main
git merge-base origin/main HEAD
git status --short
git diff origin/main
git diff <merge-base> <judged-head>
git diff --check
```

Initial command outputs retained under session scratch
`goal-mc-tests-remaining-protection-contracts-20261105T224701Z` as
`memoro-cli-initial-{scope,merge-base,status,origin-main.diff,authored.diff,check}`.
The tracking tip is an observed fetched ref, not a fresh remote-state claim.

Inspected mc strategy (`canon/tasks/writing-tests.md` and its
`references/test-strategy.md`), programme README/PLAN, [first-batch](first-batch.md),
and archived proposals `2026-11-04-mc-{guidance-pointer-fault-sensitivity,unstaged-deleted-import-selection,established-gateway-expiry-evidence}.md`
plus `2026-11-05-mc-bound-legacy-gateway-event-polling.md`. The companion
Memoro report owns account-context, account-first indexes and required admin
audit persistence/failure. No sibling runtime result is assumed.

First-batch source revision `26490524d90800a8e26d24d48cc8fcedc46dc1fc` recorded
the three-file gate GREEN 54 tests / rounded 24 s, TAP process 18,475.542459 ms.
Canon suites 256.233 / 23.770 ms; decision suites 19.633 / 70.758 ms;
branch grouped-history callback 1,273.656 ms and OS callback 1,668.174 ms,
193 instrumented Git calls. Setup/template/copy/file costs were not isolated.
These are historical observations, not measurements or compliance of this HEAD.
`branch-landed.test.js` has no diff from that revision; canon/decision tests
**do** differ after single-entry task-layout migration, as detailed below.

## C1 — consolidate guidance obligations through the actual router

**Fault / consequence.** A shipped role can point at mc's entrypoint while a
required asking/proposal/publication route is missing or misdirected. Findings
then disappear or sessions miss safe publication guidance. Artifact delivery is
the cheapest credible level; no text check proves agent obedience or question
quality, and no agent-output evaluation is recommended.

**Inspected chain and overlap.** `tests/mc/canon-text.test.js` now enumerates
flat `canon/tasks/*.md`, keeps defining sentences/one-home checks and checks role
launches contain the single entrypoint without task bodies/catalogues.
`tests/mc/roles-decisions.test.js` uses the identical generic
`skills/mc/SKILL.md` regex for asking, proposals and publishing. That proves
entrypoint presence, not three distinct task routes. This is a source-inspected
gap, not an executed mutation. The old role-to-individual-`@skill` cross-coverage
was removed by the layout migration; do not restore obsolete layout pins.

`src/mc/roles.js:readCanonRole` selects role parts;
`instructionsFor` joins shared text and overlay; `expandRoleIncludes` expands
`@mc` to a tool-specific entrypoint and legacy `@skill`/`@verb` references to
resource pointers, retaining unknown markers. `src/mc/skills.js:wantedSkills`
validates/copies the canon tree; `syncSkills` stages replacement before deleting
owned legacy installs. The actual task discovery is `canon/SKILL.md`'s table
linking separately to `tasks/asking-martin.md`, `tasks/proposals.md` and
`tasks/publish-and-merge.md`. Roles need not preload these bodies.

`tests/mc/roles.test.js` already covers assembly for both tools, shared text,
role-part selection, missing bodies and unknown/legacy pointers.
`tests/mc/skills.test.js` installs into both isolated homes and checks every
router Markdown target **that exists in the router**, plus valid replacement,
drift/idempotence and nested-entrypoint refusal. Deleting a router link removes
it from that enumeration; it is not proof of required-link completeness.
Keep these delivery/installation mechanisms, not a mock pretending a route exists.

**Old-to-retained mapping for a bounded follow-up.** This is a proposed placement,
not permission to retire any authored constraint:

| Current obligation | Retained owner / acceptance |
| --- | --- |
| Defining task sentence in one home; exact task-name set | Keep `canon-text` until authoring policy explicitly changes; do not call it meaningless wording. |
| No long skill sentence copied into a role | Keep `canon-text`; duplicate a retained sentence in a role must fail. |
| RULES carrier exclusivity | Keep, and recommend requiring the named home, not allowing an empty carrier set. Absence currently passes this particular assertion. |
| No task permission language; 60-line page bound | Keep both authored constraints; changing/removing either needs a named planning decision. |
| Role entrypoint, no preloaded bodies/catalogues | Single retained assertion in `canon-text`, using real assembly for both tools; keep role-part/body tests in `roles`. |
| Asking/proposals/publish reachability | One required resource-to-operation mapping in existing `skills` tests; combine actual assembled entrypoint with router destination and installed resource content. Replace redundant generic role-pointer claims only after this proof lands. |
| No menus/old option shape, grounded readiness | Keep decision-file checks/editorial review; broad regexes are not semantic quality evidence. |
| Proposal programme/global path, not intake, and why | Keep unique decision-file assertions and one-home rule until equivalent reviewed replacement; no wholesale retirement. |
| Process/Git/scratch/test guidance and verb routes | Preserve existing router entries, installation coverage, assembly and authoring constraints; do not narrow to the three proposal subjects. |

**Candidate scope.** Change only `tests/mc/{canon-text,roles-decisions,roles,skills}.test.js`
as required for the mapping. Read canon once per file where possible, without
changing its authored content or installing to the person's home. Explicitly
assert the three required operation routes resolve to their **respective** task
paths, not just any installed Markdown, and check installed bytes against the
canonical resource. Exercise both Claude and Codex paths. Keep editorial
obligations alongside delivery; do not claim a paraphrase should pass a defining
sentence pin until planning approves that exact pin's replacement. No new scanner.

**Future proof (not run).** Independently delete and misroute each required
router task link while retaining the generic entrypoint and its other links:
its route-specific assertion must fail. Wrong existing destinations are
important: mere existence/installation tests would pass them. Separately remove
the assembled `@mc` route (fail entrypoint assertion), remove a required resource
(fail delivery assertion), and copy a retained task rule into a role (fail
one-home assertion). Restore exact canon and rerun:

```sh
mc gate tests/mc/canon-text.test.js tests/mc/roles-decisions.test.js tests/mc/roles.test.js tests/mc/skills.test.js
```

**Resources / cost / gap.** Isolated HOME/CLAUDE_CONFIG_DIR/MC_HOME/MC_WORK_ROOT,
local files and real parser/installer only; no launches/services/credentials.
Record changed callbacks, bundle/read/installation setup, file and affected
round costs. No current timing or fault-sensitive routing proof exists here.
Consolidation is for unique maintained obligations, not an assumed speedup.
If the mapping cannot preserve an authoring constraint, retain it and take the
specific proposed retirement to planning; no residual risk is accepted here.

## C2 — branch-landed cost with real mechanisms retained

**Fault / consequence.** Treating SHA-ahead count as unlanded content strands
squash-landed work; treating conflict/unknown or extra local content as landed
can delete unlanded work. Replacing Git with model answers would remove the
mechanism that distinguishes those states.

**Inspected chain / overlap.** `tests/mc/branch-landed.test.js` constructs
SQUASHED, RESTACKED and three MENDED templates at module load, copies them into
isolated repositories and rewrites origin URLs. `src/mc/branch-landed.js` compares
real merge-tree output with the base tree, checks newest merged PR/tip, recovers
missing heads via local bare-origin pull refs and rejects own patch content not
already in main. `src/mc/work-area.js:inspectWorkArea/inspectWorktree`,
`releaseVerdict`, `releaseWorktree`, `releaseWorkArea` and `removeWorktree`
connect inspection to real retention/removal. The fixture supplies `inUse: nobody`
except its explicit OS check. `directoryInUse` calls
`src/mc/standing.js:processesStandingIn` → `cwdsOfUser` (real lsof), then ps.
`tests/mc/work-release-verdict.test.js` already covers pure keep/remove policy;
it cannot replace merge-tree, conflict, patch equivalence, fetch or physical
worktree/branch removal, nor does `nobody` replace OS process discovery.

**Policy decision remains outside implementation acceptance.**
`tests/_isolate-home.mjs` counts real Git calls (including children), installs
the default model for files outside `tests/_real-git-files.mjs`, and makes an
off-list real call red on exit. `branch-landed.test.js` is already an exception.
The list also names git, merger, repo-merge-live, push-guard, asc-build-testflight,
work-layout, work-area-add, commands/deploy and fake-git tests. Preserve the exact
list and hard stop. Recommend Martin explicitly reconcile the zero-call goal
with a minimal retained real-Git semantics island in this existing exception;
do not expand exceptions or claim the model is equivalent. Until that decision,
retain all real cases and the OS probe; neither historical green nor this
report grants a policy exception or retirement.

**Bounded next contract.** Subject/test fixture only; no product cleanup policy
change. First attribute one focused normal file run to template construction,
copy/config rewriting, grouped mutations, production Git calls and OS probes,
using the existing `MC_GIT_CALLS_KEEP` output in scratch. Do not replay history
or time the whole estate. Candidate: reuse identical immutable history objects
for the repeated extra-work/conflict setups in the existing squash template,
only if it removes duplicate commit construction across cases. Copies/ref
updates and bare origins remain isolated, and all semantic assertions survive.
Do not just prebuild more histories or split callbacks: count total file Git
operations and include module setup. No source-based evidence yet establishes
this candidate saves enough or that OS startup can fit one second. If it does
not, the contract returns measured negative evidence to planning with the
recommendation to retain integration, not replace the OS/Git checks with stubs.

**Future fault proof (not run).** In exact-head disposable scratch, substitute
SHA-count classification for tree comparison (squash assertion fails);
make unknown land (conflict retention assertion fails); accept own extra content
as remotely landed (extra-commit null/retention assertion fails). Retain tests
for newest-head mismatch, missing/failed fetch, pruned branches, patch-equivalent
restacks, actual disk/branch removal and process discovery. Restore and run:

```sh
MC_GIT_CALLS_KEEP="$MC_SCRATCH/branch-landed-git.tsv" mc gate tests/mc/branch-landed.test.js tests/mc/work-release-verdict.test.js
```

**Resources / missing evidence.** Normal isolated test homes/temp roots, local
Git supporting merge-tree, local bare origins and OS lsof/ps visibility; GitHub
answers are boundary substitutes, no live GitHub/provider calls. Record Git
counts, callbacks, all template/copy/OS startup, file and round clocks, without
adding overlaps. No new cost run/fault was authorized here. Cannot meet budget:
retain protection and bring exact phase evidence/policy question to planning.

## C3 — unstaged extensionless deleted-import selection

**Fault / consequence.** A target deleted only from disk remains in the index;
an extensionless import through a wrapper can lose its existence-resolved edge
without acquiring a text pin. Selecting no importer would falsely green a gate.

**Complete subject chain inspected.** `scripts/affected-tests.js:changedAgainst`
combines merge-base diff and porcelain status; `tracked` uses ls-files;
`resolveSpecifier` only accepts existing candidates. `nameable` includes changed
paths for literal pins/data, but `gone` requires both non-tracked and absent on
disk. Thus an unstaged indexed deletion does not reach the committed-source
full-suite fallback. This is a source-inspected hypothesis, **not a reproduced
omission**. `tests/mc/affected-tests.test.js:repo` currently removes with `git rm`
and commits; direct/transitive extensionless deletion tests therefore prove
committed deletion only. Keep those tests and all deleted-document distinctions.

This file is not on the real-Git exception list: its fixture Git operations
are answered by `tests/_fake-git-default.mjs` / `tests/mc/_helpers/fake-git.js`.
The model's `cmd_ls_files` returns index entries and `cmd_status` compares index,
HEAD and disk, including ` D`; do not describe it as real-Git evidence. Do not
add an exception, disable enforcement or introduce a broad uncommitted matrix.

**Cheapest candidate / exact scope.** Extend the existing test fixture with a
disk-only `rmSync` after base commit, with no `git rm/add/commit`. Assert the
target is still indexed, absent on disk and reported as unstaged deleted before
testing selection. Wrapper imports `./missing` and test imports wrapper; the test
must not spell the deleted path with extension, so a pin cannot rescue it.
Assert exact selected members including an unrelated test, reason `full-suite`
and `unexplained: ['src/missing.js']`. Selection of the small fixture's whole
test set is an assertion, not authorization to execute the repository suite.

Only after a demonstrated omission, change `scripts/affected-tests.js`'s
source-deletion fallback to treat a changed source absent on disk conservatively
even while indexed. Keep the separate orphan-data deletion rule, tracked source
membership, import/pin/data reasons, unexplained/config fallback and SELF exclusion.
Do not reuse a broader predicate to silently narrow deleted-document coverage.
Keep the committed controls and add only a staged version of this same small
fixture as the index-absence control; distinguish it from disk-only deletion.
No rename matrix.

**Proposed proof (not run).** Run the new case against original source and require
the membership/reason assertion to fail, not fixture/setup or parse failure.
Apply the narrow fix, verify the unstaged case and existing committed/document
controls, restore any scratch fault and require normal GREEN:

```sh
mc gate tests/mc/affected-tests.test.js
```

**Resources / gaps / safe negative path.** Existing approved Git model and temp
files only; record callback, fixture/startup/file and round cost. Neither actual
unstaged selection nor real-Git parity has been measured here. If the model
cannot express the indexed/disk distinction, stop and return a minimal model
contract for planning rather than widening real-Git policy or claiming green.
If selection is already conservative at the later judged head, keep it and
report the asserted membership; do not force a speculative source change.

## C4 — reconcile landed gateway protection before adding expiry evidence

Prerequisite landed as `031227001d21dcaff9ff7e68089a37fde9a5789b`, PR #1289.
`git show --stat` identifies only `tests/mc/billing-gateway{,-session}.test.js`.
The following comparison returned empty / exit 0 at this judged source HEAD:

```sh
git diff --exit-code 031227001d21dcaff9ff7e68089a37fde9a5789b HEAD -- tests/mc/billing-gateway.test.js tests/mc/billing-gateway-session.test.js src/mc/billing-gateway.js src/mc/billing-gateway-session.js
```

Read both complete tests and both implementation files. The archived prerequisite
LOG records focused GREEN 23/23 / rounded 6 s, TAP 2.274 s; callbacks grant
0.013443 s, HTTP expiry 0.020844 s, upgrade expiry 0.023455 s, HTTP→WS budget
0.016297 s, WS→HTTP budget 0.015505 s, child canary 0.711516 s. It records
wildcard/Infinity, removed admission-expiry and split-budget fault replays,
then restored focused GREEN. Separate file-startup attribution was unavailable.
These are retained historical results at pre-squash `115269332d1e9dc0f67f64daa3501eaa19c9b2d5`,
not fresh measurements by this session or proof of the remaining cases.

| Existing assertion at landed/current source | Disposition |
| --- | --- |
| Both providers: one exact selected model (no wildcard), finite positive maxRequests exactly 500, finite expiry bracketed at 12 hours, exact token to child and only selected provider key | Keep; no duplicate provider-grant test. |
| HTTP past expiry and exact boundary: 401, zero upstream calls (Claude route through shared admission helper) | Keep; do not recommission HTTP expiry. This is not a separate runtime enumeration of every route/provider. |
| Upgrade past expiry and exact boundary: refused 401 before handshake, no provider socket/frame | Keep; do not recommission upgrade expiry. |
| HTTP consumes then WS: 1008 denial, no response.create forwarded | Keep; shared budget direction already protected. |
| WS consumes then HTTP: 429, zero HTTP upstream calls | Keep; reverse direction already protected. |
| Real synthetic child credential canary, relay key/header isolation, models, cross-socket budget, close propagation, refused upstream handshake | Keep all; no transport replacement. |

`src/mc/billing-gateway.js` has **three distinct expiry sites**:
`grantFor` before HTTP/upgrade, relay `setTimeout` calling `shut`, and the
`response.create` handler's `expiresAt > now()` check on an established socket.
HTTP/upgrade admission tests exercise only the first. Existing socket cases
keep injected time fixed. A timer that eventually closes a socket does not
prove frame-time expiry; a frame-time close does not prove the timer fires.

### C4a — established response.create expiry (recommended next protection)

**Fault / consequence.** Removing the frame-time check lets an already admitted
session spend after expiry when its closure timer has not run yet. Cheapest
credible level: existing real loopback WebSocket fixture and injected clock,
not a fake relay and not a twelve-hour wait.

**Bounded change.** Only `tests/mc/billing-gateway.test.js`; no duplicate HTTP,
upgrade, provider-grant or shared-budget work. Use `socketFixture`'s existing
`now` option with mutable `clock = NOW` and expiry far ahead of that initial
injected clock, so the scheduled real delay cannot expire during this case.
Wait for an upstream acknowledgement of a permitted frame while valid, with
budget left. Register a bounded race for client close versus provider `frame`
**before** sending the next response.create. Change injected `clock` to exact
expiry and separately past expiry in fresh fixtures; do not tick real timers.
Require `{code:1008, reason:'session grant expired'}`, no additional upstream
frame and bounded relay cleanup. Non-expiry model/budget refusals must not
satisfy this oracle. Observe provider close or a bounded event-loop barrier
before final frame membership, so a still-in-flight frame cannot fake absence.

**Future proof (not run).** Remove only the response.create expiry guard in
exact-head scratch, leaving `grantFor`, timer and budget intact. The outcome
must be forwarded frame/wrong close (assertion RED), not a real-timer expiry or
wait timeout. Restore source and run:

```sh
mc gate tests/mc/billing-gateway.test.js tests/mc/billing-gateway-session.test.js
```

### C4b — timer closure is a separate, unproved obligation

Recommend planning a distinct deterministic timer case after C4a: establish
valid real sockets, schedule with a fake/injected timer boundary, advance only
that scheduler to the delay, **send no frame**, require both sockets close with
expiry reason and no upstream frames. Removing only the timer callback must
fail the closure assertion (bounded observation of a still-open socket, not an
unhandled wait timeout) and restore GREEN with the same command. Selectively
control only the gateway timer so ws and diagnostic deadlines still progress;
if Node's clock mock cannot do that without interfering with real transport,
return to planning for a minimal scheduling dependency in
`src/mc/billing-gateway.js`. Do not quietly fake all timers or broaden product
scope. No scheduler seam or timer proof is implemented/authorized by this report.

**Resources / costs / gaps for C4a/b.** Local ws package, loopback listeners,
OS-assigned ports, synthetic keys/grants, bounded listeners and teardown; no
vault opening, credentials or external provider. Report handshake/setup and
teardown, callback, file and round clocks including first fixture; no current
measurements. A deadline diagnostic is not an expiry assertion. Missing events
must release clients/listeners and leave the real transport checks intact.

## C5 — bounded legacy event waits, not new gateway semantics

**Archived follow-up reconciled.** The landed gateway test still has `until`
polling every 5 ms without local deadline, used by relay response, cross-socket
budget and close-propagation tests, plus an unbounded `providerClosed` promise.
New expiry/budget assertions use `boundedEvent`/`boundedAny` with listener
cleanup; they did not replace legacy waits. The provider fixture emits `frame`
but not yet a custom connection event. Fault suppression evidence is absent.

**Fault / consequence.** A missing relay/close event can consume the whole
per-test timeout and obscure which transport outcome disappeared. Cheapest
credible fix is local fixture lifecycle in `tests/mc/billing-gateway.test.js`,
not a framework, timeout increase or production polling change.

**Bounded contract.** Replace only legacy `until` calls and `providerClosed`
with bounded observable waits registered before actions: session `message` for
responses, provider connection notifications (add a fixture-only event if
needed), and socket `close` for both propagation directions. Reuse cancellation/
listener-cleanup patterns, terminate all sockets on failure, and await server
close. Preserve every existing key/beta header, credential non-echo, exact frame
membership/type, other.event forwarding, cross-socket budget and close code/
reason assertion. Do not just add a deadline to polling or drop an assertion.

**Future proof (not run).** Suppress the expected fixture response event, then
independently suppress provider-close notification in exact-head scratch. Each
must report its named missing event within a proposed 250 ms local deadline,
below the one-second callback policy, remove its listeners/timer and release sockets;
no process-level test timeout/hang qualifies. Restore event delivery and require
normal transport assertions GREEN:

```sh
mc gate tests/mc/billing-gateway.test.js
```

Use deterministic clock control for the wait-helper failure branch where
possible without faking the real transport. Record deadline and normal callback,
fixture/setup/teardown, file and affected-round clocks, not a timing promise.
If cleanup/deadline cannot be bounded safely, retain existing assertions and
return the narrow lifecycle gap for planning; legacy-wait green proves neither
C4a nor C4b. Resources are the same local fixtures as C4, no live service.

## Delivery and recommendation ownership

Changes: this report and required `changelog.d/remaining-protection-contracts.md`
only. No test retirement, authored-constraint deletion, selector narrowing,
exception-list edit or map reclassification. No permanent wording test added.
Run ordinary `mc gate`, use `mc gate --whole-selection` if deferrals appear,
then diff/status checks and `mc publish --no-merge`. Retain complete receipt/log
and emitted callback/file/round clocks separately; partial/timeout is not green.

Planning should turn C3 and C4a into separate bounded implementation goals, C5
into a fixture-lifecycle follow-up, and C1 into a mapped consolidation preserving
authored constraints. C2 needs Martin's real-Git policy reconciliation before
changing its evidence strategy. C4b remains separate deterministic scheduler
proof, not silently covered by C4a. Memoro M3 likewise requires a product
decision. These unresolved choices are **outside documentary acceptance**;
neither this report nor an affected GREEN accepts residual risk or commissions
their implementation.
