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

| Path | Recommendation only | Status |
| --- | --- | --- |
| tests/mc/canon-text.test.js | REBUILD, retaining structural delivery checks | Prior bounded audit subject; no migration decision or protection change. |
| tests/mc/roles-decisions.test.js | CONSOLIDATE, preserving unique guidance | Prior bounded audit subject; no migration decision or protection change. |
| tests/mc/branch-landed.test.js | REBUILD cost hotspots; keep real Git evidence | Prior bounded audit subject; no migration decision or protection change. |

### First three risk-prioritised follow-up batches

No batch authorises protection changes; each stays unreviewed until separately audited.
- **CLI-tests-mc-001** — core-command behavior and guidance delivery. The first audit found overlapping authored-guidance assertions; trace delivery separately from command decisions and preserve the non-AI evaluation boundary.
- **CLI-tests-vault-001** — credential/recovery/device-state consequences make this a security-priority area under the approved strategy.
- **CLI-tests-adapters-001** — inspect existing tool-boundary behavior and fixture reuse without substituting boundary evidence with a new lane.

Shared fixture dependency (not a subject): tests/_isolate-home.mjs, plus helpers actually traced for a chosen batch. First-batch setup/Git timings are historical; no new measurement made.

Sequencing context from the prior bounded audit: the `branch-landed.test.js` callbacks were 1,274 ms and 1,668 ms, and the report recorded 193 Git calls; template/copy/OS-probe startup was not isolated. `canon-text.test.js` and `roles-decisions.test.js` contain overlapping authored-guidance assertions as well as distinct obligations. These are historical observations and an inspected overlap, not timings or verdicts for the three remaining batches. Retain the first-batch cost and overlap recommendations before any retirement decision.

### Unreviewed batches

#### CLI-tests-adapters-001 · tests/adapters · 5 subject(s)

| Path | Status |
| --- | --- |
| tests/adapters/codex-hooks.test.js | UNREVIEWED |
| tests/adapters/get-status-contract.test.js | UNREVIEWED |
| tests/adapters/managed-runtime/claude-managed-custody.test.js | UNREVIEWED |
| tests/adapters/materialise.test.js | UNREVIEWED |
| tests/adapters/model-args.test.js | UNREVIEWED |

#### CLI-tests-lib-001 · tests/lib · 2 subject(s)

| Path | Status |
| --- | --- |
| tests/lib/device-flow.test.js | UNREVIEWED |
| tests/lib/keychain.test.js | UNREVIEWED |

#### CLI-tests-mc-001 · tests/mc · 12 subject(s)

| Path | Status |
| --- | --- |
| tests/mc/affected-tests.test.js | UNREVIEWED |
| tests/mc/archive-plan.test.js | UNREVIEWED |
| tests/mc/archive-programme.test.js | UNREVIEWED |
| tests/mc/asc-build-device.test.js | UNREVIEWED |
| tests/mc/asc-build-testflight.test.js | UNREVIEWED |
| tests/mc/asc-build.test.js | UNREVIEWED |
| tests/mc/asc.test.js | UNREVIEWED |
| tests/mc/await-deploy.test.js | UNREVIEWED |
| tests/mc/billing-gateway-session.test.js | UNREVIEWED |
| tests/mc/billing-gateway.test.js | UNREVIEWED |
| tests/mc/billing.test.js | UNREVIEWED |
| tests/mc/brief-collect.test.js | UNREVIEWED |

#### CLI-tests-mc-002 · tests/mc · 12 subject(s)

| Path | Status |
| --- | --- |
| tests/mc/canon.test.js | UNREVIEWED |
| tests/mc/child-async.test.js | UNREVIEWED |
| tests/mc/commands/brief.test.js | UNREVIEWED |
| tests/mc/commands/deploy.test.js | UNREVIEWED |
| tests/mc/commands/deps.test.js | UNREVIEWED |
| tests/mc/commands/gate-verdict.test.js | UNREVIEWED |
| tests/mc/commands/goal.test.js | UNREVIEWED |
| tests/mc/commands/helper.test.js | UNREVIEWED |
| tests/mc/commands/hook-install.test.js | UNREVIEWED |
| tests/mc/commands/language.test.js | UNREVIEWED |
| tests/mc/commands/log.test.js | UNREVIEWED |
| tests/mc/commands/plan.test.js | UNREVIEWED |

#### CLI-tests-mc-003 · tests/mc · 12 subject(s)

| Path | Status |
| --- | --- |
| tests/mc/commands/roles-cli.test.js | UNREVIEWED |
| tests/mc/commands/run-billing.test.js | UNREVIEWED |
| tests/mc/commands/run-lanes.test.js | UNREVIEWED |
| tests/mc/commands/test-url.test.js | UNREVIEWED |
| tests/mc/context-fill.test.js | UNREVIEWED |
| tests/mc/conversations-delete.test.js | UNREVIEWED |
| tests/mc/conversations-model.test.js | UNREVIEWED |
| tests/mc/deploy-gate-wait.test.js | UNREVIEWED |
| tests/mc/deps.test.js | UNREVIEWED |
| tests/mc/dev-lease.test.js | UNREVIEWED |
| tests/mc/dev-open.test.js | UNREVIEWED |
| tests/mc/dev-reap.test.js | UNREVIEWED |

#### CLI-tests-mc-004 · tests/mc · 12 subject(s)

| Path | Status |
| --- | --- |
| tests/mc/dev-servers.test.js | UNREVIEWED |
| tests/mc/docker-command.test.js | UNREVIEWED |
| tests/mc/docker.test.js | UNREVIEWED |
| tests/mc/docs-measure.test.js | UNREVIEWED |
| tests/mc/docs-merge.test.js | UNREVIEWED |
| tests/mc/fake-git-default.test.js | UNREVIEWED |
| tests/mc/fake-git.test.js | UNREVIEWED |
| tests/mc/foreground.test.js | UNREVIEWED |
| tests/mc/front-door.test.js | UNREVIEWED |
| tests/mc/gate-command.test.js | UNREVIEWED |
| tests/mc/gate-fast.test.js | UNREVIEWED |
| tests/mc/gate-lane-wait.test.js | UNREVIEWED |

#### CLI-tests-mc-005 · tests/mc · 12 subject(s)

| Path | Status |
| --- | --- |
| tests/mc/gate-local.test.js | UNREVIEWED |
| tests/mc/gate-lock.test.js | UNREVIEWED |
| tests/mc/git.test.js | UNREVIEWED |
| tests/mc/goal-archive.test.js | UNREVIEWED |
| tests/mc/goals.test.js | UNREVIEWED |
| tests/mc/help-routes.test.js | UNREVIEWED |
| tests/mc/help-shared.test.js | UNREVIEWED |
| tests/mc/help-subcommands.test.js | UNREVIEWED |
| tests/mc/help.test.js | UNREVIEWED |
| tests/mc/helper-cli-collect.test.js | UNREVIEWED |
| tests/mc/helper-collect.test.js | UNREVIEWED |
| tests/mc/helper-doc.test.js | UNREVIEWED |

#### CLI-tests-mc-006 · tests/mc · 12 subject(s)

| Path | Status |
| --- | --- |
| tests/mc/helper-turn.test.js | UNREVIEWED |
| tests/mc/hooks.test.js | UNREVIEWED |
| tests/mc/interactive-workspace.test.js | UNREVIEWED |
| tests/mc/keys-filter.test.js | UNREVIEWED |
| tests/mc/keys-run.test.js | UNREVIEWED |
| tests/mc/lane-count.test.js | UNREVIEWED |
| tests/mc/lane-pick.test.js | UNREVIEWED |
| tests/mc/layout.test.js | UNREVIEWED |
| tests/mc/lease-liveness.test.js | UNREVIEWED |
| tests/mc/lease-owner.test.js | UNREVIEWED |
| tests/mc/log-doc.test.js | UNREVIEWED |
| tests/mc/log-read.test.js | UNREVIEWED |

#### CLI-tests-mc-007 · tests/mc · 12 subject(s)

| Path | Status |
| --- | --- |
| tests/mc/logger.test.js | UNREVIEWED |
| tests/mc/merge-command.test.js | UNREVIEWED |
| tests/mc/merge-doc.test.js | UNREVIEWED |
| tests/mc/merge-queue.test.js | UNREVIEWED |
| tests/mc/merge-watch.test.js | UNREVIEWED |
| tests/mc/merger.test.js | UNREVIEWED |
| tests/mc/merges-collect.test.js | UNREVIEWED |
| tests/mc/model-choice.test.js | UNREVIEWED |
| tests/mc/model-config.test.js | UNREVIEWED |
| tests/mc/nightly-history.test.js | UNREVIEWED |
| tests/mc/nightly.test.js | UNREVIEWED |
| tests/mc/page-cache.test.js | UNREVIEWED |

#### CLI-tests-mc-008 · tests/mc · 12 subject(s)

| Path | Status |
| --- | --- |
| tests/mc/page-dev.test.js | UNREVIEWED |
| tests/mc/page-frame.test.js | UNREVIEWED |
| tests/mc/page-goals.test.js | UNREVIEWED |
| tests/mc/page-grid.test.js | UNREVIEWED |
| tests/mc/page-live.test.js | UNREVIEWED |
| tests/mc/page.test.js | UNREVIEWED |
| tests/mc/paths-layout.test.js | UNREVIEWED |
| tests/mc/prepare-cache.test.js | UNREVIEWED |
| tests/mc/programmes-dormant.test.js | UNREVIEWED |
| tests/mc/project-convert.test.js | UNREVIEWED |
| tests/mc/publish.test.js | UNREVIEWED |
| tests/mc/push-guard.test.js | UNREVIEWED |

#### CLI-tests-mc-009 · tests/mc · 12 subject(s)

| Path | Status |
| --- | --- |
| tests/mc/repo-freshen.test.js | UNREVIEWED |
| tests/mc/repo-gate-table.test.js | UNREVIEWED |
| tests/mc/repo-gate.test.js | UNREVIEWED |
| tests/mc/repo-lease.test.js | UNREVIEWED |
| tests/mc/repo-merge-live.test.js | UNREVIEWED |
| tests/mc/repo-merge.test.js | UNREVIEWED |
| tests/mc/repo-render.test.js | UNREVIEWED |
| tests/mc/repo-round-log.test.js | UNREVIEWED |
| tests/mc/repo-status.test.js | UNREVIEWED |
| tests/mc/repo-watch.test.js | UNREVIEWED |
| tests/mc/repos.test.js | UNREVIEWED |
| tests/mc/resource-claim.test.js | UNREVIEWED |

#### CLI-tests-mc-010 · tests/mc · 12 subject(s)

| Path | Status |
| --- | --- |
| tests/mc/roles.test.js | UNREVIEWED |
| tests/mc/run-codex.test.js | UNREVIEWED |
| tests/mc/run-control.test.js | UNREVIEWED |
| tests/mc/run-doc.test.js | UNREVIEWED |
| tests/mc/run-plan.test.js | UNREVIEWED |
| tests/mc/run-session.test.js | UNREVIEWED |
| tests/mc/run.test.js | UNREVIEWED |
| tests/mc/runner-lock.test.js | UNREVIEWED |
| tests/mc/runtime-secret-names.test.js | UNREVIEWED |
| tests/mc/selector-miss.test.js | UNREVIEWED |
| tests/mc/session-address.test.js | UNREVIEWED |
| tests/mc/session-gate-evidence.test.js | UNREVIEWED |

#### CLI-tests-mc-011 · tests/mc · 12 subject(s)

| Path | Status |
| --- | --- |
| tests/mc/session-gate-run.test.js | UNREVIEWED |
| tests/mc/session-role.test.js | UNREVIEWED |
| tests/mc/shared-deps.test.js | UNREVIEWED |
| tests/mc/shot-compare.test.js | UNREVIEWED |
| tests/mc/shot-session.test.js | UNREVIEWED |
| tests/mc/shot.test.js | UNREVIEWED |
| tests/mc/skills.test.js | UNREVIEWED |
| tests/mc/status-collect.test.js | UNREVIEWED |
| tests/mc/status-doc.test.js | UNREVIEWED |
| tests/mc/status-roles.test.js | UNREVIEWED |
| tests/mc/tap-red.test.js | UNREVIEWED |
| tests/mc/test-environment.test.js | UNREVIEWED |

#### CLI-tests-mc-012 · tests/mc · 12 subject(s)

| Path | Status |
| --- | --- |
| tests/mc/test-progress.test.js | UNREVIEWED |
| tests/mc/test-timing.test.js | UNREVIEWED |
| tests/mc/tidy.test.js | UNREVIEWED |
| tests/mc/tmux-ux.test.js | UNREVIEWED |
| tests/mc/verb-epipe.test.js | UNREVIEWED |
| tests/mc/work-area-add.test.js | UNREVIEWED |
| tests/mc/work-identity.test.js | UNREVIEWED |
| tests/mc/work-layout.test.js | UNREVIEWED |
| tests/mc/work-open.test.js | UNREVIEWED |
| tests/mc/work-release-dryrun.test.js | UNREVIEWED |
| tests/mc/work-release-verdict.test.js | UNREVIEWED |
| tests/mc/work-stop.test.js | UNREVIEWED |

#### CLI-tests-security-001 · tests/security · 1 subject(s)

| Path | Status |
| --- | --- |
| tests/security/credential-boundary-probe.test.js | UNREVIEWED |

#### CLI-tests-vault-001 · tests/vault · 12 subject(s)

| Path | Status |
| --- | --- |
| tests/vault/engine/audit.test.js | UNREVIEWED |
| tests/vault/engine/bindings.test.js | UNREVIEWED |
| tests/vault/engine/c1-claude-lease.test.js | UNREVIEWED |
| tests/vault/engine/crypto-port.test.js | UNREVIEWED |
| tests/vault/engine/custody-crypto.test.js | UNREVIEWED |
| tests/vault/engine/custody-session.test.js | UNREVIEWED |
| tests/vault/engine/device-unlock.test.js | UNREVIEWED |
| tests/vault/engine/import-scan.test.js | UNREVIEWED |
| tests/vault/engine/key-cache.test.js | UNREVIEWED |
| tests/vault/engine/local-codex-revision.test.js | UNREVIEWED |
| tests/vault/engine/startup.test.js | UNREVIEWED |
| tests/vault/engine/step-credit-key.test.js | UNREVIEWED |

#### CLI-tests-vault-002 · tests/vault · 4 subject(s)

| Path | Status |
| --- | --- |
| tests/vault/engine/tool-auth.test.js | UNREVIEWED |
| tests/vault/engine/types.test.js | UNREVIEWED |
| tests/vault/engine/vault-cli.test.js | UNREVIEWED |
| tests/vault/engine/vault-commands.test.js | UNREVIEWED |

## Subsequent work and source-state limits

Inspected the two decision-subject tests changed since first-batch revision `26490524d90800a8e26d24d48cc8fcedc46dc1fc`; the third (`branch-landed.test.js`) has no diff across that interval. Current `canon-text.test.js` now reads task files from `canon/tasks/<name>.md`, removes assertions that each role explicitly names every individual skill, and adds a role-launch assertion against task catalogues/bodies in the prompt. Current `roles-decisions.test.js` reads skill bodies from the flat task path and matches a generic installed `skills/mc/SKILL.md` pointer for the asking/proposals/publish obligations. These are completed test/source changes, **not** a completed migration decision or demonstrated equivalent fault protection: the generic pointer assertion does not distinguish which skill it points to, and no fault proof or runtime evidence was run here. The difference is reported as inspected current code, not a new keep/rebuild/retire verdict. All prior recommendations remain non-authoritative.

## Historical study-prompt gate-ceiling evidence

Source: `/Users/martinforsberg/mc/programs/mc-tests/proposals/archive/2026-11-04-memoro-study-prompt-gate-ceiling.md`. The proposal records a focused generation/billing/completion/prompt round of 82 tests / 50 s overall (6.003 s Node round), and a broad affected gate that hit the existing 900 s tests-phase ceiling (3,117 completed, 3,116 passed, one inventory assertion failure attributed to untracked additions, 36 unfinished files, five command gates not reached; 927 s wall). Focused evidence is narrow; the broad result is selection/setup evidence, not an estate pass, confirmed diagnosis, or permission to exclude tests, narrow protection or raise the ceiling. The untracked-file explanation was not independently reproduced here. Retain unmeasured tails and protection.

No new measurements were made for this map. First-batch callback, selected-round and elapsed values remain historical. Counts are not performance measurements. Costly fixtures, startup attribution, live/browser/evaluation prerequisites, whether any measured cost should affect existing selection, and the scope of any future residual-risk decision remain unresolved for separate planning; no tail is accepted or treated as green.

## Decision boundary

Documentary snapshot only. Test/check files and lanes stay unchanged. No keep/rebuild/consolidate/retire classification is made beyond the earlier non-authoritative recommendations. Batch size is an audit-planning limit, not a runtime/count target. Protection, selection, lane, fixture, timeout or threshold changes require separate planning.
