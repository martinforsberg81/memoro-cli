# CLI-tests-adapters-001: protection and cost audit

## Scope, revisions and authority

Static review on 2026-11-05, in goal `mc-tests/audit-adapters-001`.
Examined source/test HEAD: `da30dc7d8f15b324f3d1994097ca33f4a5040359`.
At initial inspection, the fetched `origin/main` and
`git merge-base origin/main HEAD` both resolved to that same SHA; status,
`git diff origin/main`, `git diff <merge-base> HEAD` and `git diff --check`
were empty. This build did not fetch, merge or refresh its branch. Final
judged document HEAD, base, authored delta, dirty status and completed gate
receipt are recorded in the goal log and PR (outside this self-referencing
report). Upstream-only differences are not authored changes.

The inventory stamp remains migration-map HEAD
`31fe61a931a120c3ec111e4cd32cb088ae48a7f3` (2026-11-04).
All five exact named paths are still tracked at examined HEAD: no deleted,
moved, renamed or added subject in this batch. Map membership, execution
metadata and every other batch's statuses are preserved. Its existing Status
cells below now carry **recommendations with static evidence**, not runtime
certification. This report changes no implementation or tests.

Read the mc risk-based strategy (`canon/tasks/references/test-strategy.md`,
also installed through the mc skill), test-writing and publication references,
programme README and PLAN.md activation reconciliation. Static review is
sufficient here: **no exploratory subject execution or fault injection was
commissioned or run**. Predicted failures below are future acceptance contracts,
not demonstrated failures. Recommendations neither authorize removal nor
accept residual risk. No thresholds, lanes, tracked inputs, real-Git policy,
selector fallback or conservative selection are changed.

### Inspection ledger

Complete test bodies and inline fixtures read:

| Subject (repository-relative) | Lines at examined HEAD | Recommendation |
| --- | ---: | --- |
| `tests/adapters/codex-hooks.test.js` | 66 | KEEP; bounded safety follow-up H below |
| `tests/adapters/get-status-contract.test.js` | 176 | KEEP; clarify presence vs authentication |
| `tests/adapters/managed-runtime/claude-managed-custody.test.js` | 324 | KEEP crypto/CAS checks; REBUILD lease outcome proof, contract C |
| `tests/adapters/materialise.test.js` | 182 | KEEP active refusals; legacy skips are not protection, contract M |
| `tests/adapters/model-args.test.js` | 71 | KEEP direct argv contracts |

Complete protected implementations read: `src/adapters/claude-code.js`,
`src/adapters/codex.js`, `src/adapters/_materialise.js`,
`src/adapters/managed-runtime/claude-managed-custody.js`,
`src/adapters/managed-runtime/claude-managed-refresh.js`,
`src/vault/engine/custody-crypto.js`, `client-crypto.js` and `custody-session.js`.
Read the real API boundary in `src/vault/engine/api.js` (portal/status/unlock,
list/update and acquire/renew/release wrappers), not a server implementation.
The subject injects cache/API/provider boundaries; it does not execute default
keychain, trusted-portal discovery or network implementations.

Complete shared preload `tests/_isolate-home.mjs` and `package.json` read.
Read complete overlap tests `tests/vault/engine/startup.test.js`,
`tests/vault/engine/custody-session.test.js` and `tests/mc/run-codex.test.js`;
also the relevant `tests/mc/run-plan.test.js:24-109` and
`tests/vault/engine/custody-crypto.test.js:31-124` assertions. These are overlap
inputs, not additional audited subjects or recommendations. Source/doc context:
`docs/technical/mc-codebase.md:43-123`, `mc-run.md:185-214`,
`vault-revision-rollout.md`, and the import/pin/data/fallback machinery in
`scripts/affected-tests.js:1-180`.

## 1. codex-hooks.test.js — KEEP selective filesystem cleanup

**Fault and consequence.** Overbroad uninstall can delete a user's real Codex
launcher or unrelated startup hook; under-cleanup leaves a legacy wrapper or
capture entry active. `src/adapters/codex.js:47-151,403-421` implements config
filtering, protected rewrite and legacy script predicates.

**Actual assertions and boundary.** Three callbacks use real temporary files,
not a mocked filesystem. The legacy launcher/shim fixture must return both
paths in `removed` and leave neither present. The unrelated `echo real codex`
shim must survive and `removed` must be empty. Mixed SessionStart entries must
leave exactly the unmarked `user-start` entry and report the rewritten config.
Cleanup runs in `finally`. This proves mc's file mutation for those fixtures,
not that Codex accepts a hooks file or runs a hook.

**Limits and overlap.** Despite “only the marked” in the test name, the source
also recognizes unmarked commands matching `provider-artifact capture --tool
codex`. Only the explicit `_memoro` branch is exercised. Missing config and
missing scripts occur in fixtures, but repeated uninstall, malformed JSON,
unsafe target/directory, and other hook-event preservation are not asserted.
The shim predicate accepts a mere `codex-memoro` substring, and script removal
reads then removes without a symlink-specific ownership assertion; the current
unrelated fixture does not certify all user files safe. No other tracked test
found directly calling `uninstallHooks` in the bounded symbol search. Credential
refusal and argv tests in this batch do not replace this destructive-I/O check.

**Cheapest credible level / cost.** Keep a tiny real temporary filesystem
integration. Do not substitute source text or launch the tool. Three directory
fixtures plus JSON rewriting/cleanup are visible work, not measured cost.

**Executable keep contract.** `mc gate tests/adapters/codex-hooks.test.js`.
In a separately commissioned exact-head scratch replay, make
`removeManagedCodexScript` ignore its predicate: the unrelated-file
`removed === []` / file-survival assertions must fail. Restore the source and
require the same command green. No assertion-level replay has run in this audit.
Resources: Node 22+, normal dependencies, local writable temp storage only.

**H — proposed bounded safety follow-up (planning required).** Work only in
this test and Codex uninstall helpers. Resolve intended ownership for an
unmarked capture command and a user script mentioning `codex-memoro`; add
explicit owned/unowned fixtures preserving non-SessionStart events and bytes
of rejected/unsafe config. Add POSIX symlink fixtures if supported by the
approved lane. An overbroad predicate must fail the preserved-file/content
assertion; bypassing config validation must fail rejection/no-mutation assertions.
Use the same command and scratch red/restore/green procedure. If ownership is
unclear, retain current checks and ask planning to settle it before modifying
deletion semantics; do not infer authorization from the regex.

## 2. get-status-contract.test.js — KEEP cheap status decisions

**Fault and consequence.** A missing hint makes an absent/unknown login look
unactionable; ignoring macOS Keychain presence reports a signed-in installation
as signed out. The protected decisions are `claude-code.js:247-357` and
`codex.js:358-401`, not provider authentication.

**Actual assertions.** For both adapters: nonempty TOOL_NAME, positive timeout,
getStatus function; vault method existence and location shape; not-installed
`installed === false`, shape and hint; installed `installed === true` and exact
stub version. Shape accepts boolean/null authenticated, string/null version,
array detailLines, and requires a nonempty hint on false/null auth. Claude's
separate branches assert true/null-hint and false/sign-in-or-complete hint.
The resolver tests file-first presence, macOS positive/negative Keychain
responses, and Linux false with the Keychain stub **not called**. Codex's
installed branch asserts unknown auth and an actionable Codex hint without
“not implemented”. These are observable API decisions rather than source pins.

**Boundary, gaps and overlap.** `which`, version and presence are injected;
no installed CLI, login, credential body or actual Keychain is touched.
`authenticated: true` here means presence reported by a stub, not successful
provider authentication or token validity. Positive timeout metadata does not
prove a wall timeout, `which` timeout or a bounded actual Keychain call. The
array location check passes vacuously for today's empty arrays; materialise's
`deepEqual([], ...)` obligation is stronger. It also checks callable materialize
and shred methods, which empty destinations alone do not. Retain that small
surface obligation rather than claiming the whole test redundant. No inspection
of every `detailLines` element or version-probe failure handling is asserted.

**Recommendation and executable contract.** KEEP direct calls with deterministic
injected decisions: cheapest credible level for these outcomes. No need for
real credentials or a provider process. Later clarify the misleading
“installed-and-authed”/file-only descriptions without pinning wording.
`mc gate tests/adapters/get-status-contract.test.js`. Future deliberate fault:
remove the Keychain fallback in `resolveCredentialsPresence`; the macOS
file-absent/item-present `true` assertion must fail. Separately drop Codex's
hint: the null-auth shape/hint assertions must fail. Restore each source delta
and require the normal command green. Resources: Node and existing dependencies;
no macOS service needed because the presence probe is injected. Fault proof,
real probe/parser/timeout behavior and runtime cost remain unmeasured, not green.

## 3. claude-managed-custody.test.js — KEEP security checks; REBUILD lease proof

**Fault and consequence.** Selecting an ambiguous grant, accepting missing row
revisions or retrying a stale write can overwrite another device's refreshed
credential. Losing the lease while publishing a newly rotated refresh token can
strand authentication. Protected mechanism: managed custody load/persist/rotate
and lease keeper, with real envelope parsing/encryption and refresh parsing.

**Actual assertions and fixtures.** Seven top-level tests (one with four
invalid-token subtests) create isolated in-memory API state. `importVaultKey`
imports fixed 32-byte synthetic key material; real WebCrypto mints CRK/DEKs
and encrypts/decrypts envelopes. No password KDF is invoked by this fixture.
The fake API exposes one secret, a lease-token slot and renewal/update counters:

- Load one record: ok, exact id, opaque 32-lowercase-hex row token and old refresh
  grant; two matching records: ambiguous reason. The numeric `revision: 1` is
  intentionally different from the opaque row revision.
- Rotation success: ok/refreshed, changed opaque revision, new access token,
  **two renewals**, and decryptable new access/refresh values in the fake row.
  `updateSecret` asserts exact expectedRevision and current lease token; renew
  and release assert id/token. This is real crypto over a simulated API write.
- Locally stale expectedRevision: conflict reason/flag, zero updates and unchanged
  ciphertext. The title's “before encryption leaves the host” proves no API
  update, not zero local encryption calls.
- Server 409 `VAULT_SECRET_CONFLICT`: conflict reason/flag, exactly one update
  attempt (no retry), unchanged fake-row ciphertext.
- Missing/empty/numeric/uppercase row tokens: revision-required, zero OAuth and
  update calls, unchanged ciphertext.
- Another lease owner: busy, exact retryAt, zero OAuth calls. Renewal throws
  lease-lost: lease-lost reason and zero OAuth calls.

**Evidence limit.** “Distributed lease through durable CAS” is a test title,
not established distributed/durable behavior. The API is an object, not HTTP,
a database, a transaction or concurrent devices. It asserts a token equals a
slot, not server lease expiry/CAS atomicity/durability. The fake write is then
decrypted with the real CRK: useful adapter/crypto integration, not persistence
proof. Two renewals alone do not assert ordering relative to OAuth/update or
that release happened; an omitted release is not caught by a mandatory release
count. Timer renewal, lease loss during OAuth, post-OAuth renewal loss, reload
winning between acquisition and refresh, unconfirmed write/release and missing
record cases are not covered by these assertions.

**Overlap / cheapest credible level.** Keep this local integration. The inspected
custody-session tests separately protect generic schema dispatch/adoption with
real crypto and fake API; custody-crypto assertions protect class AAD, wrong-key
and tampered-wrap failures. Neither checks managed row-token propagation,
no-OAuth denials or no-retry. Do not consolidate them into a fake cipher or add
real SQL to this CLI audit. `vault-revision-rollout.md` records the separate
server/migration prerequisite, not evidence supplied by this test.

**Executable keep contract.**
`mc gate tests/adapters/managed-runtime/claude-managed-custody.test.js`.
Future independent faults: omit `expectedRevision` in the update payload
(the fake API equality and rotation success must fail); retry a server row
conflict (the `updateCalls === 1` assertion must fail). Restore each and require
the same command green. Source assertions suggest sensitivity; this audit has
not demonstrated it.

**C — executable rebuild contract for planning.** Extend only this existing
subject and, if faults are confirmed, its custody module. Keep all current
crypto, invalid-token, ambiguity, stale-write and busy assertions. Replace the
success test's renewal-count-only evidence with a small stateful boundary:
record lease ownership and current phase at OAuth entry and update acceptance;
require a confirmed renewal before OAuth and again after OAuth before write,
with the same secret id/token. Assert final release exactly once after write
and no remaining lease. Defer the provider promise, trigger the injected
`deps.setInterval` callback, return lost renewal, then settle the provider:
assert aborted supplied signal, lease-lost and zero update attempts. Separately
let first renewal succeed and second fail: assert zero updates/no new grant
success. Supply `clearInterval` to assert keeper cleanup without real waits.
Return unconfirmed release after a successful write and require
`ok === false`, reason `managed-claude-refresh-lease-release-unconfirmed`.
Return `ok:true` with unchanged/absent row_revision from update and require
`managed-claude-custody-write-unconfirmed`, not refreshed success.

Run the same focused command. Independent source deltas suppressing the
post-OAuth renewal, moving both renewals before OAuth (which preserves the
old count), skipping release, ignoring keeper loss or accepting an unchanged
write token must each fail their named outcome assertion, not setup.
Restore between deltas; capture red and restored green on the judged SHA in
isolated scratch using the mc replay procedure. Resources: Node WebCrypto,
existing dependencies, synthetic keys and an injected scheduler/API/fetch;
no service, real tokens or waits. Measure first fixture/callback, file/setup and
selected-round cost; no runtime target compliance or saving is demonstrated
here. A provider/import crash is insufficient proof: restore and repair the
fixture before judging detection. Real server lease/CAS semantics remain a
separate planning/evidence boundary, not an implied new integration lane.

## 4. materialise.test.js — KEEP active plaintext refusal, not legacy green

**Fault and consequence.** Reintroducing token destinations or writing a vault
token into tool files/environment leaks reusable credentials into a model's
domain. Current `tokenLocations` returns empty and both `materializeToken`
implementations unconditionally return `plaintext-materialisation-disabled`.
`shredToken` still delegates file cleanup to `_materialise.js:68-86`.

**Actual assertions.** The active loop provides four cases across Claude/Codex:
exact empty destinations, then exact rejection result for file and env inputs,
nonexistence of the supplied temporary file and sentinel-free JSON diagnostics.
No real secret is used. All **three legacy describe blocks are skipped**, with
13 dormant cases for positive writes, 0600/shape/overwrite, cleanup, locations
and argument validation. They are not executed protection. The introductory
materialisation/0600 comments describe the old design, not today's green claim.

**Boundary / missing evidence.** No active assertion snapshots `process.env.SECRET`;
no-file/result checks do not detect an env-only side effect. No active
`shredToken` behavior is exercised. The skipped cleanup assertions cannot be
counted as cleanup evidence, and a 0600 file would not establish credential
separation anyway. `_materialise.js`'s write helper writes directly (despite
its stale atomic-write comment); the disabled adapters do not test it now.
The active `Date.now` filename is not a private mkdtemp directory, and there
is no file cleanup if an erroneous write occurs. This is a fixture-hardening
follow-up, not permission to execute a leaking fault here.

**Meaningful overlap / cheapest level.** Status checks only shape/method
presence, not refusal or absence of a write. The complete startup test asserts
no materialise/unlock/prompt calls and an empty result at the launch seam;
it does not call each adapter's refusal. Keep both cheap layers. Direct adapter
calls plus a tiny local filesystem absence check are sufficient for this local
boundary; not full credential-boundary certification or live provider evidence.

**Executable keep contract.** `mc gate tests/adapters/materialise.test.js`.
Future exact-head scratch fault: return a nonempty destination from one adapter
or return `{ok:true}` from materializeToken. Respectively the exact empty-array
or rejection-object assertion must fail; restore and require normal green.
No such proof or subject runtime measurement was made here.

**M — proposed bounded rebuild contract (planning required).** Preserve the
four active checks. Use a private mkdtemp directory with finally/after cleanup;
snapshot and restore a synthetic env name around each refusal and assert
absence/unchanged value on return. A deliberate env write with the same rejected
result must fail that assertion; restore then run the focused command green.
Do not silently delete the skipped blocks: first inventory their 13 dormant
obligations, separately commission any still-required shred cleanup assertions
against real temp files (removed/missing/error outcomes), and explain obsolete
positive-materialisation expectations in a removal decision. They currently
supply no running protection, but removing their specification is still a
planning decision. Resources: Node/existing deps, local writable temp storage
and synthetic sentinel only. Fault outputs must not copy real credentials.
No retirement or cleanup replacement is implemented by this report.

## 5. model-args.test.js — KEEP exact native argv contracts

**Fault and consequence.** Misplacing a flag around a resume positional can
silently select the wrong model; dropping native tools/delegation or strict MCP
settings changes session capability/authority. Protected functions are
`claude-code.js:131-200` and `codex.js:257-302`, not installed CLI behavior.

**Actual assertions.** Two delegation callbacks pin Claude's exact seven-member
tool string plus strict-MCP flag and Codex's no-docs/native-delegation overrides.
Five argv callbacks assert Claude model/resume placement, Codex model-before-id,
raw `gpt-6.1-sol`/`gpt-6-luna` names, medium/high effort overrides and null/empty/
numeric effort rejection; no-model resumes unchanged; invalid model inputs
produce no flags; missing session ids return null. Exact arrays are appropriate
because argv membership/order is the external contract, not a private call trace.
The examples are not a registry of valid provider model names.

**Overlap and limits.** The inspected run-plan cases use real adapter methods
inside headless argument assembly, covering fresh/resumed launches and native
switch placement across roles. The complete run-codex test records actual stub
process argv, usage and runner logs; it uses real local Git/process fixtures,
not a claim that a real Codex accepts argv. These are complementary composition
and dispatch checks, not cheaper replacements for the direct resume/invalid
input boundary. This batch test itself spawns no CLI or Git. Do not retire the
real-Git exception or replace its semantics with a model through this audit.

**Executable keep contract.** `mc gate tests/adapters/model-args.test.js`.
Future scratch fault: move Codex `...modelArgs(model)` after sessionId in
`resumeArgs`; the exact `['resume','-m',model,id]` assertion must fail. Removing
`--strict-mcp-config` must fail the exact tool array. Restore each delta and
require the same command green. Resources: Node plus existing dependencies,
no CLI install, provider network or credentials. Cheapest credible level is
these direct pure calls; a live provider probe would answer a different question.
No demonstrated fault proof or timing saving is claimed.

## Cost ledger and delivery acceptance

| Clock/evidence | Status and interpretation |
| --- | --- |
| All five subjects' callbacks | **NOT MEASURED** by this audit; no focused/batch run authorized |
| Subject file/startup/setup/cleanup | **NOT MEASURED**; do not sum fixtures or predict seconds |
| Subject red/restore/green sensitivity | **NOT RUN**; contracts above are proposed acceptance |
| Documentary affected round | Ordinary `mc gate`; if deferred, `mc gate --whole-selection`; completed receipt/log and its available clocks in goal log/PR |
| Documentary callback/file clocks | Only what completed logs actually supply; absence is **NOT MEASURED**, not zero |

The retained `goals/.archive/map-test-migration/LOG.md` records the 2026-11-04
CLI map gate as 47 tests / 12 s at its finish, with
`gate-20261104T161843Z-4fd7ee45-8ed2-49d2-af06-7dfc9ab1bd42.log`.
That is **historical documentary evidence**, not a runtime baseline for these
five subjects. Prior first-batch Git timings in migration-map/first-batch.md
refer to different subjects; none is transferred to adapters. No controlled
speedup or whole-estate certification follows from static fixture inspection.

Commands used for this review: `git rev-parse HEAD origin/main`,
`git merge-base origin/main HEAD`, `git status --short`, `git diff origin/main`,
`git diff da30dc7d8f15b324f3d1994097ca33f4a5040359 HEAD`, `git diff --check`,
`git ls-files` for tracked symbol/membership reconciliation, `cat` and bounded
Python text/range readers for the ledger above, `node --version` (`v24.10.0`),
and `mc gate --help` / `mc publish --help` / `mc goal --help`. `mc deps --help`
was read but no dependency audit/update/install was run. Normal dependency
attachment belongs to the documentary gate; no package changes are required.

Delivery acceptance checks (not subject fault probes):

```sh
git rev-parse HEAD origin/main
git merge-base origin/main HEAD
cat docs/technical/test-audits/audit-adapters-001.md
git diff origin/main
git diff <merge-base> <judged-head>
git diff --check
mc gate
# Only if the affected receipt defers files:
mc gate --whole-selection
git diff --stat origin/main
git status --short
mc publish --no-merge --title "Audit adapter test protection and cost" --body-file "$MC_SCRATCH/pr-body.md"
```

Require complete affected GREEN, retain exact receipt/log and revisions, and
publish for independent review. Partial, deferred or timeout evidence is not
acceptance. If documentary verification fails, inspect the named log, fix only
commissioned documents if responsible, or record the blocker and safe bounded
next step; do not weaken tests or run a historical/full-estate replay. Future
H/C/M implementation scope and any retirement remain planning work. No
protection has been removed in this delivery.
