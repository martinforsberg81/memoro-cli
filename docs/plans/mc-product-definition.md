# mc product definition

**Status:** in-flight

This target contract was accepted on 2026-07-31 and defines the intended end
product before additional capabilities are added. It is the product layer above
the security invariants in
[`mc-contract.md`](mc-contract.md): that contract remains authoritative for
credential custody and the LLM-domain boundary, while this document defines
who the product is for, what the core experience promises, and which concerns
must remain optional capabilities.

Current plans and public documentation must be reconciled against this
definition. Acceptance does not make an existing implementation conform; the
compatibility matrix and release gates below determine that.

## 1. Product decision

`mc` is a **portable continuity layer for human-directed AI coding sessions**.

One person can work across repositories, coding tools, hosts, and project
stacks without losing the identity of the work session, its exact workspace,
or the context needed to continue. Memoro supplies account identity, durable
memory, connected capabilities, and credential custody. The coding tool still
owns the coding experience.

The core product is not an agent runner, a package manager, a Git workflow, a
general-purpose sandbox, or a repository-specific development toolkit.

### Product promise

> Install `memoro-cli` on a supported host, sign in, enter an existing Git
> repository, and start or reopen a named coding session. `mc` returns you to
> the exact session when that session still exists, preserves the repository's
> and coding tool's own rules, keeps credentials outside model-directed
> execution, and never silently substitutes a new session for a missing one.

Portability means that the account, connected capabilities, durable context,
and logical session identity follow the user. It does **not** mean that mc
silently copies arbitrary device files, provider configuration, repository
content, or operating-system policy between hosts.

## 2. Target users and jobs

The primary user is a developer who:

- works in one or many unrelated repositories;
- uses Codex, Claude Code, or another supported coding tool;
- may switch machines or later use a cloud host;
- expects repositories to have different languages, package managers, branch
  conventions, remotes, and instructions;
- wants sessions to survive terminal closure, crashes, and ordinary host
  interruption;
- wants Memoro context and connected services without exposing credentials to
  the coding model.

Teams are supported through optional committed repository policy, but the core
product must work in a repository that contains no mc-specific files.

## 3. The product model

The stable hierarchy is:

```text
Memoro account
  repository identity
    logical mc session
      workspace identity
      provider-native session identity per coding tool
      zero or more execution generations on supported hosts
```

### Repository identity

A repository is not its directory basename. Identity is derived from a
credential-free canonical remote when available and a stable local repository
identifier otherwise. Different repositories with the same basename remain
distinct.

The repository's default branch is discovered from Git metadata. `main`,
`master`, `develop`, `trunk`, and any other valid branch name are equally
ordinary.

### Session identity

A session name is scoped to a repository. `(repository identity, session
name)` is the human-facing key; an opaque mc session id is the durable internal
key. Two repositories may both contain a session named `billing`.

A logical session owns the continuity relationship between its workspace,
provider-native conversation, Memoro session record, and broker execution. A
process id, worktree basename, or provider transcript path alone is not a
session identity.

### Execution generation

Every provider start is a generation. Reattachment and provider-native resume
continue a proven generation or conversation. A replacement generation is a
new execution event and requires explicit user intent; it is never disguised
as resume.

On another host, mc continues the same logical work session. It may claim the
same provider-native conversation only when the provider and adapter can prove
that continuity. Otherwise it performs an explicit, visible context handoff
into a new provider generation.

## 4. Core user experience

The normal product surface should fit in one screen:

```text
mc setup                 sign in and verify this host
mc new <name> [focus]    create a workspace and start a session
mc open [<name>]         list or reopen an existing session
mc list                  show sessions in the current repo by default
mc status [<name>]       explain continuity and health
mc end <name>            explicitly and safely end a session
mc doctor                diagnose the installation and current repo
```

`mc open` is the canonical re-entry verb. `mc resume` may remain as a
compatibility alias, but public documentation should not make users choose
between two verbs with overlapping meanings.

The default view is repository-local. Account-wide and all-repository views
are explicit. A command run outside the repository can use a qualified
`<repo>:<session>` name or an interactive picker.

Advanced and internal operations must live behind grouped surfaces and stay
out of the primary help path. Broker internals, credential-domain repair,
storage surgery, cloud-runtime plumbing, hostile boundary certification, and
release diagnostics are operator or developer surfaces, not normal product
commands.

## 5. Core responsibilities

The repo-neutral mc core owns:

1. Memoro sign-in and device/account identity.
2. Repository and logical-session identity.
3. Worktree/workspace creation, discovery, and safe lifecycle.
4. Broker-owned PTY lifecycle and exact reattachment.
5. Provider adapter selection and provider-native session binding.
6. Grounding and session handoff without modifying repository instructions.
7. Credential custody and the credential-only boundary.
8. Presence, diagnostics, and explicit recovery after interruption.
9. Transparent, user-governed session ingestion into Memoro.
10. A capability registry for optional connected services and project
    features.

## 6. Ownership boundaries

### The repository owns

- source code and repository content;
- `AGENTS.md`, `CLAUDE.md`, and other coding instructions;
- its default branch and Git workflow;
- build, dependency, test, development-server, deployment, and release
  commands;
- committed team policy.

### The coding tool owns

- its native TUI and conversation format;
- hooks and their trust/review flow;
- approvals, permission rules, and sandbox semantics;
- user configuration and provider-native repository configuration;
- native session-resume semantics.

`mc` preserves and projects supported native configuration; it does not invent
one cross-tool approval language or silently weaken a tool's policy.

### The user and host own

- operating-system permissions and host security;
- device-local coding-tool preferences;
- shell and editor choices;
- the decision to connect services, enable capabilities, or execute
  repository-declared commands.

### Memoro and mc own

- account identity and durable personal context;
- session identity and continuity metadata;
- credential-blind connected operations;
- credential custody, revocation, and audit;
- explicit account-portable preferences that are part of the mc product.

## 7. Core versus capabilities

Capabilities extend the core through typed contracts. They are inactive when
not configured and must not change unrelated repositories.

| Capability | Activation | Core when absent |
| --- | --- | --- |
| GitHub | User connects a repository through the Memoro GitHub App | Local Git sessions still work |
| Development service | Repository declares a supported `.mc/dev.json` contract | mc never guesses or runs project commands |
| Dependency hydration | Explicit repository declaration plus user invocation | mc does not install dependencies |
| Cloudflare data guard | Repository policy or a connected Cloudflare capability activates it | No Wrangler-specific interception |
| Vault secret binding | User binds named custody records to a typed capability | No secret is materialised into the project |
| Fleet/coordinator | User opens an account-wide coordinator surface | Ordinary single sessions remain unchanged |
| Cloud host | User selects a certified cloud execution host | Local sessions remain complete |

A capability may be provider-specific internally. Its registration,
activation, status, and failure shape must be provider-neutral.

## 8. Repository-neutrality rules

Package defaults contain only universal mc behavior. The shipped runtime must
not contain a target user's paths, repository names, GitHub owner, branch,
scripts, package manager, framework, cloud vendor, or test commands.

Specifically:

- no hardcoded `main` or `origin/main`; discover the default branch;
- no global session-name namespace across unrelated repositories;
- no assumption that a project has `package.json` or `node_modules`;
- no unconditional `npm`, Wrangler, Cloudflare, framework, or deployment
  behavior;
- no required `.mc` directory for the core session lifecycle;
- no mutation of repository instruction files during ordinary launch;
- no execution of project code during `mc new` or `mc open`;
- no use of absolute local paths as portable account identity;
- no special behavior selected by repository basename.

Product branding, the Memoro API endpoint, package provenance, keychain service
names, and certified provider-artifact identities are legitimate product
constants. They must never be confused with the identity or policy of the
repository being opened.

## 9. Configuration and portability

Configuration is separated by ownership rather than treated as one merged bag:

| Layer | Scope | Portable | Examples |
| --- | --- | --- | --- |
| Package defaults | All users | With release | Conservative universal behavior |
| Memoro account | One user | Yes | Language, preferred tool, connected capabilities |
| Device | One host | No by default | Paths, shell, resource limits, provider-native user policy |
| Repository policy | One repository/team | Through Git | Capability activation and safety floors |
| Repository-local | One user + repo + host | No | Ports, local paths, profile choice |
| Session | One logical session | With session | Tool, focus, continuity state |
| Invocation | One command | No | Explicit operational override |

Codex and Claude approval rules remain native user/device settings unless a
future provider adapter defines a small, explicit, reviewable portable subset.
`mc` must not claim that arbitrary provider settings materialise on a new
device.

Every effective mc setting should be inspectable together with its value,
source, scope, and whether it follows the user.

## 10. Provider adapter contract

A first-class provider adapter must declare and verify:

- supported operating systems and architectures;
- supported provider versions or version ranges;
- installation and update provenance;
- authentication/custody topology;
- how native user and repository policy is preserved;
- fresh-start readiness detection;
- exact native session discovery and binding;
- warm attach, cold resume, and explicit replacement behavior;
- provider-artifact ownership and cleanup boundaries;
- hook/review behavior;
- crash, lock, and reboot recovery;
- capability degradation and actionable diagnostics.

Unsupported combinations fail during `mc setup` or before mutation. A tool
name in help text is not a support claim; only a registered adapter with a
passing conformance suite is supported.

## 11. Project capability contract

The core is language- and package-manager-agnostic. Project automation is an
adapter contract with at least:

- a stable adapter id and version;
- deterministic detection or explicit repository declaration;
- fingerprint inputs;
- install, start, readiness, stop, and cleanup operations as structured argv;
- declared outputs and owned paths;
- consent boundaries for code execution;
- platform support and failure diagnostics.

Initial dependency adapters may include npm, pnpm, Yarn, Bun, Python
(uv/pip), Cargo, and Go. Shipping only one adapter is acceptable; presenting
that adapter as generic dependency support is not.

## 12. Security boundary

The model and model-directed processes are untrusted. Provider and Memoro
credentials remain outside that domain according to `mc-contract.md`.

This is a **credential boundary**, not a general development sandbox. Ordinary
filesystem access, network use, package installation, subagents, and coding
tool behavior are governed by the host, the coding tool, the user, and the
repository. mc restricts them only when an explicitly activated typed
capability requires a narrow guard.

Connected writes are default-deny, typed, scoped, revocable, and auditable.
The model receives bounded operations and redacted results, never reusable
authority.

## 13. Data and memory contract

Users must be able to see what mc sends to Memoro, why, and under which session
identity. Session ingestion must have a documented default, an account-visible
status, and an explicit off switch. Raw secrets and raw tool artifacts are
never uploaded merely because mc can read them.

Grounding distinguishes:

- personal context owned by the Memoro account;
- repository instructions owned by the project;
- session focus and handoff owned by the logical session;
- tool policy owned by the provider configuration.

These sources remain visibly separate and are not silently rewritten into one
another.

## 14. Support claims and compatibility matrix

Every release publishes a capability matrix. “Supported” means the exact
combination has automated conformance coverage and a live smoke where real
provider behavior is material.

Minimum core matrix before a general-product claim:

- repositories with `main`, `master`, and a custom default branch;
- GitHub, non-GitHub, local-only, and differently named remotes;
- two repositories with the same basename;
- the same session name in two repositories;
- an empty repository plus Node/npm, Node/pnpm, Python, Rust, and Go fixtures;
- repositories with and without `.mc` files;
- abrupt terminal closure, process crash, host lock, and reboot recovery;
- each supported provider under its native default, permissive, and restrictive
  user policy;
- connected and disconnected optional capabilities;
- each claimed operating-system, architecture, and shell combination.

Core tests must prove that project type does not alter `new`, `open`, exact
resume, `status`, or safe `end`. Capability tests separately prove only the
projects they claim to support.

## 15. Failure behavior

Continuity failures are explicit states, not opportunities to guess:

- If exact reattachment is possible, attach.
- If verified provider-native cold resume is possible, resume it.
- If state is ambiguous, preserve it and explain the repair path.
- If only replacement is possible, ask for explicit user intent and record a
  new generation.
- Never launch a duplicate because a timeout obscured an accepted outcome.
- Never classify work as merged because the expected base branch is missing.
- Never delete or rewrite state solely to make the registry look consistent.

## 16. Non-goals

The core product does not:

- replace Git, the provider TUI, the shell, or the editor;
- impose one branch, worktree, package-manager, cloud, or deployment workflow;
- run autonomous project management, scheduling, or merge loops;
- synchronize arbitrary provider configuration or home-directory content;
- promise bit-identical native provider sessions across hosts that cannot
  support them;
- claim every operating system or provider before certification;
- make repository-specific convenience behavior a universal default.

## 17. Product release gates

### Gate 0 — definition accepted

- Record the ratified decisions in §18.
- Make this document the product layer above the security contract.
- Classify every existing public command as core, capability, advanced
  operator, internal, compatibility, or removal candidate.
- Stop adding unrelated surface until that classification is complete.

### Gate 1 — neutral core

- Discover default branches dynamically.
- Scope session names and repository identity correctly.
- Remove unconditional stack/vendor behavior from launch.
- Prove the core project matrix.
- Align README, onboarding, and primary help with the actual support claim.

### Gate 2 — adapter contracts

- Formalize and test provider conformance.
- Formalize project/dependency capability adapters.
- Make unsupported combinations fail before side effects.

### Gate 3 — product surface

- Reduce primary help and onboarding to the core loop.
- Move advanced/operator commands behind explicit groups.
- Expose effective configuration and capability status with ownership and
  portability metadata.

### Gate 4 — supported release

- Run the published automated matrix.
- Run live provider smokes for every claimed provider/host combination.
- Install the exact package on a clean supported host and complete the
  first-device and second-device journeys.
- Publish known gaps without broadening the support claim.

Only after these gates should unrelated new capabilities resume.

## 18. Ratified decisions

The following decisions were accepted on 2026-07-31:

1. **Continuity is the core product; orchestration is a capability.**
2. **`mc open` is the canonical re-entry verb; `resume` becomes an alias.**
3. **Session names are repository-scoped, with opaque global ids underneath.**
4. **Core mc never runs project commands; dev/dependency behavior is an
   explicitly activated capability.**
5. **Tool-native permissions remain tool-native and device-scoped by default.**
6. **Cross-host continuity preserves logical session identity but claims native
   provider continuity only when it is provable.**
7. **Cloud/vendor-specific guards activate only for the relevant declared or
   connected capability.**
8. **The public support claim is generated from a tested provider/host/project
   matrix, not inferred from code paths or placeholders.**
9. **Session ingestion requires one explicit account-level opt-in during
   onboarding. After that consent, cleaned session ingestion is automatic and
   visible, with account status plus per-account, per-repository, and
   per-session off controls. Raw secrets and raw provider artifacts are never
   included by default.**

## 19. Relationship to existing plans

Acceptance requires an explicit documentation reconciliation rather than
leaving multiple north stars in force:

- [`mc-contract.md`](mc-contract.md) keeps its trust, custody, identity,
  authorization, and host-integrity invariants. Its “environment materialises
  exactly” language is narrowed by §1 and §9 here so mc does not promise to
  synchronize arbitrary provider or device configuration.
- [`worktree-lifecycle.md`](worktree-lifecycle.md) remains historical design and
  implementation detail for workspace operations. Its statement that fleet
  orchestration “is the product” is superseded by §1: orchestration becomes a
  capability over continuity.
- [`mc-credential-scope.md`](mc-credential-scope.md) is consistent with §6 and
  §12 and should remain the active ordinary-development boundary.
- [`unified-policy.md`](unified-policy.md) must be revised where it proposes
  cross-tool permission translation. Tool-native policy remains authoritative.
- [`configuration-model.md`](configuration-model.md) keeps ownership-based
  layering, but Cloudflare is removed from universal package defaults and
  becomes an activated capability.
- `README.md`, `docs/onboarding.md`, and `mc --help` must stop presenting
  planned adapters, internal runtime commands, and capability-specific
  behavior as one undifferentiated product surface.

No existing plan should be deleted merely because this definition is accepted.
It should instead be marked consistent, revised, superseded, or historical so
future work has one unambiguous product hierarchy.

## 20. Provisional classification of the current CLI

This is the initial Gate 0 classification. It describes intended product
placement, not immediate command removal.

| Class | Current commands | Intended treatment |
| --- | --- | --- |
| Core daily loop | `mc`, `new`, `open`, `list`, `status`, `end`, `doctor` | Keep in primary help and onboarding |
| Workspace convenience | `cd`, `rename` | Keep as secondary core commands |
| Setup and account | `setup`, `auth`, `connections`, `tool-switch`, `install-shell`, `coding-profile` | Group under setup/account; show only when relevant |
| Connected capability | `github` | Expose after connection; absent capability does not affect core |
| Project capability | `dev`, `deps` | Expose only for a declared project adapter |
| Custody administration | `vault` | Trusted user/operator surface outside the model domain |
| Fleet capability | `sessions`, `spawn`, `dispatch`, `read`, `fanout`, `gather`, `supervisor` | Group under coordinator/fleet; remove from primary loop |
| Advanced recovery | `reconcile`, `storage`, `gc` | Primarily automatic; retain explicit inspect/repair paths |
| Runtime operator | `broker`, `attach`, `adapter`, `security` | Hide from normal help; document for support/development |
| Internal cloud runtime | `cloud-session`, `cloud-runtime` | Internal API/host entrypoints, not end-user commands |
| Compatibility | `resume`, `wrap`, `tool-auth`, low-level `memoro-cli` wrappers | Alias, migrate, or deprecate with measured usage and an explicit compatibility window |

The eventual command tree should be generated from the capability registry so
help and setup show only commands that are meaningful for the current host,
repository, and account. Discovery must remain possible through an explicit
advanced/all-help view.
