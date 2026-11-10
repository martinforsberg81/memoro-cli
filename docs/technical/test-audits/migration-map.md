# Test-estate migration map: memoro-cli

Snapshot examined at HEAD `31fe61a931a120c3ec111e4cd32cb088ae48a7f3` on 2026-11-04. Inventory and sequencing only; not certification, migration verdict or authority to change protection.

## Snapshot method and reconciliation

Membership uses tracked paths, never a filesystem walk:

```sh
git rev-parse HEAD
git ls-files '*.test.js' '*.test.mjs' '*.test.cjs' '*.check.js' '*.check.mjs' '*.check.cjs'
cat package.json
npm run test:affected -- --why
git ls-files .github/workflows/*
git ls-files scripts/*test* scripts/*check*
cat docs/technical/mc-gate-evidence.md
```

The suffix inventory yields **171** unique tracked subjects: 171 .test.* paths and 0 .check.* paths. Paths in “Prior audit subjects” plus numbered batch tables form the complete inventory; every path is listed once. Domain is the existing first-level test area (or SDK check directory); lexical ordering makes batch membership stable at this revision. Batch maximum 12 is an audit-planning boundary only.

At this revision npm run test:affected -- --why reported 0 of 171 test files selected for the clean worktree from zero changed paths. This is selector output, not a full suite or registry classification. package.json test glob is tests/**/*.test.js. No tracked .check.* path or .github/workflows/* workflow was found.

### Package scripts examined

| Script | Existing command |
| --- | --- |
| test | node --test --import ./tests/_isolate-home.mjs --test-timeout=30000 'tests/**/*.test.js' |
| test:affected | node scripts/affected-tests.js --why |
| smoke:mc | node scripts/mc-release-smoke.js |
| security:credential-boundary | node scripts/security/credential-boundary-probe.mjs |

### Existing evidence lanes and per-subject accounting

Finish reconciliation at document head `1c866e4e00161143793bdb1eac19ac572f7834d2` inspected `package.json`, `scripts/affected-tests.js` and the tracked subject inventory. These inputs have not changed from the snapshot above. Every one of the 171 subject rows is linked to the existing package `test` command (Node test runner with `tests/_isolate-home.mjs` and the existing 30,000 ms timeout); `test:affected` chooses change-dependent members of this same inventory through import, pin and data edges with conservative fallback. There is no Memoro-style runtime/resource/profile registry in this repository: no hermetic, browser, SQLite or heavy classification is invented from a subject's name or domain. The isolated-home preload is a declared setup boundary, not proof that a test uses no other resources.

| Existing execution surface | Membership and boundary |
| --- | --- |
| package test | All 171 exact subject paths below; Node runner and isolated-home preload. |
| package test:affected | Dynamic subset of those subjects; not a separate static classification. The reviewed document head selected 5/171; the earlier 0/171 clean-tree observation above remains historical. |
| package smoke:mc | Packaged CLI smoke driver listed below; separate opt-in execution, NOT RUN. |
| package security:credential-boundary | Credential-boundary probe listed below; separate opt-in execution, NOT RUN. Its Node test subject remains in the 171-row inventory. |

Each domain batch can therefore be grouped by these existing boundaries using its execution-metadata column. More detailed mechanism/resource grouping requires the later body/fixture audit; this map neither asserts that all 171 are cheap unit tests nor promotes opt-in evidence into an ordinary gate. All unreviewed statuses and the six historical recommendations across both reports are retained.

### Other discovered executable lanes

Accounted for, not inventory subjects unless separately listed below:
- `scripts/affected-tests.js` — affected-test selector (`test:affected`).
- `scripts/mc-release-smoke.js` — opt-in packaged CLI smoke (`smoke:mc`).
- `scripts/security/credential-boundary-probe.mjs` — opt-in security probe (`security:credential-boundary`), outside the test glob.

Tracked CI workflow paths: none.

### Workflow reconciliation

No tracked `.github/workflows/*` entrypoint exists in this repository. The executable test surfaces are the package `test` and `test:affected` scripts, plus `smoke:mc` and `security:credential-boundary` opt-in scripts listed above; they were not run as part of this snapshot.

### Discovery boundary and exclusions

- Subject inventory includes every tracked .test.js/.mjs/.cjs and .check.js/.mjs/.cjs; helpers, fixtures, scripts and workflows are dependencies or executable lanes, not test subjects.
- Package scripts, workflow paths, existing inventory/selector, manual-check documentation and named browser/live/evaluation/performance commands were reconciled. Unreferenced ad-hoc scripts and external operator invocations remain a discovery gap; absence of a naming match is not an exclusion or certification.
- Opt-in browser, live-provider, AI evaluation, performance, smoke and release probes retain their existing lanes and prerequisites; none ran for this documentary snapshot.
- The approved strategy actually read is memoro-cli/canon/tasks/references/test-strategy.md; the goal document’s former canon/skills/writing-tests/references/test-strategy.md path is absent at examined CLI HEAD. The tracked risk-based strategy content is used here.

## First bounded audit: recommendations only

The repository’s first-batch report is historical evidence. Its runtimes are not new measurements. Six decisions across the companion reports remain recommendations; none authorises edits, retirements, selection narrowing or accepted residual risk.

## Complete tracked path inventory and bounded batches

Every suffix-matched path appears exactly once. UNREVIEWED means no value-audit or keep/rebuild/consolidate/retire conclusion is claimed. Prior subjects carry only their named first-batch recommendation. Shared fixture dependencies are notes, not subjects or counted in batch size.

### Prior audit subjects

| Path | Recommendation only | Status | Existing execution metadata |
| --- | --- | --- | --- |
| tests/mc/canon-text.test.js | REBUILD, retaining structural delivery checks | Prior bounded audit subject; no migration decision or protection change. | package test; affected selection dynamic; isolated home |
| tests/mc/roles-decisions.test.js | CONSOLIDATE, preserving unique guidance | Prior bounded audit subject; no migration decision or protection change. | package test; affected selection dynamic; isolated home |
| tests/mc/branch-landed.test.js | REBUILD cost hotspots; keep real Git evidence | Prior bounded audit subject; no migration decision or protection change. | package test; affected selection dynamic; isolated home |

> **Superseded 2026-11-10.** The branch-landed row's "keep real Git evidence" is superseded by #1410 and by the modelled-Git rule in [mc-codebase.md](../mc-codebase.md) (Martin, 2026-11-09): routine suites model Git; real Git is proved only by a commissioned, bounded, isolated probe. The row above is kept as written.

### First three risk-prioritised follow-up batches

No batch authorises protection changes; each stays unreviewed until separately audited.
- **CLI-tests-mc-001** — core-command behavior and guidance delivery. The first audit found overlapping authored-guidance assertions; trace delivery separately from command decisions and preserve the non-AI evaluation boundary.
- **CLI-tests-vault-001** — credential/recovery/device-state consequences make this a security-priority area under the approved strategy.
- **CLI-tests-adapters-001** — inspect existing tool-boundary behavior and fixture reuse without substituting boundary evidence with a new lane.

Shared fixture dependency (not a subject): tests/_isolate-home.mjs, plus helpers actually traced for a chosen batch. First-batch setup/Git timings are historical; no new measurement made.

Sequencing context from the prior bounded audit: the `branch-landed.test.js` callbacks were 1,274 ms and 1,668 ms, and the report recorded 193 Git calls; template/copy/OS-probe startup was not isolated. `canon-text.test.js` and `roles-decisions.test.js` contain overlapping authored-guidance assertions as well as distinct obligations. These are historical observations and an inspected overlap, not timings or verdicts for the three remaining batches. Retain the first-batch cost and overlap recommendations before any retirement decision.

### Unreviewed batches

#### CLI-tests-adapters-001 · tests/adapters · 5 subject(s)

| Path | Status | Existing execution metadata |
| --- | --- | --- |
| tests/adapters/codex-hooks.test.js | KEEP; [static cleanup audit, safety contract H](audit-adapters-001.md#1-codex-hookstestjs--keep-selective-filesystem-cleanup); runtime NOT MEASURED | package test; affected selection dynamic; isolated home |
| tests/adapters/get-status-contract.test.js | KEEP; [static status/presence audit](audit-adapters-001.md#2-get-status-contracttestjs--keep-cheap-status-decisions); runtime NOT MEASURED | package test; affected selection dynamic; isolated home |
| tests/adapters/managed-runtime/claude-managed-custody.test.js | KEEP crypto/CAS checks; REBUILD lease proof; [static evidence, contract C](audit-adapters-001.md#3-claude-managed-custodytestjs--keep-security-checks-rebuild-lease-proof); runtime NOT MEASURED | package test; affected selection dynamic; isolated home |
| tests/adapters/materialise.test.js | KEEP active refusal; [static evidence and legacy-skip gaps, contract M](audit-adapters-001.md#4-materialisetestjs--keep-active-plaintext-refusal-not-legacy-green); runtime NOT MEASURED | package test; affected selection dynamic; isolated home |
| tests/adapters/model-args.test.js | KEEP; [static argv/overlap audit](audit-adapters-001.md#5-model-argstestjs--keep-exact-native-argv-contracts); runtime NOT MEASURED | package test; affected selection dynamic; isolated home |

#### CLI-tests-lib-001 · tests/lib · 2 subject(s)

| Path | Status | Existing execution metadata |
| --- | --- | --- |
| tests/lib/device-flow.test.js | UNREVIEWED | package test; affected selection dynamic; isolated home |
| tests/lib/keychain.test.js | UNREVIEWED | package test; affected selection dynamic; isolated home |

#### CLI-tests-mc-001 · tests/mc · 12 subject(s)

| Path | Status | Existing execution metadata |
| --- | --- | --- |
| tests/mc/affected-tests.test.js | [REBUILD recommendation inspected](audit-mc-001.md#1-affected-teststestjs--rebuild-conservative-edge-evidence); focused run only, fault proof unrun; no protection change | package test; affected selection dynamic; isolated home |
| tests/mc/archive-plan.test.js | [KEEP recommendation inspected](audit-mc-001.md#2-archive-plantestjs--keep-pure-retention-and-history-rules); focused run only, fault proof unrun; no protection change | package test; affected selection dynamic; isolated home |
| tests/mc/archive-programme.test.js | [REBUILD recommendation inspected](audit-mc-001.md#3-archive-programmetestjs--rebuild-consumer-refusal-evidence); focused run only, fault proof unrun; no protection change | package test; affected selection dynamic; isolated home |
| tests/mc/asc-build-device.test.js | [KEEP recommendation inspected](audit-mc-001.md#4-asc-build-devicetestjs--keep-device-decisions-and-orchestration); focused run only, fault proof unrun; no protection change | package test; affected selection dynamic; isolated home |
| tests/mc/asc-build-testflight.test.js | [KEEP recommendation inspected](audit-mc-001.md#5-asc-build-testflighttestjs--keep-consent-exported-revision-and-upload-checks); focused run only, fault proof unrun; no protection change | package test; affected selection dynamic; isolated home |
| tests/mc/asc-build.test.js | [KEEP recommendation inspected](audit-mc-001.md#6-asc-buildtestjs--keep-question-declaration-and-seed-decisions); focused run only, fault proof unrun; no protection change | package test; affected selection dynamic; isolated home |
| tests/mc/asc.test.js | [KEEP recommendation inspected](audit-mc-001.md#7-asctestjs--keep-submitrelease-consent-and-declared-script-routing); focused run only, fault proof unrun; no protection change | package test; affected selection dynamic; isolated home |
| tests/mc/await-deploy.test.js | [KEEP recommendation inspected](audit-mc-001.md#8-await-deploytestjs--keep-wait-policy-evidence); focused run only, fault proof unrun; no protection change | package test; affected selection dynamic; isolated home |
| tests/mc/billing-gateway-session.test.js | [REBUILD recommendation inspected](audit-mc-001.md#9-billing-gateway-sessiontestjs--rebuild-bounded-grant-plumbing-evidence); focused run only, fault proof unrun; no protection change | package test; affected selection dynamic; isolated home |
| tests/mc/billing-gateway.test.js | [REBUILD recommendation inspected](audit-mc-001.md#10-billing-gatewaytestjs--rebuild-expiry-and-shared-budget-evidence); focused run only, fault proof unrun; no protection change | package test; affected selection dynamic; isolated home |
| tests/mc/billing.test.js | [KEEP recommendation inspected](audit-mc-001.md#11-billingtestjs--keep-live-storageparser-plus-legacy-decision-protection); focused run only, fault proof unrun; no protection change | package test; affected selection dynamic; isolated home |
| tests/mc/brief-collect.test.js | [KEEP recommendation inspected](audit-mc-001.md#12-brief-collecttestjs--keep-small-shared-reader-checks); focused run only, fault proof unrun; no protection change | package test; affected selection dynamic; isolated home |

#### CLI-tests-mc-002 · tests/mc · 12 subject(s)

| Path | Status | Existing execution metadata |
| --- | --- | --- |
| tests/mc/canon.test.js | UNREVIEWED | package test; affected selection dynamic; isolated home |
| tests/mc/child-async.test.js | UNREVIEWED | package test; affected selection dynamic; isolated home |
| tests/mc/commands/brief.test.js | UNREVIEWED | package test; affected selection dynamic; isolated home |
| tests/mc/commands/deploy.test.js | UNREVIEWED | package test; affected selection dynamic; isolated home |
| tests/mc/commands/deps.test.js | UNREVIEWED | package test; affected selection dynamic; isolated home |
| tests/mc/commands/gate-verdict.test.js | UNREVIEWED | package test; affected selection dynamic; isolated home |
| tests/mc/commands/goal.test.js | UNREVIEWED | package test; affected selection dynamic; isolated home |
| tests/mc/commands/helper.test.js | UNREVIEWED | package test; affected selection dynamic; isolated home |
| tests/mc/commands/hook-install.test.js | UNREVIEWED | package test; affected selection dynamic; isolated home |
| tests/mc/commands/language.test.js | UNREVIEWED | package test; affected selection dynamic; isolated home |
| tests/mc/commands/log.test.js | UNREVIEWED | package test; affected selection dynamic; isolated home |
| tests/mc/commands/plan.test.js | UNREVIEWED | package test; affected selection dynamic; isolated home |

#### CLI-tests-mc-003 · tests/mc · 12 subject(s)

| Path | Status | Existing execution metadata |
| --- | --- | --- |
| tests/mc/commands/roles-cli.test.js | UNREVIEWED | package test; affected selection dynamic; isolated home |
| tests/mc/commands/run-billing.test.js | UNREVIEWED | package test; affected selection dynamic; isolated home |
| tests/mc/commands/run-lanes.test.js | UNREVIEWED | package test; affected selection dynamic; isolated home |
| tests/mc/commands/test-url.test.js | UNREVIEWED | package test; affected selection dynamic; isolated home |
| tests/mc/context-fill.test.js | UNREVIEWED | package test; affected selection dynamic; isolated home |
| tests/mc/conversations-delete.test.js | UNREVIEWED | package test; affected selection dynamic; isolated home |
| tests/mc/conversations-model.test.js | UNREVIEWED | package test; affected selection dynamic; isolated home |
| tests/mc/deploy-gate-wait.test.js | UNREVIEWED | package test; affected selection dynamic; isolated home |
| tests/mc/deps.test.js | UNREVIEWED | package test; affected selection dynamic; isolated home |
| tests/mc/dev-lease.test.js | UNREVIEWED | package test; affected selection dynamic; isolated home |
| tests/mc/dev-open.test.js | UNREVIEWED | package test; affected selection dynamic; isolated home |
| tests/mc/dev-reap.test.js | UNREVIEWED | package test; affected selection dynamic; isolated home |

#### CLI-tests-mc-004 · tests/mc · 12 subject(s)

| Path | Status | Existing execution metadata |
| --- | --- | --- |
| tests/mc/dev-servers.test.js | UNREVIEWED | package test; affected selection dynamic; isolated home |
| tests/mc/docker-command.test.js | UNREVIEWED | package test; affected selection dynamic; isolated home |
| tests/mc/docker.test.js | UNREVIEWED | package test; affected selection dynamic; isolated home |
| tests/mc/docs-measure.test.js | UNREVIEWED | package test; affected selection dynamic; isolated home |
| tests/mc/docs-merge.test.js | UNREVIEWED | package test; affected selection dynamic; isolated home |
| tests/mc/fake-git-default.test.js | UNREVIEWED | package test; affected selection dynamic; isolated home |
| tests/mc/fake-git.test.js | UNREVIEWED | package test; affected selection dynamic; isolated home |
| tests/mc/foreground.test.js | UNREVIEWED | package test; affected selection dynamic; isolated home |
| tests/mc/front-door.test.js | UNREVIEWED | package test; affected selection dynamic; isolated home |
| tests/mc/gate-command.test.js | UNREVIEWED | package test; affected selection dynamic; isolated home |
| tests/mc/gate-fast.test.js | UNREVIEWED | package test; affected selection dynamic; isolated home |
| tests/mc/gate-lane-wait.test.js | UNREVIEWED | package test; affected selection dynamic; isolated home |

#### CLI-tests-mc-005 · tests/mc · 12 subject(s)

| Path | Status | Existing execution metadata |
| --- | --- | --- |
| tests/mc/gate-local.test.js | UNREVIEWED | package test; affected selection dynamic; isolated home |
| tests/mc/gate-lock.test.js | UNREVIEWED | package test; affected selection dynamic; isolated home |
| tests/mc/git.test.js | UNREVIEWED | package test; affected selection dynamic; isolated home |
| tests/mc/goal-archive.test.js | UNREVIEWED | package test; affected selection dynamic; isolated home |
| tests/mc/goals.test.js | UNREVIEWED | package test; affected selection dynamic; isolated home |
| tests/mc/help-routes.test.js | UNREVIEWED | package test; affected selection dynamic; isolated home |
| tests/mc/help-shared.test.js | UNREVIEWED | package test; affected selection dynamic; isolated home |
| tests/mc/help-subcommands.test.js | UNREVIEWED | package test; affected selection dynamic; isolated home |
| tests/mc/help.test.js | UNREVIEWED | package test; affected selection dynamic; isolated home |
| tests/mc/helper-cli-collect.test.js | UNREVIEWED | package test; affected selection dynamic; isolated home |
| tests/mc/helper-collect.test.js | UNREVIEWED | package test; affected selection dynamic; isolated home |
| tests/mc/helper-doc.test.js | UNREVIEWED | package test; affected selection dynamic; isolated home |

#### CLI-tests-mc-006 · tests/mc · 12 subject(s)

| Path | Status | Existing execution metadata |
| --- | --- | --- |
| tests/mc/helper-turn.test.js | UNREVIEWED | package test; affected selection dynamic; isolated home |
| tests/mc/hooks.test.js | UNREVIEWED | package test; affected selection dynamic; isolated home |
| tests/mc/interactive-workspace.test.js | UNREVIEWED | package test; affected selection dynamic; isolated home |
| tests/mc/keys-filter.test.js | UNREVIEWED | package test; affected selection dynamic; isolated home |
| tests/mc/keys-run.test.js | UNREVIEWED | package test; affected selection dynamic; isolated home |
| tests/mc/lane-count.test.js | UNREVIEWED | package test; affected selection dynamic; isolated home |
| tests/mc/lane-pick.test.js | UNREVIEWED | package test; affected selection dynamic; isolated home |
| tests/mc/layout.test.js | UNREVIEWED | package test; affected selection dynamic; isolated home |
| tests/mc/lease-liveness.test.js | UNREVIEWED | package test; affected selection dynamic; isolated home |
| tests/mc/lease-owner.test.js | UNREVIEWED | package test; affected selection dynamic; isolated home |
| tests/mc/log-doc.test.js | UNREVIEWED | package test; affected selection dynamic; isolated home |
| tests/mc/log-read.test.js | UNREVIEWED | package test; affected selection dynamic; isolated home |

#### CLI-tests-mc-007 · tests/mc · 12 subject(s)

| Path | Status | Existing execution metadata |
| --- | --- | --- |
| tests/mc/logger.test.js | UNREVIEWED | package test; affected selection dynamic; isolated home |
| tests/mc/merge-command.test.js | UNREVIEWED | package test; affected selection dynamic; isolated home |
| tests/mc/merge-doc.test.js | UNREVIEWED | package test; affected selection dynamic; isolated home |
| tests/mc/merge-queue.test.js | UNREVIEWED | package test; affected selection dynamic; isolated home |
| tests/mc/merge-watch.test.js | UNREVIEWED | package test; affected selection dynamic; isolated home |
| tests/mc/merger.test.js | UNREVIEWED | package test; affected selection dynamic; isolated home |
| tests/mc/merges-collect.test.js | UNREVIEWED | package test; affected selection dynamic; isolated home |
| tests/mc/model-choice.test.js | UNREVIEWED | package test; affected selection dynamic; isolated home |
| tests/mc/model-config.test.js | UNREVIEWED | package test; affected selection dynamic; isolated home |
| tests/mc/nightly-history.test.js | UNREVIEWED | package test; affected selection dynamic; isolated home |
| tests/mc/nightly.test.js | UNREVIEWED | package test; affected selection dynamic; isolated home |
| tests/mc/page-cache.test.js | UNREVIEWED | package test; affected selection dynamic; isolated home |

#### CLI-tests-mc-008 · tests/mc · 12 subject(s)

| Path | Status | Existing execution metadata |
| --- | --- | --- |
| tests/mc/page-dev.test.js | UNREVIEWED | package test; affected selection dynamic; isolated home |
| tests/mc/page-frame.test.js | UNREVIEWED | package test; affected selection dynamic; isolated home |
| tests/mc/page-goals.test.js | UNREVIEWED | package test; affected selection dynamic; isolated home |
| tests/mc/page-grid.test.js | UNREVIEWED | package test; affected selection dynamic; isolated home |
| tests/mc/page-live.test.js | UNREVIEWED | package test; affected selection dynamic; isolated home |
| tests/mc/page.test.js | UNREVIEWED | package test; affected selection dynamic; isolated home |
| tests/mc/paths-layout.test.js | UNREVIEWED | package test; affected selection dynamic; isolated home |
| tests/mc/prepare-cache.test.js | UNREVIEWED | package test; affected selection dynamic; isolated home |
| tests/mc/programmes-dormant.test.js | UNREVIEWED | package test; affected selection dynamic; isolated home |
| tests/mc/project-convert.test.js | UNREVIEWED | package test; affected selection dynamic; isolated home |
| tests/mc/publish.test.js | UNREVIEWED | package test; affected selection dynamic; isolated home |
| tests/mc/push-guard.test.js | UNREVIEWED | package test; affected selection dynamic; isolated home |

#### CLI-tests-mc-009 · tests/mc · 12 subject(s)

| Path | Status | Existing execution metadata |
| --- | --- | --- |
| tests/mc/repo-freshen.test.js | UNREVIEWED | package test; affected selection dynamic; isolated home |
| tests/mc/repo-gate-table.test.js | UNREVIEWED | package test; affected selection dynamic; isolated home |
| tests/mc/repo-gate.test.js | UNREVIEWED | package test; affected selection dynamic; isolated home |
| tests/mc/repo-lease.test.js | UNREVIEWED | package test; affected selection dynamic; isolated home |
| tests/mc/repo-merge-live.test.js | UNREVIEWED | package test; affected selection dynamic; isolated home |
| tests/mc/repo-merge.test.js | UNREVIEWED | package test; affected selection dynamic; isolated home |
| tests/mc/repo-render.test.js | UNREVIEWED | package test; affected selection dynamic; isolated home |
| tests/mc/repo-round-log.test.js | UNREVIEWED | package test; affected selection dynamic; isolated home |
| tests/mc/repo-status.test.js | UNREVIEWED | package test; affected selection dynamic; isolated home |
| tests/mc/repo-watch.test.js | UNREVIEWED | package test; affected selection dynamic; isolated home |
| tests/mc/repos.test.js | UNREVIEWED | package test; affected selection dynamic; isolated home |
| tests/mc/resource-claim.test.js | UNREVIEWED | package test; affected selection dynamic; isolated home |

#### CLI-tests-mc-010 · tests/mc · 12 subject(s)

| Path | Status | Existing execution metadata |
| --- | --- | --- |
| tests/mc/roles.test.js | UNREVIEWED | package test; affected selection dynamic; isolated home |
| tests/mc/run-codex.test.js | UNREVIEWED | package test; affected selection dynamic; isolated home |
| tests/mc/run-control.test.js | UNREVIEWED | package test; affected selection dynamic; isolated home |
| tests/mc/run-doc.test.js | UNREVIEWED | package test; affected selection dynamic; isolated home |
| tests/mc/run-plan.test.js | UNREVIEWED | package test; affected selection dynamic; isolated home |
| tests/mc/run-session.test.js | UNREVIEWED | package test; affected selection dynamic; isolated home |
| tests/mc/run.test.js | UNREVIEWED | package test; affected selection dynamic; isolated home |
| tests/mc/runner-lock.test.js | UNREVIEWED | package test; affected selection dynamic; isolated home |
| tests/mc/runtime-secret-names.test.js | UNREVIEWED | package test; affected selection dynamic; isolated home |
| tests/mc/selector-miss.test.js | UNREVIEWED | package test; affected selection dynamic; isolated home |
| tests/mc/session-address.test.js | UNREVIEWED | package test; affected selection dynamic; isolated home |
| tests/mc/session-gate-evidence.test.js | UNREVIEWED | package test; affected selection dynamic; isolated home |

#### CLI-tests-mc-011 · tests/mc · 12 subject(s)

| Path | Status | Existing execution metadata |
| --- | --- | --- |
| tests/mc/session-gate-run.test.js | UNREVIEWED | package test; affected selection dynamic; isolated home |
| tests/mc/session-role.test.js | UNREVIEWED | package test; affected selection dynamic; isolated home |
| tests/mc/shared-deps.test.js | UNREVIEWED | package test; affected selection dynamic; isolated home |
| tests/mc/shot-compare.test.js | UNREVIEWED | package test; affected selection dynamic; isolated home |
| tests/mc/shot-session.test.js | UNREVIEWED | package test; affected selection dynamic; isolated home |
| tests/mc/shot.test.js | UNREVIEWED | package test; affected selection dynamic; isolated home |
| tests/mc/skills.test.js | UNREVIEWED | package test; affected selection dynamic; isolated home |
| tests/mc/status-collect.test.js | UNREVIEWED | package test; affected selection dynamic; isolated home |
| tests/mc/status-doc.test.js | UNREVIEWED | package test; affected selection dynamic; isolated home |
| tests/mc/status-roles.test.js | UNREVIEWED | package test; affected selection dynamic; isolated home |
| tests/mc/tap-red.test.js | UNREVIEWED | package test; affected selection dynamic; isolated home |
| tests/mc/test-environment.test.js | UNREVIEWED | package test; affected selection dynamic; isolated home |

#### CLI-tests-mc-012 · tests/mc · 12 subject(s)

| Path | Status | Existing execution metadata |
| --- | --- | --- |
| tests/mc/test-progress.test.js | UNREVIEWED | package test; affected selection dynamic; isolated home |
| tests/mc/test-timing.test.js | UNREVIEWED | package test; affected selection dynamic; isolated home |
| tests/mc/tidy.test.js | UNREVIEWED | package test; affected selection dynamic; isolated home |
| tests/mc/tmux-ux.test.js | UNREVIEWED | package test; affected selection dynamic; isolated home |
| tests/mc/verb-epipe.test.js | UNREVIEWED | package test; affected selection dynamic; isolated home |
| tests/mc/work-area-add.test.js | UNREVIEWED | package test; affected selection dynamic; isolated home |
| tests/mc/work-identity.test.js | UNREVIEWED | package test; affected selection dynamic; isolated home |
| tests/mc/work-layout.test.js | UNREVIEWED | package test; affected selection dynamic; isolated home |
| tests/mc/work-open.test.js | UNREVIEWED | package test; affected selection dynamic; isolated home |
| tests/mc/work-release-dryrun.test.js | UNREVIEWED | package test; affected selection dynamic; isolated home |
| tests/mc/work-release-verdict.test.js | UNREVIEWED | package test; affected selection dynamic; isolated home |
| tests/mc/work-stop.test.js | UNREVIEWED | package test; affected selection dynamic; isolated home |

#### CLI-tests-security-001 · tests/security · 1 subject(s)

| Path | Status | Existing execution metadata |
| --- | --- | --- |
| tests/security/credential-boundary-probe.test.js | UNREVIEWED | package test; affected selection dynamic; isolated home |

#### CLI-tests-vault-001 · tests/vault · 12 subject(s)

| Path | Status | Existing execution metadata |
| --- | --- | --- |
| tests/vault/engine/audit.test.js | [KEEP recommendation inspected](audit-vault-001.md#1-audittestjs--keep); static only; runtime NOT MEASURED, faults UNRUN; no protection change | package test; affected selection dynamic; isolated home |
| tests/vault/engine/bindings.test.js | [REBUILD recommendation inspected](audit-vault-001.md#2-bindingstestjs--rebuild-the-value-free-fixture-keep-metadata-behaviour); static only; runtime NOT MEASURED, faults UNRUN; no protection change | package test; affected selection dynamic; isolated home |
| tests/vault/engine/c1-claude-lease.test.js | [KEEP recommendation inspected](audit-vault-001.md#3-c1-claude-leasetestjs--keep-scoped-parserscanner-and-trust-pin-evidence); static only; runtime NOT MEASURED, faults UNRUN; no protection change | package test; affected selection dynamic; isolated home |
| tests/vault/engine/crypto-port.test.js | [KEEP recommendation inspected](audit-vault-001.md#4-crypto-porttestjs--keep-real-webcrypto-and-compatibility-vectors); static only; runtime NOT MEASURED, faults UNRUN; no protection change | package test; affected selection dynamic; isolated home |
| tests/vault/engine/custody-crypto.test.js | [KEEP recommendation inspected](audit-vault-001.md#5-custody-cryptotestjs--keep-real-authenticated-hierarchy-and-wire-oracle); static only; runtime NOT MEASURED, faults UNRUN; no protection change | package test; affected selection dynamic; isolated home |
| tests/vault/engine/custody-session.test.js | [REBUILD recommendation inspected](audit-vault-001.md#6-custody-sessiontestjs--rebuild-race-key-identity-evidence); static only; runtime NOT MEASURED, faults UNRUN; no protection change | package test; affected selection dynamic; isolated home |
| tests/vault/engine/device-unlock.test.js | [KEEP recommendation inspected](audit-vault-001.md#7-device-unlocktestjs--keep-durable-vs-legacy-decision-boundary); static only; runtime NOT MEASURED, faults UNRUN; no protection change | package test; affected selection dynamic; isolated home |
| tests/vault/engine/import-scan.test.js | [KEEP recommendation inspected](audit-vault-001.md#8-import-scantestjs--keep-value-free-metadata-and-ambiguity-decisions); static only; runtime NOT MEASURED, faults UNRUN; no protection change | package test; affected selection dynamic; isolated home |
| tests/vault/engine/key-cache.test.js | [KEEP recommendation inspected](audit-vault-001.md#9-key-cachetestjs--keep-validation-legacy-decoding-and-macset-seam); static only; runtime NOT MEASURED, faults UNRUN; no protection change | package test; affected selection dynamic; isolated home |
| tests/vault/engine/local-codex-revision.test.js | [KEEP recommendation inspected](audit-vault-001.md#10-local-codex-revisiontestjs--keep-opaque-token-and-no-retry-evidence); static only; runtime NOT MEASURED, faults UNRUN; no protection change | package test; affected selection dynamic; isolated home |
| tests/vault/engine/startup.test.js | [REBUILD recommendation inspected](audit-vault-001.md#11-startuptestjs--rebuild-output-denial-proof-keep-no-materialisation); static only; runtime NOT MEASURED, faults UNRUN; no protection change | package test; affected selection dynamic; isolated home |
| tests/vault/engine/step-credit-key.test.js | [REBUILD recommendation inspected](audit-vault-001.md#12-step-credit-keytestjs--rebuild-selection-minimization-evidence); static only; runtime NOT MEASURED, faults UNRUN; no protection change | package test; affected selection dynamic; isolated home |

#### CLI-tests-vault-002 · tests/vault · 4 subject(s)

| Path | Status | Existing execution metadata |
| --- | --- | --- |
| tests/vault/engine/tool-auth.test.js | UNREVIEWED | package test; affected selection dynamic; isolated home |
| tests/vault/engine/types.test.js | UNREVIEWED | package test; affected selection dynamic; isolated home |
| tests/vault/engine/vault-cli.test.js | UNREVIEWED | package test; affected selection dynamic; isolated home |
| tests/vault/engine/vault-commands.test.js | UNREVIEWED | package test; affected selection dynamic; isolated home |

## Subsequent work and source-state limits

Inspected the two decision-subject tests changed since first-batch revision `26490524d90800a8e26d24d48cc8fcedc46dc1fc`; the third (`branch-landed.test.js`) has no diff across that interval. Current `canon-text.test.js` now reads task files from `canon/tasks/<name>.md`, removes assertions that each role explicitly names every individual skill, and adds a role-launch assertion against task catalogues/bodies in the prompt. Current `roles-decisions.test.js` reads skill bodies from the flat task path and matches a generic installed `skills/mc/SKILL.md` pointer for the asking/proposals/publish obligations. These are completed test/source changes, **not** a completed migration decision or demonstrated equivalent fault protection: the generic pointer assertion does not distinguish which skill it points to, and no fault proof or runtime evidence was run here. The difference is reported as inspected current code, not a new keep/rebuild/retire verdict. All prior recommendations remain non-authoritative.

## Historical study-prompt gate-ceiling evidence

Source: `/Users/martinforsberg/mc/programs/mc-tests/proposals/archive/2026-11-04-memoro-study-prompt-gate-ceiling.md`. The proposal records a focused generation/billing/completion/prompt round of 82 tests / 50 s overall (6.003 s Node round), and a broad affected gate that hit the existing 900 s tests-phase ceiling (3,117 completed, 3,116 passed, one inventory assertion failure attributed to untracked additions, 36 unfinished files, five command gates not reached; 927 s wall). Focused evidence is narrow; the broad result is selection/setup evidence, not an estate pass, confirmed diagnosis, or permission to exclude tests, narrow protection or raise the ceiling. The untracked-file explanation was not independently reproduced here. Retain unmeasured tails and protection.

No new measurements were made for this map. First-batch callback, selected-round and elapsed values remain historical. Counts are not performance measurements. Costly fixtures, startup attribution, live/browser/evaluation prerequisites, whether any measured cost should affect existing selection, and the scope of any future residual-risk decision remain unresolved for separate planning; no tail is accepted or treated as green.

## Decision boundary

Documentary snapshot only. Test/check files and lanes stay unchanged. No keep/rebuild/consolidate/retire classification is made beyond the earlier non-authoritative recommendations. Batch size is an audit-planning limit, not a runtime/count target. Protection, selection, lane, fixture, timeout or threshold changes require separate planning.

## Audit note — 2026-11-04, audit-mc-001

The twelve unchanged members of CLI-tests-mc-001 now link to the individually
inspected [audit-mc-001 recommendations](audit-mc-001.md): four REBUILD and eight
KEEP, not implemented migration decisions. The batch actually covers selector,
archive, ASC, waiting, billing and shared readers, not canon/role guidance. The
snapshot revision and inventory above remain historical; all other statuses are
unchanged. One focused round was green (162 tests, Node 4854.453458 ms, gate 6 s);
startup attribution and proposed fault proof remain unmeasured/unrun. See the
report for exact log, model-vs-real Git boundaries, unique protection and gaps.
No residual risk, retirement, lane or policy change is accepted. This dated note
supplements, rather than rewrites, the snapshot and historical decision boundary.
