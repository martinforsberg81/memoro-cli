# CLI-tests-vault-001: protection and cost audit

## Decision and evidence boundary

Documentary audit, 2026-11-05, of exactly the twelve subjects below. **Eight
KEEP and four REBUILD recommendations; none implemented.** No retirement,
accepted residual risk, changed protection, selector, tracked membership, lane,
threshold, fixture or production behaviour is authorized by this report.
Rebuild contracts require separate planning and independent review before work.
The wider estate, providers, deployed server and OS isolation are not certified.

Read: `canon/tasks/references/test-strategy.md`, the installed mc writing-tests
and publication/scratch guidance, programme `README.md`, `PLAN.md` and this
goal's `LOG.md`. The activation reconciliation commissions static review only.
No exploratory subject run, fault injection, benchmark, live service, credential,
production data, browser, database or full-suite replay was used for this audit.
Future commands/faults below are **UNRUN implementation/validation contracts**,
not claimed red/green evidence. No permanent tests are added here.

### Revisions and inventory

- Inspected source HEAD: `da30dc7d8f15b324f3d1994097ca33f4a5040359`.
- `git fetch origin main` succeeded; fetched `origin/main` and
  `git merge-base origin/main HEAD` both returned that same SHA. No merge or
  branch refresh was performed by this build session.
- Initial `git diff origin/main`, merge-base-to-HEAD diff and
  `git status --short` were empty. Delivery's judged document revision,
  authored delta and completed gate receipt are recorded in the goal log/PR;
  this source stamp stays fixed rather than pretending the report hashes itself.
- Inventory stamp retained from `migration-map.md`:
  `31fe61a931a120c3ec111e4cd32cb088ae48a7f3`. All twelve named paths exist
  there and remain tracked at inspected HEAD. **Deleted: none. Moved: none.**
  Only `local-codex-revision.test.js` changed among the twelve since that stamp,
  in landed `4f52a11c1913a05833d6ffe5431e9735de03f6ab` (#1309).
  Its current complete file, not its older inventory body, is audited below.
  Shared `_helpers/mock-server.js` also changed; it was read in full as current
  fixture code, not added to this batch. Other batches retain their status.
- The first scratch reconciliation attempted `git show <inventory-stamp>:docs/technical/test-audits/migration-map.md`
  and failed: the map was written after its source snapshot. Safe correction:
  compare membership with the retained HEAD map and separately use
  `git cat-file -e <inventory-stamp>:<subject>` for every stamped subject.
  Corrected reconciliation passed; no inferred green from the failed command.

### Inspection and reproducibility

Every named test was read completely, including inline fixtures and assertions.
Implementation read in full: `src/vault/engine/{audit,bindings,c1-claude-lease,client-crypto,custody-crypto,custody-session,import-scan,key-cache,startup,step-credit-key,types,api}.js`,
`src/lib/keychain.js`, `src/runtime/broker/c1-child.js`, and
`tests/vault/engine/_helpers/mock-server.js`. For the 2,740-line
`src/vault/credential-domain/local-codex.js`, inspected its imports/constants,
complete custody load/inspect/persist functions (1255–1408), auth normalization
and payload update (2074–2112), and `safeFailure` (2734–2740), the implementation
closure claimed by this subject. Unrelated native-domain launch machinery is
not claimed audited. Read the credential-boundary section of
`docs/technical/mc-codebase.md`, `docs/technical/vault-revision-rollout.md`,
`package.json`, the isolation setup and affected selector's data/fallback rules.
Consumer inspection included `src/cli/vault.js` import dry-run, bind refusal and
set binding refusal/persistence branches. Other-suite searches identify possible
adjacency, not an audit or equivalence finding for CLI-tests-vault-002.

Exact repeatable source/state commands (inspection, not test execution):

```sh
git rev-parse HEAD origin/main
git merge-base origin/main HEAD
git diff origin/main
git diff <merge-base> <judged-head>
git status --short
git diff --check
git diff --name-status 31fe61a931a120c3ec111e4cd32cb088ae48a7f3 HEAD -- tests/vault/engine
git ls-files --error-unmatch tests/vault/engine/{audit,bindings,c1-claude-lease,crypto-port,custody-crypto,custody-session,device-unlock,import-scan,key-cache,local-codex-revision,startup,step-credit-key}.test.js
cat tests/vault/engine/{audit,bindings,c1-claude-lease,crypto-port,custody-crypto,custody-session,device-unlock,import-scan,key-cache,local-codex-revision,startup,step-credit-key}.test.js
cat src/vault/engine/{audit,bindings,c1-claude-lease,client-crypto,custody-crypto,custody-session,import-scan,key-cache,startup,step-credit-key,types,api}.js
cat src/lib/keychain.js src/runtime/broker/c1-child.js tests/vault/engine/_helpers/mock-server.js
awk 'NR<=78 || (NR>=1255 && NR<=1408) || (NR>=2074 && NR<=2112) || NR>=2734 {print NR ":" $0}' src/vault/credential-domain/local-codex.js
node "$MC_SCRATCH/reconcile-vault.mjs"
```

The scratch reconciler checks exact twelve-member order, stamped/tracked path
existence, and byte equality of the map except these twelve status cells.
It is delivery evidence, not a new tracked scanner. Command/output retained in
`$MC_SCRATCH/reconcile-vault.log`; the goal log supplies its absolute path.

## Cost and execution accounting

All twelve use the existing package test inventory, dynamic affected selection
and `tests/_isolate-home.mjs`; there is no new resource registry or lane.
The preload isolates HOME, TMPDIR, MC_HOME and work-root state, and cleans its
temporary root. The supplied dependencies avoid real keychain calls. Real file
fixtures use temporary directories, not repository/production secrets. C1 tests
call only pure helpers and read source bytes; they do not invoke the lease.

For **every subject**, baseline/candidate callback cost, setup, startup-inclusive
file wall, selected subject-round cost and fault/restored-run timings are
**NOT MEASURED**. No speedup or one-second compliance is claimed. The crypto
file's comment says the 600k path takes approximately a second; that is an
undated source observation, not a measurement. Its vectors say captured from
browser source on 2026-05-31; no browser revision/recapture receipt is supplied.
The earlier gateway goal's retained log describes different tests/transport
faults at `115269332d1e9dc0f67f64daa3501eaa19c9b2d5`, landed as
`031227001d21dcaff9ff7e68089a37fde9a5789b`; none of that cost or fault evidence
is transferred to vault subjects. This goal's activation log contains no vault
runtime evidence. Missing subject evidence remains missing.

Document delivery alone runs ordinary `mc gate`; if it defers anything,
`mc gate --whole-selection` is required for complete affected acceptance.
The completed log/receipt and separately available callback/file/round clocks
belong in the final delivery log/PR. A documentary affected green is not a vault
subject pass unless that subject actually ran, nor a fault/restoration proof.

### Common future contract rules (apply to each numbered entry)

Only after separately commissioned work: use Node >=22 and normal mc dependency
attachment; synthetic material only, no OS secrets, native provider, network,
server provisioning or new lane/framework. Use `mc gate <exact-file>` given
below; never substitute bare `node --test`. Each proposed source fault is replayed
one at a time in an exact-judged-SHA disposable scratch worktree following mc's
independent replay guidance. Record clean HEAD/status, source delta, exact
command and relevant assertion failure, restore exact source, rerun that same
command and require completed GREEN. Import/setup failure is not fault proof.
Measure callback, fixture/setup, startup-inclusive file wall if available and
round separately, including first consumers; absent clocks stay NOT MEASURED.
Retain current thresholds and final complete affected acceptance. If a proposed
assertion stays green, report the negative and strengthen the named local
contract through planning; do not delete protection or broaden the campaign.
All recommendations retain current unique assertions until replacement evidence
and any necessary risk decision are accepted. No protection is lost here.

## 1. audit.test.js — KEEP

**Path:** `tests/vault/engine/audit.test.js`.
**Fault/consequence:** exposure audit reads/echoes credential contents, follows a
symlink, or deletes metadata while an artifact still exists: secrets leak or
leftovers become undiscoverable.

**Actual protection/boundary:** seven async cases call real `auditVaultExposure`
with temporary manifests/files and real filesystem operations. They assert one
leftover, correct label/state, sentinel absent from serialized result and artifact
still present; absent destinations permit manifest-only removal; destination and
manifest symlinks are not followed/removed; a second lstat sees a raced destination
and retains the manifest; unknown hostile fields return `manifest-invalid-shape`
without their value; env names/settings are `unknown` and not lstat targets.
The first test's injected `readManifest` verifies only that seam's path; absence
of output is not exhaustive proof that no alternate read occurred. Source uses
O_NOFOLLOW, a 256 KiB limit and metadata-only lstat. Oversize/unreadable paths and
the final revalidation-to-unlink race are not comprehensively exercised.

**Overlap/level:** import scan also checks output secrecy, but necessarily reads
input values; it cannot replace metadata-only audit and cleanup evidence. Cheapest
credible level is this real temporary-filesystem helper integration, with injected
lstat only for deterministic race scheduling. No database/browser needed.

**Next contract:** retain all cases in this file. Future validation command:
`mc gate tests/vault/engine/audit.test.js`. In `src/vault/engine/audit.js`, remove
the `destinationsStillAbsent` condition: expect the existing revalidation case's
`cleanup_state === 'uncertain'`/manifest-exists assertion to fail; restoring it
must pass. Requires writable temp storage and symlink support; no credential
or live session. Runtime/fault proof remains UNRUN, not a deletion recommendation.

## 2. bindings.test.js — REBUILD the value-free fixture, keep metadata behaviour

**Path:** `tests/vault/engine/bindings.test.js`.
**Fault/consequence:** extra secret-bearing input survives binding normalization,
or merge/filter exposes another repo's label: committed metadata can leak values
or a consumer can select the wrong credential.

**Actual protection/boundary:** real temporary `.mc/secrets.json` is created and
parsed equal to the metadata-only input; merge retains two distinct sources and
both labels; exact filter results admit one repo label and no labels for an
unbound repo. However `sk-live-secret-value`, asserted absent in the saved file,
is never supplied to the mechanism. That assertion alone has no leak-sensitive
canary. `normaliseSource` currently allowlists metadata; atomic temp-file rename
is real, but crash/permission errors and same-source merge are not tested here.

**Overlap/level:** import-scan tests construct deterministic binding previews but
do not persist/merge them; they cannot replace this disk boundary. These helpers
are legacy metadata support, not authorization to reactivate plaintext bindings:
current `cmdBind`/`cmdSet --bind` refuse, import dry-run removes `binding`, and
`bindingPlan` is null in current set. No retirement without a consumer/risk decision.

**Executable rebuild contract:** change only this test's persistence fixture in
future, feeding an extra source property such as `values: { OPENAI_API_KEY:
'fixture-secret-canary' }`; expect saved JSON equal to the normalized metadata-only
shape and no canary. Retain merge/filter cases, including exact members.
Command: `mc gate tests/vault/engine/bindings.test.js`. Fault in
`src/vault/engine/bindings.js`: spread the incoming source into `normaliseSource`'s
return before its normalized fields. Expect persisted canary/extra-property
assertion failure, then restored pass. Existing first test need not catch that
fault because its fixture contains only metadata. Requires temp FS only. No new
CLI materialisation flow, value registry or scanner. Fault proof/cost UNRUN.

## 3. c1-claude-lease.test.js — KEEP scoped parser/scanner and trust pin evidence

**Path:** `tests/vault/engine/c1-claude-lease.test.js`.
**Fault/consequence:** accepting a foreign payload/report or missing a credential
split across output chunks can export reusable authority; launching unreviewed
child bytes changes the credential recipient.

**Actual protection/boundary:** four cases assert exact payload token bytes,
reject tool/extra-field/unknown OAuth-field variants, accept known optional fields,
require envelope class and fixed label, parse only schema-1/status-only reports,
reject extra report fields/schema-2/non-JSON, and detect split raw/base64/hex/URI/
JSON representations. The last case hashes actual `c1-child.js` and compares the
lease's SHA-256 pin. This is an explicit recipient-integrity contract, not a
cosmetic source pin. `clear()` is called but its reset semantics are not asserted;
the ASCII canary does not prove split multibyte decoding or all output encodings.

The full lease implementation selects one envelope, verifies closure/child hash,
spawns a fixed child with fd 3 and restricted env, caps output and kills its group.
**This file does not execute any of that orchestration**. It does not prove process
isolation, child credential delivery, timeout/kill acknowledgement, installed
artifact validity or end-to-end non-disclosure. Child source inspection is not
runtime evidence for its dynamic harness or real provider.

**Overlap/level:** custody-crypto proves class AAD; it does not enforce C1's exact
payload/report schemas or cross-chunk scanner. Keep pure direct helpers plus one
real byte hash as cheapest credible level for these promises. Larger transport/
isolation evidence needs its own commission, not a mock lease that claims it.

**Next contract:** `mc gate tests/vault/engine/c1-claude-lease.test.js`.
In `src/vault/engine/c1-claude-lease.js`, discard the retained tail in scanner
`push`: the second chunk must stop returning true in the existing scanner case.
Restore and require green. A pin-drift validation may change only the pin (not
execute/edit child behaviour) and must fail actual hash equality. Uses source
reads and synthetic buffers only. No lease/provider invocation authorized here;
missing orchestration evidence stays an explicit planning input.

## 4. crypto-port.test.js — KEEP real WebCrypto and compatibility vectors

**Path:** `tests/vault/engine/crypto-port.test.js`.
**Fault/consequence:** KDF/encoding/cipher drift strands stored vault data or
breaks compatibility. Matching encrypt/decrypt bugs can conceal drift in a round-trip.

**Actual protection/boundary:** eight cases pin `PBKDF2_ITERATIONS` to 600,000,
check fixed auth hashes at the production default and at one iteration, assert
fixed-key/IV AES-GCM ciphertext, round-trip ASCII/Unicode/empty/4 KiB payloads,
label plus JSON wire shape, exact base64 byte members, and distinct ciphertext/IV
for two random encryptions. Real Node WebCrypto is used, not a crypto substitute.
The auth-hash golden does not independently pin the returned first-half vault key;
the fixed AES test imports a separate key. Distinct random results are a smoke
check, not statistical entropy proof. Browser-source capture lacks a stamped
browser revision; no browser runs here and no current browser parity is certified.

**Overlap/level:** custody tests reuse this payload cipher but add key wrapping and
AAD. Round-trips there cannot replace these independent format oracles. Cheapest
credible level is direct real WebCrypto with the production-default KDF kept once;
do not lower it or move its work outside accounting to make a timing target.

**Next contract:** preserve file and goldens; command
`mc gate tests/vault/engine/crypto-port.test.js`. Fault
`src/vault/engine/client-crypto.js` default constant to 599,999: constant and
default auth-hash assertions should fail. Restore exact source and require green;
never regenerate expected values to hide drift. Prerequisite Node WebCrypto,
no browser/service. Separately commission provenance/KUK-vector evidence if parity
scope expands. Callback/setup/file/round and fault proof remain NOT MEASURED/UNRUN.

## 5. custody-crypto.test.js — KEEP real authenticated hierarchy and wire oracle

**Path:** `tests/vault/engine/custody-crypto.test.js`.
**Fault/consequence:** class/domain confusion permits repurposing a secret or
recovery wrap; key hierarchy/format changes make existing ciphertext unreadable.

**Actual protection/boundary:** eleven cases use real WebCrypto: mint/unwrap CRK
then decrypt with the resulting key; class/schema and plaintext round-trip;
label-only selection succeeds with damaged payload while full decryption rejects;
class repurposing, wrong KEK, modified wrap and unknown class reject; 16-byte raw
keys reject and generated keys have 32 bytes; fixed wrap ciphertext/IV is pinned;
rotation preserves old envelope readability and recovery uses a distinct AAD;
recovery codes match grouped alphabet and differ; legacy/null/empty-wrapped-DEK
rows are not envelopes. No server, transactional rotation, KDF recovery ceremony
or statistically demonstrated entropy is exercised. The code uses modulo mapping
for recovery characters; the shape/difference test is not a cryptographic analysis
of its distribution despite its test title saying high-entropy.

**Overlap/level:** crypto-port's AES vectors protect payloads, not wrap AAD;
local-codex and session tests consume wraps but would miss coordinated format
changes. Cheapest credible evidence is this direct real-crypto layer and stable
wire vector. Keep the independent oracle and rejection assertions.

**Next contract:** `mc gate tests/vault/engine/custody-crypto.test.js`.
Fault `src/vault/engine/custody-crypto.js` `dekAad` to ignore class: existing
repurposed-class rejection must fail (decryption resolves). Restore and require
green. Requires Node WebCrypto only; no server/real recovery material. No existing
run or fault evidence available here; costs remain NOT MEASURED.

## 6. custody-session.test.js — REBUILD race-key identity evidence

**Path:** `tests/vault/engine/custody-session.test.js`.
**Fault/consequence:** a losing adopter returns its unpersisted CRK rather than the
winner's; subsequent writes look successful but other devices cannot decrypt them.

**Actual protection/boundary:** five cases assert adoption stores wrap in a JS
state object and next call says not adopted; a simulated set-if-absent loss
returns `ok: true, adopted: false`; wrong KUK gives `crk-unwrap-failed`;
`encryptForWrite` emits decryptable schema-2 camelCase body with CRK or decryptable
legacy body without one. Stub storage/re-read simulates the race; it proves no
server uniqueness or transaction semantics. The race case never uses `res.crk`,
so its flags can be correct while the actual returned key is wrong.

**Overlap/level:** custody-crypto pins wrapping/rotation, not API orchestration or
winner identity. Keep its independent round-trips; consolidate neither away.
Cheapest credible level is current real crypto plus controlled API race responses,
not a database fixture or a second in-memory SQL model.

**Executable rebuild contract:** extend only the existing race fixture/case to
retain the winner's `crk`, encrypt a synthetic envelope with it, and assert the
race result's `crk` decrypts the same label/data. Keep existing result/adoption
and schema assertions. Command: `mc gate tests/vault/engine/custody-session.test.js`.
Fault `src/vault/engine/custody-session.js` race-success branch to return
`minted.crk` with `adopted: false`. New usability assertion must reject/fail;
old flags alone can pass. Restore and require green. Node WebCrypto and inline
stub only. No claim of real set-if-absent persistence; future server proof is a
separate resource/planning decision. Fault proof/timings UNRUN/NOT MEASURED.

## 7. device-unlock.test.js — KEEP durable-vs-legacy decision boundary

**Path:** `tests/vault/engine/device-unlock.test.js`.
**Fault/consequence:** treating a durable device entry as TTL-only locks out an
approved device; treating a legacy TTL as durable preserves stale unlock authority.

**Actual protection/boundary:** Map-backed keychain, injected time, fixed synthetic
32-byte key; durable entry still reads after one simulated year with
`durable: true`, exact authHash/deviceId and null expiry. Legacy reads as non-durable
with null authHash, then returns null after sixteen simulated minutes. This is
cache policy, not real device registration/revocation, OS keychain durability,
TouchID or persisted storage across process restarts. Date.now seeds the clock;
no year-long real wait occurs.

**Overlap/level:** key-cache also covers a durable encoding path and TTL expiry;
this file uniquely stresses the far-future durable/legacy distinction and metadata
cohesion. Keep both now; sharing fixture boilerplate cannot justify losing either
boundary. Cheapest credible level: direct cache helper and in-memory keychain
with deterministic advancement, no native keychain/service.

**Next contract:** `mc gate tests/vault/engine/device-unlock.test.js`.
Fault `src/vault/engine/key-cache.js` to always write a TTL expiry even when
`durable` is true. Existing far-future `assert.ok(read)` must fail. Restore and
require green. Node WebCrypto for imported key; no actual device or OS secrets.
Runtime/fault evidence UNRUN, all cost clocks NOT MEASURED.

## 8. import-scan.test.js — KEEP value-free metadata and ambiguity decisions

**Path:** `tests/vault/engine/import-scan.test.js`.
**Fault/consequence:** expansion/output of input secrets leaks them; duplicate
keys or misleading metadata can bind an unintended credential.

**Actual protection/boundary:** seven cases cover parsing exported/quoted/plain
values, comments, literal dollar reference, invalid line and exact source lines;
classification of public/secret names, credential-bearing URL, path/key/user/
issuer IDs and redirect URI; real temp-file scan returns only names/metadata with
no canary or value field; dry-run selects exact high-confidence secrets, normalized
repo labels and metadata binding with `writes: []`; duplicate names produce exact
warning/lines, neither duplicate selected/bound and neither secret output.
Pure parser intentionally returns raw values internally: only scan/dry-run are
value-free promises. Not a universal secret detector; public-prefix precedence,
malformed quoting and many I/O failures remain outside these fixtures.

**Overlap/level:** bindings persists metadata, whereas this file reads plaintext
and strips it from output; startup forbids materialisation and does not test
parsing. Current CLI strips this helper's binding preview before output; this
legacy internal preview is not permission to materialise it. Cheapest credible
level: direct parser/classifier plus minimal real input files, no CLI spawn.

**Next contract:** `mc gate tests/vault/engine/import-scan.test.js`.
Fault `src/vault/engine/import-scan.js` selection to ignore duplicate count:
existing duplicate candidate tuples and binding-member assertions must fail.
Independent output fault: include `value: entry.value` in `scanDotenvContent`
metadata; sentinel/value-field assertions must fail. Restore each and require
green. Temp FS and synthetic values only. No new heuristic/scanner scope or
measurement authorized here; fault proof UNRUN and costs NOT MEASURED.

## 9. key-cache.test.js — KEEP validation, legacy decoding and macSet seam

**Path:** `tests/vault/engine/key-cache.test.js`.
**Fault/consequence:** corrupt/expired entries become authority, encoding rejects
legitimate durable entries, or cache identity chooses another account's key.

**Actual protection/boundary:** exact account name/suffix; byte-for-byte cache read
and CryptoKey presence; bad input rejects; write failure returns false; durable
cache passes real `macSet` validation with fake exec and reads back key/auth/device;
old plain JSON remains usable/not deleted; expiry clears store and pre-expiry
hits; malformed JSON/base64 wrapper, missing fields and wrong decoded length
return null (selected corrupt cases also assert deletion/reason); inspection
reports expiry/absence/missing-key/wrong-length; clear is idempotent. Inspection's
"without importing" title is not accompanied by an import-call trap. Exact expiry
at now, identity isolation across multiple stored accounts and read/delete failure
branches are not all demonstrated by these fixtures.

**Overlap/level:** device-unlock supplies the one-year policy boundary; this file
uniquely checks b64-prefix compatibility with actual `macSet` guard and legacy JSON.
Fake exec extracts the stdin string; it does not run `security -i`, prove quoting
semantics, OS access control or persistent keychain storage. Cheapest credible
level is direct cache + real guard with controlled exec; do not require OS prompts.

**Next contract:** `mc gate tests/vault/engine/key-cache.test.js`.
Fault `src/vault/engine/key-cache.js` `encodeCacheRecord` to return raw JSON:
the durable-through-real-macSet case must fail `ok === true` because the guard
rejects quotes. Restore and require green. Also removing expired clearing must
fail store-size assertion, not merely an unrelated import. Node WebCrypto, Maps
and synthetic strings only; no real keychain. Fault proof UNRUN/cost NOT MEASURED.

## 10. local-codex-revision.test.js — KEEP opaque-token and no-retry evidence

**Path:** `tests/vault/engine/local-codex-revision.test.js`.
**Fault/consequence:** substituting numeric revision, blind writes or retrying a
conflict overwrites a concurrent refreshed credential and can lose authentication.

**Actual protection/boundary:** three cases use real encrypted tool-auth envelopes
and a controlled API. Success sends precisely initial lowercase-hex row token
(not numeric 7), lists once and decrypts to fresh auth. Simulated 409 sets a winner;
result refuses with `managed-domain-custody-revision-conflict`, no persisted flag,
one update carrying original token, one list, exact winner wire object and
winner plaintext. Undefined/empty/numeric/malformed/uppercase tokens refuse with
`managed-domain-custody-revision-required`, zero updates and unchanged wire.
This is client decision plus crypto evidence; the JS fixture implements the
conflict itself. It proves no database trigger, transaction, real concurrency,
HTTP status delivery or deployed migration. Current shared mock is not used here.

**Overlap/level:** custody-session tests encryption dispatch, not row-token
propagation. API wrapper's `requireRowRevision` enforces transport inputs, but
this test injects `api.updateSecret` and therefore independently protects this
caller's choice/no-retry. Cheapest credible level is current direct caller with
real crypto and stub external API. Keep exact wire/attempt assertions, not just
`ok: false`. Production rollout prerequisites remain with Martin as documented in
`vault-revision-rollout.md`.

**Next contract:** `mc gate tests/vault/engine/local-codex-revision.test.js`.
Fault `src/vault/credential-domain/local-codex.js` persist body's
`expectedRevision` to `wire.revision`: exact updates assertion must fail (7 vs
opaque token). Restore and require green. A retry fault needs the existing
conflict attempt-count/winner assertions to fail; no real server required.
Node WebCrypto and inline fake API only; no installed Codex or native boundary
needed for this function. Other native-domain code is not certified. Evidence
UNRUN and cost NOT MEASURED, including that large module's import/setup footprint.

## 11. startup.test.js — REBUILD output-denial proof, keep no-materialisation

**Path:** `tests/vault/engine/startup.test.js`.
**Fault/consequence:** a managed launch prompts/unlocks/materialises plaintext or
prints credential-bearing output into a model-controlled session.

**Actual protection/boundary:** two cases assert unlock offer/prompt false even
with TTY, install throwing materialise/unlock/prompt deps and assert the exact
credential-blind result with empty materialised list and disabled reason. Current
`startup.js` is a no-op policy boundary. The second title says it forbids output
deps, but supplies no output dependency/trap. A direct console/stdout write can
pass it. These direct functions do not prove every managed launch routes through
them, or sandbox/process isolation. Search finds no current source caller of
`materialiseVaultBeforeLaunch`; retain fail-closed API protection pending planning,
not a claim of essential-journey coverage.

**Overlap/level:** C1/billing readers legitimately open fixed trusted credentials;
they cannot replace this general startup refusal. Cheapest credible level is
current direct API calls and Node's existing test mocking for output sinks, not
an interactive process/provider or synthetic browser.

**Executable rebuild contract:** extend these cases in the same file to trap
`defaultPromptUnlock`'s explicit output writer and scoped console/stdout/stderr
writes around the managed materialisation call, restoring mocks via test cleanup.
Retain throwing credential deps and exact response. Command:
`mc gate tests/vault/engine/startup.test.js`. Deliberate source fault in
`src/vault/engine/startup.js`: write a synthetic marker to the explicit prompt
output, and independently add a stdout write to materialisation. New output
assertions must fail; restore each and require green. Use only Node built-in
scoped mocks/capture, no new permanent harness or real prompt. Existing tests
alone may pass these output faults; that is the gap, not observed fault evidence.
All proposed work UNRUN and cost NOT MEASURED.

## 12. step-credit-key.test.js — REBUILD selection-minimization evidence

**Path:** `tests/vault/engine/step-credit-key.test.js`.
**Fault/consequence:** a fixed billing-key reader opens unrelated secrets, selects
a foreign provider/class, accepts ambiguous records or leaks key material on failure.

**Actual protection/boundary:** real encryption with an in-memory API fixture;
fixed Anthropic/OpenAI labels, Codex-only matching and provider mismatch/unknown
provider; envelope/legacy/no-root success; retired label and other class ignored;
missing/ambiguous matches refused; no-cache refuses before requests; bad auth
refused; OAuth/whitespace payloads unreadable without echo; key bytes zeroed;
throwing API converted to redacted failure; failed reason excludes key.
Exports and function arity are checked, and a regex pins literal `deps.*` names to
three allowed seams. Those narrow authority constraints are useful but arity does
not prove no caller-controlled label, and regex is not exhaustive dataflow proof.
The unrelated envelope fixture has a valid payload, so a reader that decrypts
all payloads during label selection can still pass. Fixture Map/arrays and fake
fetch do not establish server persistence, account separation or real transport.

**Overlap/level:** custody-crypto already asserts label-only decryption tolerates
a damaged payload; it cannot prove this billing consumer actually uses that
boundary. Billing gateway grant/expiry/shared-budget tests landed separately and
do not demonstrate fixed vault lookup. Keep the real cipher plus in-process API
integration as cheapest credible level. Source/export restrictions stay until a
separate reviewed authority-contract decision; no widening seams or label API.

**Executable rebuild contract:** in this file reuse setup and real envelopes;
supply an unrelated row whose `encrypted_data` access is counted at the
`listSecrets` return seam, after the mock's cloning/serialization, and assert
zero payload accesses while the fixed-label row still yields its key.
Also pass attempted caller `label`/provider-label override fields alongside the
normal options and assert they cannot select the unrelated row. Preserve legacy,
class, ambiguity, redaction and zeroing assertions; do not replace them with a
model of decryption. Command: `mc gate tests/vault/engine/step-credit-key.test.js`.
Fault `src/vault/engine/step-credit-key.js` envelope selection to call full
`decryptEnvelopeSecret` rather than `decryptEnvelopeLabel`: the new access-count
assertion must fail even if the correct key is ultimately returned. Restore and
require green. A caller-label fault should fail the fixed-key result assertion;
keep it local to the existing reader contract. Node WebCrypto/current mock only,
no gateway socket, real vault or provider. Fault proof and all costs UNRUN/
NOT MEASURED. No runtime-saving claim: this rebuild increases evidence precision,
not measured work reduction.

## Planning handoff

Commission the four named rebuilds only if accepted in independent review. Keep
all twelve files and unique checks meanwhile. Prioritise race-key identity and
credential-minimization/output faults by consequence, not test count. The eight
KEEP decisions retain existing mechanisms; their proposed validation faults are
future evidence specifications, not required implementation churn or permission
for an unbounded mutation campaign. Any broader C1/native isolation, browser
parity, OS keychain or server transaction evidence requires its own scoped
resources/contract. No residual risk, retirement or estate completion is accepted.
