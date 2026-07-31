# mc product codebase analysis

**Status:** in-flight

This analysis records how the `mc` 0.7.10 codebase, including the merge of PR
#200 at `ee8ce91193664accb667d369e96010c9dfe59ba7`, compares with the accepted
[`mc-product-definition.md`](mc-product-definition.md). It is a product-shaping
baseline, not a claim that every referenced subsystem is defective.

## 1. Executive conclusion

The continuity and credential-boundary core is now materially stronger than
the rest of the product surface. Managed Codex and Claude have durable provider
identity, generation reconciliation, exact resume, policy preservation, and
explicit refusal on ambiguous outcomes. Those mechanisms are a credible core
for the target product.

The package is not yet ready for a repository-neutral general-product claim.
Repository identity is incomplete, some Git behavior assumes `main`, project
automation is npm-specific, a Cloudflare guard is installed as universal Codex
behavior, and public command discovery mixes the daily product with internal
and operator surfaces. GitHub App operations are secure and token-free in the
normal single-repository path, but the current session binding does not follow
the active repository when work moves into a nested or different repository.

The right next move is therefore hardening and separation, not adding another
large capability. The ordered changes are defined in
[`mc-product-pr-plan.md`](mc-product-pr-plan.md).

## 2. Evidence and method

The assessment used:

- the merged 0.7.10 source and tests;
- the current command tree and product documentation;
- focused inspection of Git, registry, configuration, project automation,
  provider registration, broker, and GitHub capability paths;
- the 0.7.10 validation result: 2,138 passing tests, 9 intentional skips, and
  no failures, plus passing source/global release smokes and C1 closure checks;
- live recovery proofs for managed Codex;
- a live nested-repository GitHub App failure in this session.

The full test result proves the implemented contracts represented by the suite.
It does not prove the broader project, branch, provider, host, or repository
matrix required by the target product contract.

## 3. Current architecture map

| Area | Principal implementation | Current role |
| --- | --- | --- |
| CLI and routing | `src/mc-cli.js`, `src/bin-mc.js`, `src/mc/commands/` | Parses the broad command surface and enters legacy or broker-owned launch paths |
| Repository/workspace | `src/lib/git-context.js`, `src/mc/git.js`, `src/mc/worktree.js`, `src/mc/registry.js` | Discovers Git state, creates worktrees, and stores global session metadata |
| Continuity | `src/mc/managed-provider-registry.js`, `src/mc/managed-generation-journal.js`, `src/mc/managed-session-reconciler.js` | Registers provider adapters and reconciles durable provider generations |
| Broker/runtime | `src/mc/broker/`, `src/mc/credential-domain/` | Owns PTYs, provider starts, custody domains, readiness, cleanup, and recovery |
| Provider adapters | `src/mc/provider-adapters/`, `src/adapters/` | Implements native Codex and Claude launch, policy, identity, and resume behavior |
| Grounding/handoff | `src/mc/ground.js`, `src/mc/provider-switch.js`, `src/mc/context.js` | Keeps Memoro grounding separate from repository and provider policy |
| GitHub capability | `src/mc/github-contract.js`, `src/mc/github-session.js`, `src/mc/commands/github.js`, broker launch/runtime code | Exposes token-free, allowlisted operations through a session-bound broker |
| Project automation | `src/mc/dev-definition.js`, `src/mc/dependencies.js`, `src/mc/dev-command-guard.js` | Provides declared dev commands and npm dependency snapshots |
| Configuration/guards | `src/mc/config-model.js`, `src/mc/cloudflare-guard.js`, `src/mc/local-resource-guard.js` | Resolves layered policy and installs launch-time guards |

## 4. Conformance assessment

| Product contract area | Assessment | Evidence |
| --- | --- | --- |
| Exact provider continuity | Strong foundation | Managed provider registry, durable intent/receipt journal, archive/reconciler, exact native session binding |
| Interruption recovery | Strong for certified paths | Live Codex lock/cold-open proof and regression coverage; ambiguity fails closed |
| Credential custody | Strong foundation | Separate credential domains, scrubbed runtime authority, closure checks, broker-owned operations |
| Provider-native policy | Strong for current adapters | Codex native policy remains authoritative; Claude projects only validated `permissions` and blocks overriding flags |
| Repository identity | Partial | Git context exists, but global registry lookups still use session name alone and no durable canonical repository id is authoritative |
| Default branch neutrality | Non-conforming | `origin/main` or `main` remains embedded in Git, storage, and squash-phantom logic |
| Project neutrality | Non-conforming for automation | Dependency definition requires npm, `package.json`, lockfile, `npm ci`, and `node_modules` |
| Vendor capability isolation | Non-conforming | Cloudflare data policy has a package default and the legacy Codex launcher installs its guard unconditionally |
| Provider breadth | Honest but narrow | Managed registry contains Codex and Claude; Gemini is described as planned and is not registered |
| Platform breadth | Narrow | Managed artifacts and certification currently make specific OS/architecture/version claims rather than a general matrix |
| Product surface | Over-broad | Daily, capability, custody, fleet, recovery, runtime, and internal commands appear in one help system |
| GitHub App | Secure single-target foundation; incomplete routing | Operations are allowlisted and token-free, but broker capability is bound to the launch repository rather than the active nested/different repo |
| Ingestion governance | Product decision ratified; implementation audit pending | The target default and controls are now explicit, but the complete UI/state/data path has not been certified against them |

## 5. Verified gaps

### 5.1 Repository identity and session namespace

`src/mc/registry.js` stores one global registry and `findEntry`, `upsertEntry`,
patch, and remove paths select entries by `name`. A user therefore cannot rely
on `(repository identity, session name)` as the durable key, and same-named
sessions in unrelated repositories risk collision.

The fix needs a versioned repository identity and opaque session id before
changing individual lookups. Migration must preserve existing sessions, detect
ambiguous legacy entries, and refuse destructive guesses.

### 5.2 Default branch assumptions

At least these production paths encode `main` or `origin/main`:

- `src/mc/git.js` defaults `commitsAhead` to `origin/main`;
- `src/mc/storage-management.js` selects `main` or `origin/main`;
- `src/mc/squash-phantom.js` defines merge detection in terms of
  `origin/main` and `main`.

A single default-branch resolver should use trusted Git metadata and return an
explicit unknown state. Callers must not replace unknown with `main`, especially
before cleanup or merge classification.

### 5.3 Project and package-manager coupling

`src/mc/dev-definition.js` accepts only `manager: "npm"`, requires
`package.json` and an npm lockfile, and requires install argv beginning with
`npm ci`. `src/mc/dependencies.js` stores npm snapshots and manages
`node_modules` directly.

This is valid as an npm adapter, not as universal core behavior. The existing
implementation should move behind the project capability contract without
being generalized through package-manager guessing.

### 5.4 Global Cloudflare behavior

`src/mc/config-model.js` provides a package-level Cloudflare guard default, and
the legacy Codex launch path in `src/bin-mc.js` installs the Cloudflare guard
for every Codex project. Repositories unrelated to Cloudflare should not inherit
Wrangler-specific interception.

Activation should require declared repository policy or a connected Cloudflare
capability. Absence must mean no Cloudflare-specific launch mutation.

### 5.5 Provider and platform support claims

`src/mc/managed-provider-registry.js` registers Codex and Claude only. Managed
adapters also pin exact provider artifacts and currently support a narrow host
matrix. That is acceptable if setup, help, and documentation derive their
claims from registration and certification. Gemini must remain visibly
unsupported until it implements the same contract and live proof.

### 5.6 Product surface and documentation hierarchy

The current help surface combines the core loop with workspace, setup,
connected capability, project automation, vault administration, fleet,
recovery, runtime, and internal cloud commands. Several existing plans also
describe orchestration as the product or propose unified cross-tool policy.

The accepted target contract now establishes continuity as the product and
tool-native policy as authoritative. Help, onboarding, README, and older plans
need classification and reconciliation before adding more top-level commands.

## 6. GitHub App follow-up: nested and multi-repository routing

### Observed behavior

This session is intentionally where `mc` is expected to work optimally with
the Memoro GitHub App. While its outer managed session was associated with the
`memoro` repository, work was performed in a nested `memoro-cli` repository.
From that nested repository:

- `mc github status --json` reported the capability as unavailable;
- `mc github pr list --json` returned `no_session_broker`;
- the PR could still be managed through the separately connected Codex GitHub
  connector, proving the repository and GitHub App installation were available.

The final bullet is diagnostic evidence only; it is not an acceptable product
fallback. Users must not need native `gh` login, token export, or a second
connector to compensate for `mc` routing.

### Root-cause hypothesis to confirm

The GitHub design intentionally binds operations to a session broker and does
not accept caller-supplied repository authority. That is the correct security
shape. The launch path, however, projects one repository capability and one
broker socket into the provider environment. `src/mc/commands/github.js`
derives the current repository for connection status, while actual PR
operations in `src/mc/github-session.js` rely on the projected broker. When the
current Git repository differs from the launch repository, repository
detection and broker authority no longer describe the same target.

This is an inference from source plus the live failure and must be confirmed by
a focused regression before implementation.

### Required product contract

1. `mc github` resolves the innermost active Git repository from the command's
   current working directory and maps it to canonical, credential-free
   repository identity.
2. The trusted host/broker validates that identity against repositories selected
   for the Memoro GitHub App; the model cannot grant itself a repository by
   passing `owner/name`.
3. The broker binds every operation to the validated target repository and
   preserves the existing allowlist, effect classification, native approval
   behavior for writes, audit, and token-free model domain.
4. A nested repository, a sibling repository, and the session's launch
   repository can all be selected correctly without starting a second provider
   session.
5. Unknown, mismatched, unselected, or ambiguous identity fails closed with an
   actionable repository-specific diagnostic.
6. No path falls back to native GitHub credentials, `gh auth login`, token
   export, arbitrary API access, or caller-supplied authority.

### Likely change surface

- repository identity and migration work from PRs 1–2 in the delivery plan;
- `src/mc/commands/github.js` target discovery;
- `src/mc/github-contract.js` target descriptors and validation;
- `src/mc/github-session.js` request routing;
- `src/mc/broker/launch-client.js` and broker runtime ownership;
- managed Codex/Claude projections and source-closure manifests if their
  runtime files change;
- unit, boundary, and live GitHub App regression fixtures.

This follow-up belongs to `mc` and is scheduled early in the product PR plan.
It is not a user-configuration task.

## 7. Risk ordering

1. Repository identity and registry migration are foundational because cleanup,
   GitHub routing, status, and command targeting depend on them.
2. GitHub routing is security-sensitive and must retain fail-closed authority
   binding while expanding repository selection.
3. Default-branch logic can misclassify merge/cleanup safety and should be fixed
   before broader lifecycle changes.
4. Capability extraction can change launch environments and requires negative
   tests proving absence has no effect.
5. CLI and documentation work should follow stable capability metadata so help
   is generated from truth rather than another hand-maintained list.

## 8. Definition of analysis closure

This analysis is complete when each verified gap has either:

- a merged PR meeting the target contract;
- a narrower documented support claim with a tested matrix; or
- a superseding decision recorded in the target contract.

It must be updated when implementation evidence disproves a root-cause
hypothesis, especially the GitHub App routing hypothesis.
