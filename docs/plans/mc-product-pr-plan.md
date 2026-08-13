# mc product PR plan

**Status:** superseded · see [`mc-v1-session-pr-plan.md`](mc-v1-session-pr-plan.md)

> **Superseded:** Delivery now follows
> [`mc-v1-session-pr-plan.md`](mc-v1-session-pr-plan.md). This plan retains the
> older repository-scoped product sequence for historical context only.

**Status:** in-flight

This plan turns the accepted
[`mc-product-definition.md`](mc-product-definition.md) and the evidence in
[`mc-product-codebase-analysis.md`](mc-product-codebase-analysis.md) into a
reviewable sequence. Each PR must stay focused, preserve unrelated changes,
and leave the product usable at every merge.

The ordering is deliberate: establish identity and safety primitives before
changing routing, capability activation, or the public surface. Do not bundle
new unrelated features into this track.

## Delivery rules for every PR

- State outcome, scope, non-goals, migration behavior, user impact, and rollback
  path before implementation.
- Add regression coverage for the exact defect or contract slice.
- Test negative space: an unrelated repository must not acquire the feature's
  behavior merely because mc is installed.
- Run checks proportional to changed paths plus affected security closure or
  live provider proofs.
- Inspect the combined diff, actual GitHub checks, reviews, and head SHA before
  merge.
- Keep provider, repository, and platform support claims narrower than the
  evidence.
- Stop on ambiguous legacy state instead of rewriting or deleting it.

## PR 0 — Ratify the product foundation

**Outcome:** one accepted product hierarchy governs subsequent work.

**Scope:** commit the target contract, codebase analysis, and this plan; record
the ingestion default; classify current commands; record reconciliation needed
for older plans and public docs.

**Non-goals:** no runtime behavior, migration, provider claim, or CLI removal.

**Acceptance:** documentation links resolve, `git diff --check` passes, and the
PR description clearly says this changes product direction but not runtime.

## PR 1 — Resolve default branches without guessing

**Outcome:** lifecycle code treats every valid default branch as ordinary.

**Scope:** introduce one resolver using local symbolic refs, configured remote
HEAD, and explicit repository metadata; replace hardcoded defaults in Git,
storage management, and squash-phantom detection; expose an unknown result.

**Non-goals:** session namespace migration or changing the repository's branch.

**Acceptance:** fixtures cover `main`, `master`, `develop`/custom, remote not
named `origin`, local-only, missing remote HEAD, and ambiguous state. Destructive
or merged classification refuses unknown state.

## PR 2 — Introduce canonical repository and session identity

**Outcome:** session names are repository-scoped and durable operations use
opaque ids.

**Scope:** version the registry schema; derive credential-free canonical remote
identity with a stable local fallback; add opaque repository/session ids;
migrate lookups from bare name to repository-qualified identity; preserve all
legacy entries.

**Non-goals:** remote repository discovery, automatic deletion of duplicate
legacy names, or GitHub App routing.

**Acceptance:** two repositories with the same basename and same session name
remain distinct; relocated worktrees resolve; ambiguous legacy entries are
reported without mutation; old 0.7.10 registries migrate idempotently; cleanup
uses expected-id guards.

## PR 2.5 — Restore certified managed Claude operation

**Outcome:** claimed Claude support works for both new and existing managed
sessions without changing the Memoro session identity or weakening the
credential boundary.

**Scope:** reproduce and close `managed-claude-certification-missing` for
`mc new <name> --claude` and `handoff-capability-unavailable` for
`mc open <name> --claude`; make the pinned Claude adapter, its certification,
and the provider-handoff capability available in the installed release
artifact; retain provider-native resume when the session is already on Claude;
add exact regressions and installed-artifact/live evidence for both paths.

**Non-goals:** Gemini registration, native Claude credential projection,
uncertified fallback, bypassing provider policy, changing repository/session
identity, or GitHub App repository routing.

**Acceptance:** a fresh Claude session reaches provider readiness through the
certified managed adapter; an existing session resumes Claude or performs one
acknowledged handoff to Claude while preserving `session_id` and
`coding_session_id`; neither path creates a duplicate provider session;
interruption removes the credential domain and provider PTY; missing or stale
artifacts still fail closed with actionable diagnostics; managed Claude source
closure, credential-boundary, Codex regressions, global release smoke, and the
exact live new/open journeys pass on the release candidate.

**Migration and rollback:** no registry-schema change. Certification and
adapter installation are derived release state, so rollback reverts this PR
without deleting or rewriting sessions.

## PR 3 — Route GitHub App operations by active repository

**Outcome:** `mc github` works through the Memoro GitHub App for the launch
repository, nested repositories, and other active repositories in the same
managed session without exposing credentials or accepting caller authority.

**Scope:** reproduce the `no_session_broker` nested-repo failure; add a trusted
repo-target resolution/binding protocol; validate selected installation repos;
route each operation to the canonical active target; preserve effect
classification, native write approval, audit, and the allowlisted shim.

**Non-goals:** native `gh` authentication, arbitrary GitHub API, token export,
cross-account guessing, merge/force operations, or broader GitHub features.

**Acceptance:** automated cases cover outer, nested, sibling, same-basename,
unselected, local-only, and changed-cwd repositories; requests cannot spoof a
repo; reads and allowed writes hit the intended repo; stale/mismatched bindings
fail closed; managed Codex and Claude closure checks pass; a live GitHub App
smoke creates or updates a disposable PR through `mc` and verifies the repo.

This PR is explicitly owned by the `mc` product track. It is not resolved by
asking users to configure `gh` separately.

## PR 4 — Make vendor guards capability-activated

**Outcome:** installing or launching mc adds no Cloudflare-specific behavior to
an unrelated repository.

**Scope:** remove Cloudflare from unconditional package behavior; define typed
activation through repository policy or connected capability; install the
guard only when active; expose source/scope in status.

**Non-goals:** redesigning the guard itself or adding another cloud vendor.

**Acceptance:** unrelated Node, Python, Rust, Go, and empty repos receive no
Wrangler interception; activated Cloudflare fixtures retain current safety;
local weakening remains bounded by committed policy.

## PR 5 — Extract the npm implementation behind a project adapter

**Outcome:** the core session lifecycle is package-manager-agnostic while
existing npm functionality remains available as an explicit capability.

**Scope:** define the project adapter interface and registry; register the
existing npm install/snapshot/dev behavior as `npm-v1`; require declaration or
deterministic, side-effect-free activation; remove npm assumptions from core
launch paths.

**Non-goals:** adding pnpm, Yarn, Bun, Python, Cargo, or Go implementations in
the same PR; automatic installation during `new` or `open`.

**Acceptance:** empty and non-Node repos preserve core behavior; npm fixtures
retain current functionality only when active; detection executes no project
code; structured argv and owned paths are validated; help/status reflect
capability state.

## PR 6 — Publish provider conformance and support metadata

**Outcome:** support claims come from registered, certified adapters.

**Scope:** formalize provider capability metadata for platform, architecture,
version, policy projection, readiness, resume, recovery, and live-certification
state; generate setup/help/status support output from it; consolidate shared
conformance tests for Codex and Claude.

**Non-goals:** registering Gemini before it passes the complete contract or
loosening pinned artifact verification.

**Acceptance:** Codex and Claude pass the same declared contract; unsupported
platform/version combinations fail before mutation with actionable diagnostics;
Gemini is visibly planned/unsupported rather than implied supported.

## PR 7 — Expose effective configuration and capability ownership

**Outcome:** users can tell which behavior follows the account, device,
repository, session, or invocation.

**Scope:** emit effective setting value, source, scope, portability, and active
capability; add safe account-visible ingestion consent/status plus repo/session
off controls; preserve native Codex/Claude policy ownership.

**Non-goals:** synchronizing arbitrary home-directory configuration or
inventing a unified cross-tool permission language.

**Acceptance:** precedence and safety floors are deterministic; status contains
no secrets or raw personal content; a second-device fixture receives only
account-portable settings; ingestion remains disabled until explicit account
consent.

## PR 8 — Reshape the CLI around the core loop

**Outcome:** first-use help and onboarding explain one coherent product.

**Scope:** make `open` canonical and `resume` a compatibility alias; keep the
daily loop in primary help; group setup/account, capabilities, fleet, recovery,
and operator commands; generate capability-specific discovery from registered
metadata; retain an explicit all/advanced help path.

**Non-goals:** immediate destructive removal of compatibility commands or
renaming internal storage formats.

**Acceptance:** primary help fits the agreed core journey; unavailable
capabilities are discoverable without appearing active; compatibility behavior
has tests and a documented window; README/onboarding match actual support.

## PR 9 — Certify the neutral-core release matrix

**Outcome:** the general-product claim is backed by published evidence.

**Scope:** add the repository/project/branch/provider/host matrix from the
target contract; automate all deterministic cases; define live smoke procedure
and release artifact; reconcile or supersede older plans; publish known gaps.

**Non-goals:** claiming untested hosts/providers or making live AI tests a
default local suite.

**Acceptance:** all Gate 4 journeys pass on the exact release artifact,
including clean host, second device, interruptions, same-name repositories and
sessions, connected/disconnected capabilities, and every claimed provider
combination. The matrix is the source of public support language.

## Dependency and merge order

```text
PR 0 documentation
  -> PR 1 default branch
  -> PR 2 repository/session identity
       -> PR 2.5 managed Claude operation
            -> PR 3 GitHub App repo routing
       -> PR 4 capability-activated guards
       -> PR 5 project adapter extraction
            -> PR 6 provider conformance metadata
            -> PR 7 configuration and ingestion visibility
                 -> PR 8 CLI/onboarding reshape
                      -> PR 9 release matrix
```

PRs 3–5 may be developed in isolated worktrees after PR 2.5's provider
operability contract is stable, but they merge in the recorded order unless
their contracts are proven independent. Branches remain owned by the mc
session lifecycle.

## Completion condition

The product-shaping track is complete only when:

- the neutral core passes the published matrix;
- GitHub App operations follow the active canonical repository without a
  credential fallback;
- project and vendor behavior is capability-activated;
- provider support is generated from certified adapters;
- public help and onboarding match the implemented product; and
- the accepted target contract contains no unresolved product decision.
