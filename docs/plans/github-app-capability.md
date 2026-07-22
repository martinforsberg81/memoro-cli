# GitHub App capability for local and cloud mc sessions

**Status:** accepted architecture / implementation in progress · PR 1 production
admin dogfood passed 2026-07-22 · serves G1, G2, G3

Normative product, security, and delivery contract for GitHub interaction from
an `mc` coding session. This plan resolves the private-repository capability
decision in `docs/plans/hosted-live-session-workspace.md`.

## Decision

Memoro owns one central GitHub App. A user installs that app once and selects
the repositories Memoro may access. Local and Memoro Cloud sessions then use
the same Memoro connection, repository selection, policy, operation vocabulary,
approval rules, and audit trail.

"The same App" does **not** mean that local and cloud processes share a token.
Memoro mints a fresh, repository-scoped installation access token only when a
trusted executor needs one. The token is short-lived and automatically renewed;
the user does not log in again when it expires.

The GitHub App is the authority. `mc` is the provider-independent capability
client. The coding tool is an untrusted caller of a narrow, typed broker API.

## Product contract

A user should experience one GitHub connection across mc:

1. During onboarding, connect GitHub by installing the Memoro GitHub App and
   selecting repositories.
2. `mc github status` reports whether the current repository is ready.
3. A local or cloud session receives the same token-free capability descriptor.
4. The session asks its mc broker for named GitHub operations.
5. Reads run without a prompt. Writes follow the same approval policy in local
   and cloud sessions.
6. If Memoro or the GitHub integration is unavailable, the capability fails
   closed with a repair action. It never tells a cloud user to run
   `gh auth login`.

This flow is independent of Claude, Codex, Gemini, or any future LLM tool. An
adapter may describe the capability, but may not implement authentication,
token handling, operation policy, or approval behavior.

## Goals

- One GitHub onboarding and repository-selection flow for local and cloud mc.
- No GitHub credential in mc vault, coding-tool env, argv, files, prompts,
  transcripts, logs, browser payloads, or session records.
- GitHub works in Memoro Cloud while the user's local machine is offline.
- A small allowlisted API that is safe to expose to coding tools.
- Repository- and session-bound authorization enforced below the prompt layer.
- Consistent approvals, structured errors, and audit records for every source
  kind and LLM provider.
- Compatibility for common `gh` habits without exposing a general authenticated
  CLI escape hatch.

## Non-goals for v1

- Storing GitHub tokens, refresh tokens, or App private keys in mc vault.
- Reusing the host `gh` keyring as the authority or cloud fallback.
- Giving the coding tool a raw installation or user access token.
- Arbitrary `gh api`, GraphQL, REST URLs, request headers, shell commands,
  extensions, or argument passthrough.
- Acting as the human GitHub user. V1 acts as the GitHub App installation bot.
- Merge, force-push, branch deletion, repository administration, settings,
  repository-webhook management, Actions secrets, or other high-impact
  mutations.
- General credential brokerage for services other than GitHub.
- GitHub Enterprise Server support until its installation and API differences
  are specified explicitly.

## Terms and trust boundaries

- **Memoro GitHub App**: the GitHub App registered and controlled by Memoro.
- **Connection**: the durable association between a Memoro user and one or more
  GitHub App installations/repository selections. Connection metadata is not a
  GitHub credential.
- **Installation actor**: the App/bot identity used for v1 GitHub API and git
  authentication. Commits keep their configured author; GitHub records the App
  as the actor that pushed or opened a pull request.
- **Control plane**: the Memoro service that stores connection metadata, holds
  the App private key in infrastructure secret storage, authorizes requests,
  mints installation tokens, and records audit events.
- **Session broker**: the trusted mc process serving one local or cloud coding
  session through a source-aware, typed operation endpoint.
- **Git executor**: a trusted local broker or cloud sidecar/bootstrap process
  allowed to perform a narrowly approved git network operation.
- **Coding tool**: the LLM CLI and every command it launches. It is outside the
  credential trust boundary even when it can edit the worktree.

The intended path is:

```text
coding tool
    | typed github-op-v1 request; no repo or token
    v
session-bound mc broker (local or cloud)
    | Memoro-authenticated request + server-known session identity
    v
GitHub capability service
    | resolve user + installation + numeric repository id + policy
    +--> GitHub API (central execution)
    `--> short-lived grant --> trusted git executor (git transport only)
```

The browser is an approval and status surface, not a token transport.

## Non-negotiable security invariants

1. The GitHub App private key exists only in Memoro infrastructure secret
   storage. It is never distributed with `mc`, returned by an API, or stored in
   mc vault.
2. Installation access tokens are minted on demand, narrowed to one repository
   and the minimum permissions for the operation, and never persisted by mc.
3. A raw GitHub credential must not appear in coding-tool env, argv, cwd files,
   Git config, remotes, prompts, transcripts, logs, telemetry, browser payloads,
   session metadata, exception text, or test snapshots.
4. API operations execute in the control plane. A token leaves the control
   plane only for an approved git transport operation handled by a trusted
   executor.
5. The coding tool cannot select a repository, installation, session, source,
   URL, HTTP method, headers, GraphQL document, executable, or credential helper.
   Those are resolved from the authenticated, server-side session binding.
6. Every operation is validated against an explicit allowlist and a strict
   per-operation parameter schema. Unknown fields fail closed.
7. Write approval is bound to the exact user, coding session, numeric repository
   id, operation, normalized preview, branch/head precondition, and expiry. An
   approval cannot authorize a different request.
8. A write request is idempotent. Repeating its `request_id` cannot duplicate a
   pull request, push, or mutation.
9. Repository identity is GitHub's numeric repository id. Owner/name is display
   metadata and may change after a rename or transfer.
10. Local and cloud brokers use the same schemas and policy evaluator. Source
    kind selects a transport/executor, never an authorization rule.
11. If authorization, policy, approval, or token minting is uncertain, deny the
    operation and return a structured repair action.
12. No provider adapter or prompt instruction may weaken these invariants.

## Actor and token lifecycle

V1 uses installation authentication:

- the user installs/updates the App only when connecting GitHub, changing the
  selected repositories, or repairing a revoked/suspended installation;
- Memoro creates a GitHub App JWT inside the control plane and exchanges it for
  a repository- and permission-scoped installation access token;
- GitHub installation access tokens expire after one hour; Memoro refreshes
  them automatically for a later operation;
- no token refresh is visible to the user or coding session;
- Memoro may cache a token encrypted in trusted service memory until shortly
  before expiry, but must not put it in durable application storage or mc vault.

GitHub App user access tokens are a different mode. They act on behalf of a
user, normally expire after eight hours when expiring tokens are enabled, and
use a refresh token. That mode is deferred because it requires durable
per-user credential handling and a different audit/consent contract. The
eight-hour lifetime therefore does not create an eight-hour login loop in v1.

## Permissions

The GitHub App registration may request the superset needed by released mc
features, but every minted installation token is narrowed further to the
current repository and operation.

Target permissions by the end of v1 (rolled out read-only first and upgraded
only when the corresponding write capability is ready):

| Capability | GitHub App repository permission | v1 use |
|---|---|---|
| Repository metadata | Metadata: read | identity/status |
| Worktree transport | Contents: read/write | clone, fetch, session-branch push |
| Pull requests | Pull requests: read/write | list/view/create/update |
| Checks | Checks: read | check summaries |
| Commit statuses | Commit statuses: read | legacy/external status summaries |

Any additional permission requires a contract update, a GitHub App permission
review, and explicit onboarding/repair UX for installations that must accept
the new permission. App-registration permissions must never silently become
new session operations.

## Onboarding and connection state

### First connection

1. `mc setup` and `mc github status` call the Memoro connection-status endpoint.
2. If disconnected, mc presents a Memoro-owned connect URL and can open it with
   explicit user action. The flow uses the user's existing Memoro login.
3. The browser starts GitHub App installation, lets the user select an account
   and all or selected repositories, and returns through the App setup callback.
4. The control plane validates callback state, associates the installation with
   the Memoro user, synchronizes the accessible numeric repository ids, and
   marks the connection ready.
5. mc polls a short-lived onboarding attempt id or the normal status endpoint.
   It receives metadata only, never a GitHub credential.
6. The current repository is matched to an authorized numeric repository id.
   Readiness is shown immediately and applies to both local and cloud sessions.

Do not require native `gh auth login`. A user's separately installed `gh`
configuration remains theirs and is neither imported nor modified.

### Connection states

| State | Meaning | Repair action |
|---|---|---|
| `disconnected` | no associated App installation | `connect` |
| `connecting` | browser installation flow is incomplete | `continue_connect` |
| `ready` | installation and current repository are authorized | none |
| `repo_not_installed` | App exists but current repository is not selected | `select_repository` |
| `permission_missing` | installation has not accepted required permissions | `update_installation` |
| `suspended` | GitHub installation is suspended | `resume_installation` |
| `revoked` | installation was deleted or access removed | `reconnect` |
| `unavailable` | GitHub or Memoro cannot currently verify readiness | `retry` |

Webhooks update installation/repository state, but every operation also checks
current authorization. A stale webhook cache must not grant access.

### Control-plane connection response

This response is user-facing and must not be injected wholesale into a coding
session:

```json
{
  "schema": 1,
  "state": "ready",
  "actor": { "type": "installation", "login": "memoro[bot]" },
  "repository": {
    "id": 123456789,
    "full_name": "meetmemoro/memoro-cli"
  },
  "operations": [
    "repository.metadata",
    "pull_request.list",
    "pull_request.view",
    "checks.list"
  ],
  "approval_mode": "prompt"
}
```

Installation ids, App ids, token expiry, private-key metadata, tokens, and
refresh tokens are not part of this response.

## Session capability contract

At session launch, mc resolves the repository through its known remote/catalog
and binds the capability server-side to:

- Memoro user id;
- `coding_session_id`;
- source id and source kind (`local` or `cloud`);
- numeric GitHub repository id;
- session branch/worktree policy;
- allowed operations and approval mode.

The coding tool receives only a token-free descriptor:

```json
{
  "schema": 1,
  "github": {
    "state": "ready",
    "transport": "mc-broker-v1",
    "actor": "installation",
    "account": "meetmemoro",
    "repository": {
      "id": 123456789,
      "full_name": "meetmemoro/memoro-cli"
    },
    "operations": [
      "repository.metadata",
      "pull_request.list",
      "pull_request.view",
      "checks.list"
    ],
    "approval_mode": "prompt"
  }
}
```

The descriptor is informational, not authoritative. The broker and server
re-authorize every operation. A descriptor copied to another worktree or
session grants nothing.

The existing token-free host capability prototype must become a general
`session-capabilities` surface. `MC_HOST_CAPABILITIES` and `MC_HOST_GH_BIN` are
transitional names, not public contracts.

## `github-op-v1` broker protocol

The canonical LLM-facing request is:

```json
{
  "type": "github_operation",
  "schema": 1,
  "request_id": "01K0...",
  "operation": "pull_request.list",
  "params": {
    "state": "open",
    "limit": 30
  }
}
```

There is deliberately no repo, installation, user, source, session, host,
token, URL, method, header, command, argv, env, GraphQL, or executable field.
The per-session broker endpoint supplies the trusted context. Parameters are
normalized and validated against the named operation's schema.

Success:

```json
{
  "ok": true,
  "request_id": "01K0...",
  "data": {}
}
```

Failure:

```json
{
  "ok": false,
  "request_id": "01K0...",
  "error": {
    "code": "approval_required",
    "message": "Creating this pull request needs approval.",
    "repair_action": "approve",
    "approval_id": "gap_..."
  }
}
```

Responses must be bounded, structured, and credential-redacted before they
cross the broker boundary. GitHub response headers and undocumented raw API
payloads are not returned by default.

### Stable errors

- `not_connected`
- `repo_not_installed`
- `permission_missing`
- `operation_not_allowed`
- `invalid_params`
- `approval_required`
- `approval_expired`
- `rate_limited` (with bounded `retry_after_seconds` when known)
- `conflict`
- `stale_head`
- `not_found`
- `unavailable`

The repair action is provider-independent. No error recommends exposing a token
or logging into `gh` inside the session.

## Operation allowlist

### Read-only foundation

| Operation | Parameters | Notes |
|---|---|---|
| `connection.status` | none | token-free readiness |
| `repository.metadata` | none | bound repository only |
| `pull_request.list` | state, author filter, bounded limit | normalized summary |
| `pull_request.view` | PR number | normalized PR/details |
| `checks.list` | PR number or server-resolved head | bounded check summary |

### Approved write slice

| Operation | Parameters | Required binding |
|---|---|---|
| `pull_request.create` | title, body, draft, server-known session branch | approval + idempotency |
| `pull_request.update` | PR number, title/body fields | approval + current PR state |
| `git.fetch` | server-approved remote refs | read policy; trusted executor |
| `git.push_session_branch` | expected local head sha | approval + exact session branch + non-force |

`git.fetch` may be automatically allowed by policy because it is a remote read,
but it still runs only in the trusted executor. Push accepts no destination
branch from the coding tool: the broker uses the session's registered branch.

### Explicitly deferred

- arbitrary REST/GraphQL and `gh api`;
- `gh` extensions and shell aliases;
- merge/auto-merge;
- force push, ref deletion, tags, releases, deployments;
- issue/comment/review mutations until each gets its own schema and approval
  preview;
- workflow dispatch, Actions rerun/cancel, secrets, variables, environments;
- repository/team/organization administration;
- user-to-server actor mode;
- cross-repository operations from one session.

Adding an operation is a security-surface change, not merely a CLI feature.
Each addition needs schema tests, authorization tests, redaction tests, approval
classification, audit coverage, and local/cloud parity tests.

## Local and cloud execution

The operation handler is source-agnostic until it reaches git transport:

| Concern | Local session | Cloud session |
|---|---|---|
| Capability identity | server-bound coding session | server-bound coding session |
| GitHub API reads/writes | central capability service | central capability service |
| Approval | terminal/browser policy surface | browser/attached terminal policy surface |
| Git filesystem executor | local mc broker, outside LLM child | sandbox sidecar/bootstrap, outside LLM child |
| Credential origin | control-plane token minter | control-plane token minter |
| Token storage | trusted memory only | trusted memory only |
| LLM protocol | `github-op-v1` | `github-op-v1` |

The local laptop is not required for a cloud operation. Conversely, a local
session does not inherit a cloud runtime token or depend on a local `gh` login.
Both need network access to Memoro and GitHub when an operation is executed.

## Git transport contract

Git transport is higher risk than central API execution because local commits
and worktrees live beside the coding session. It ships after read-only API
operations and approval infrastructure.

- Clone happens before the coding tool starts, in a trusted bootstrap process.
- Fetch and push are broker operations; the coding tool cannot run an
  authenticated credential helper directly.
- Prefer an in-process git transport or a one-shot helper channel bound to the
  spawned git PID, exact operation, repository, remote, and expiry.
- Never place credentials in a remote URL, command argument, general process
  environment, Git config, credential store, worktree file, or reusable socket.
- A credential callback must refuse a caller that is not the broker-spawned git
  process and must become unusable after the one operation.
- Push is non-force and only targets the registered session branch. The request
  includes the expected local head sha; a changed head produces `stale_head`.
- The executor validates the remote's resolved numeric repository id before
  sending credentials.
- The token is dropped from trusted memory immediately after the operation as
  far as the runtime permits.

Required adversarial proof: code running as the coding tool must be unable to
invoke, replay, inspect, or redirect the credential path to obtain a token or
authenticate a different git operation.

## Approval and audit contract

Default policy:

- status, repository metadata, PR reads, checks, clone, and fetch: automatic;
- PR creation/update and session-branch push: approval required;
- all deferred high-impact operations: denied, not promptable.

An approval preview shows the actor, repository, operation, target branch/PR,
normalized title/body or head sha, and whether GitHub will record the App as the
actor. Local approval may use the controlling terminal; browser approval works
for both local and cloud. The implementation must not depend on a provider's
native approval UI.

Every operation records an audit event containing:

- Memoro user, coding session, source kind, and numeric repository id;
- operation name, normalized non-secret target, request/idempotency id;
- policy decision and approval id/actor when applicable;
- start/end time, result class, and GitHub request correlation id when safe;
- no request authorization header, token, private key, raw environment, or
  unbounded response body.

Read audit retention may be sampled later, but all denied and write operations
are retained according to Memoro's security policy from the first release.

## `mc github` and `gh` compatibility

`mc github` is the canonical surface. Initial commands:

```text
mc github status
mc github connect
mc github repos
mc github pr list|view|checks|create|update
mc github fetch
mc github push
```

`mc auth github` remains an alias for status/onboarding continuity.

For coding tools that invoke `gh`, mc may place a session-scoped compatibility
shim ahead of the real binary in the coding-tool child `PATH`. The shim is a
parser and client for the same typed broker operations, not a token bridge or
general `gh` proxy.

Allowed compatibility surface grows only with the operation allowlist:

- `gh auth status` returns a redacted message that explicitly says the session
  is connected through the Memoro GitHub App;
- `gh pr list`, `gh pr view`, and `gh pr checks` map to read operations;
- `gh pr create` and narrowly supported update flags map to approved writes
  only after the write slice ships.

The shim must refuse `gh auth token`, `--show-token`, `gh api`, extensions,
unknown flags, unknown subcommands, and shell/alias expansion with a stable
non-zero exit and an `mc github` repair hint. It never falls through to a real
authenticated `gh` binary. Outside an mc coding-tool child, the user's normal
`gh` binary and configuration are untouched.

## Failure, recovery, and rollback

- GitHub/Memoro outage: return `unavailable`; do not use cached authorization to
  start a new write.
- Installation revoked/suspended: invalidate connection metadata and cached
  tokens immediately; active sessions lose the capability without restart.
- Repository removed from installation: deny subsequent operations even if the
  session descriptor still lists them.
- App permission changed: degrade to `permission_missing` and lead the user
  through an installation update.
- Broker disconnected: fail the operation; never bypass through local `gh`.
- Feature rollback: disable operation classes server-side. The broker treats a
  missing operation as denied and keeps the worktree/session usable.

Direct user-invoked `git` and `gh` outside the managed capability remain user
tools. mc does not delete or rewrite their credentials.

## Migration from current seams

There are two temporary implementations to retire:

1. The local host-keyring prototype (`MC_HOST_CAPABILITIES`, `MC_HOST_GH_BIN`,
   host `gh` preflight, and session shim delegation) addresses repeated local
   login prompts but cannot serve cloud. It is superseded by this contract and
   must not merge as the final architecture. If temporarily retained for
   dogfood, it must be behind an explicit off-by-default flag and must not grow
   new operations.
2. Cloud workspace bootstrap currently accepts `MC_CLOUD_GIT_TOKEN`,
   `MC_GIT_CLONE_TOKEN`, or `GITHUB_TOKEN` in the trusted launcher and scrubs
   them before the provider process starts. This is a bridge, not the target.
   Remove it after the cloud trusted-executor live proof; do not expose it to
   in-session operations.

Migration preserves no raw token. Existing mc vault entries that happen to be
named like GitHub credentials are ignored by this capability and are not
uploaded, converted, or silently deleted.

Rename token-free host capability concepts to source/session capability
concepts as the new broker protocol lands. Avoid compatibility aliases becoming
long-term public API.

## Rollout flags and observability

Use independent server-controlled flags so rollback does not require a CLI
release:

- `github_app_connection_v1`
- `github_operations_read_v1`
- `github_operations_write_v1`
- `github_git_transport_v1`
- `github_gh_shim_v1`

Recommended rollout: staff installation -> one read-only repository -> local
read dogfood -> cloud read dogfood -> approved PR create -> local session-branch
push -> cloud clone/fetch/push -> broader repository selection.

Metrics use operation names, result codes, latency, source kind, and coarse
GitHub status. They never contain owner/name for private repositories unless
explicitly classified as allowed metadata, and never contain PR bodies, remote
URLs with credentials, headers, or token fragments.

## PR plan

The sequence follows the coordinator contract: one repository per PR, tests
first, explicit negative scope, server deploys before dependent client slices,
and live gates between high-risk slices. PR numbers below are delivery order,
not promises that all code lands in this repository.

### PR 0 — contract only (`memoro-cli`, this plan)

In scope:

- land this normative contract and cross-links;
- mark the host-keyring implementation as superseded architecture;
- keep generated agent wrappers synchronized with canon.

Not in scope: production auth behavior, App registration, endpoints, shims, or
token handling. The current dirty host-keyring prototype must be removed from
the PR diff or moved to a separate explicitly transitional branch before this
PR is opened.

Gate: docs/canon drift tests and coordinator review of trust boundaries.

### PR 1 — App installation and repository catalog (`memoro` server)

In scope:

- GitHub App setup callback with CSRF/state validation;
- user-to-installation and numeric repository-id metadata model;
- connection status, connect URL, repository selection/status endpoints;
- installation/repository/permission webhooks and revoke handling;
- feature flag and token-free audit events.

Not in scope: minting tokens for session operations, broker requests, user
access tokens, writes, or git transport.

Tests first: callback ownership/replay, cross-user isolation, webhook signature
and ordering, revoked/suspended state, repo rename/transfer, no secrets in API
responses/logs.

External gate: register the Memoro GitHub App with an initial read-only
permission set (Metadata, Contents, Pull requests, Checks, and Commit statuses),
configure its private key in infrastructure secret storage, deploy behind both
the production admin boundary and an independent off-by-default feature flag,
and complete install/select/replay/rename/remove-and-readd/suspend/resume/revoke/
reconnect live proof. This program does not depend on a separate staging
environment. If no second admin or dedicated transfer test organization exists,
the live cross-user and transfer proofs remain release gates before access is
expanded beyond admin dogfood; their automated isolation and ordering tests
must still pass in PR 1. Later PRs upgrade Contents or Pull requests to write
only when the corresponding operation is ready to release.

### PR 2 — read-only GitHub capability service (`memoro` server)

Depends on deployed PR 1.

In scope:

- installation-token minter with one-repository/minimum-permission narrowing;
- server-side session/repository authorization;
- typed handlers for `connection.status`, `repository.metadata`,
  `pull_request.list`, `pull_request.view`, and `checks.list`;
- bounded normalized responses, stable errors, redaction, rate-limit handling,
  and audit correlation.

Not in scope: returning tokens, git transport, writes, arbitrary API/GraphQL,
or browser approval.

Tests first: token request scope, expired-token retry once, no durable token
write, stale/revoked installation denial, cross-repo/session denial, unknown
field rejection, response bounds, log/exception redaction.

Gate: deploy behind the production admin boundary and read-operations flag, then
call every read operation through an authenticated admin test session without
exposing token bytes. Keep broader access disabled until the deferred PR 1
cross-user live proof has passed.

### PR 3 — connection UX and shared schemas (`memoro-cli`)

Depends on deployed PR 2.

In scope:

- versioned token-free connection/session descriptors and `github-op-v1`
  codecs;
- `mc github status|connect|repos` and `mc auth github` alias;
- setup/onboarding integration that opens or prints the Memoro connect flow;
- provider-independent help and repair messages;
- rename the prototype concept from host to session capabilities.

Not in scope: broker operation execution, `gh` shim, writes, git transport,
native `gh` login, or local-keyring fallback.

Tests first: state rendering/JSON contract, no credential fields, noninteractive
behavior, repository mismatch, all onboarding repair actions, adapter parity.

Gate: a new user connects once and both a prospective local and cloud session
report the same repository readiness metadata.

### PR 4 — read-only broker operations and compatibility (`memoro-cli`)

Depends on deployed PR 2 and merged PR 3.

In scope:

- session-bound broker dispatch for the five read operations;
- Memoro-authenticated control-plane client kept outside the coding-tool child;
- identical local/cloud source handling and reconnect/error behavior;
- session-scoped `gh` shim for `auth status`, `pr list`, `pr view`, and
  `pr checks` only;
- grounding that prefers `mc github` and never asks for a token.

Not in scope: write operations, real-`gh` passthrough, git transport, native
provider approval hooks, or host-keyring fallback.

Tests first: copied descriptor grants nothing, source/repo spoof fields refused,
cloud works with local source offline, shim parser rejects every non-allowlisted
surface, child env/argv/file/log scan contains no credentials, local/cloud
contract fixtures are byte-equivalent where source is irrelevant.

Gate: live local and cloud sessions list/view the same PR/check data while the
host `gh` is logged out or absent.

### PR 5 — write policy, approval, and audit (`memoro` server/browser)

Depends on successful read-only dogfood.

In scope:

- operation policy and approval records bound to exact request previews;
- browser approval/deny/expiry flow usable by local and cloud sessions;
- idempotency and head/state preconditions;
- central `pull_request.create` and `pull_request.update` handlers;
- write audit events and server-side kill switches.

Not in scope: git credentials/grants, push/fetch, merge, force operations, or
provider-native approval UI.

Tests first: approval substitution/replay/cross-user/cross-session denial,
expiry, duplicate request id, concurrent PR state change, browser CSRF, audit
redaction, flag rollback.

External gate: update the App's Pull requests permission to read/write and prove
the installation-update flow for an existing user. Then deploy and create one
draft PR from a cloud session after browser approval; denial and expiry must
leave GitHub unchanged.

### PR 6 — approved PR writes in mc (`memoro-cli`)

Depends on deployed PR 5.

In scope:

- broker round-trip for approval-required results;
- terminal/browser-neutral wait, approve/deny, timeout, and retry semantics;
- `mc github pr create|update`;
- narrow `gh pr create` compatibility using the same operation.

Not in scope: git push/fetch, merge, arbitrary PR flags/API, or automatic
approval.

Tests first: provider parity, normalized approval preview, cancellation,
disconnect/reconnect, stale approval, idempotent retry, shim flag rejection.

Gate: local and cloud live proof produce equivalent approval and audit behavior.

### PR 7 — one-shot git grants (`memoro` server)

Depends on write policy live proof and a reviewed git threat model.

In scope:

- server authorization for clone/fetch/session-branch push;
- shortest-practical, repository/permission-scoped installation token delivery
  over a trusted executor channel;
- operation nonce, expiry, redemption-once semantics, expected repo/branch/head,
  and audit event;
- separate kill switch from API writes.

Not in scope: returning a token to mc commands/coding tools/browser, general git
credential service, force push, arbitrary refs/remotes, or persistent cache.

Tests first: replay, wrong executor/session/repo/op, expired grant, concurrent
redemption, log/error/trace redaction, App permission mismatch.

External gate: update the App's Contents permission to read/write and prove the
installation-update flow. Security review must then approve the local and cloud
executor channel before either client implementation begins.

### PR 8 — local trusted git executor (`memoro-cli`)

Depends on deployed PR 7.

In scope:

- broker-owned clone/fetch/push primitives for a bound repository;
- one-shot credential callback inaccessible to the coding-tool child;
- non-force session-branch push with expected-head validation;
- `mc github fetch|push` and matching typed broker operations.

Not in scope: cloud bootstrap, arbitrary git args/refspecs, storing credentials,
or changing the user's normal git credential configuration.

Tests first: hostile helper invocation/replay/redirect, process/env/argv/config
scan, wrong remote, remote rename, stale head, force/ref deletion denial,
cleanup on crash/timeout.

Gate: live push from a local session with no native `gh`/GitHub keyring login;
the pushed branch and audit event must name only the registered session target.

### PR 9 — cloud bootstrap and trusted git executor (`memoro` cloud runtime)

Depends on deployed PR 7 and accepted local executor security proof.

In scope:

- sidecar/bootstrap consumption of one-shot clone/fetch/push grants;
- private repository bootstrap before the coding tool launches;
- cloud broker route to the same `git.fetch`/`git.push_session_branch` contract;
- crash/stop cleanup and source-aware audit.

Not in scope: raw token env, general sandbox credential helper, free shell API,
or local-machine involvement.

Tests first: malicious workspace cannot read/reuse helper path, no credential in
sandbox command/env/file/log/session response, stop/restart/replay, wrong repo,
sidecar unavailable, local/cloud protocol fixture parity.

Gate: private repo cloud live proof with the laptop broker offline: clone, read
PR/checks, create approved draft PR, push session branch, stop, then prove grant
replay fails.

### PR 10 — migration and default-on cleanup (`memoro-cli`)

Depends on local and cloud live proofs plus server flags in production.

In scope:

- enable central capability for eligible users;
- remove `MC_HOST_GH_BIN`, host-`gh` preflight/delegation, and local-keyring
  architecture;
- remove client support for legacy GitHub token bridges once cloud runtime no
  longer sends them;
- finalize setup/help/release notes and regression matrix.

Not in scope: migrating GitHub tokens into vault or adding deferred operations.

Tests first: upgrade from pre-capability mc, disconnected/revoked repair,
feature-flag rollback, native `gh` unaffected outside mc, complete forbidden-
secret scan.

Gate: staged rollout metrics and support runbook show no repeated-login loop and
no local/cloud behavior divergence.

## End-to-end acceptance

The program is complete only when all statements below are true:

- A new user installs the Memoro GitHub App once, selects a private repository,
  and sees it ready in both local and cloud mc.
- The same read/write operation names, parameter validation, approvals, errors,
  and audit fields work for every supported LLM provider and source kind.
- A cloud session can complete the full live proof while the user's laptop is
  offline.
- Expired one-hour installation tokens renew without user action or session
  restart.
- Revoking the installation or repository access denies the next operation in
  active sessions.
- `gh auth token`, `--show-token`, `gh api`, unknown commands/flags, arbitrary
  repos/refspecs, merge, and force push are refused inside the managed shim.
- Automated secret scans and adversarial tests find no GitHub credential in mc
  vault, child env/argv/files, git config/remotes, prompt/transcript, logs,
  browser traffic, session records, or reusable helper endpoints.
- Direct `gh` outside an mc coding child is unchanged.
- Removing the server flag disables GitHub operations without breaking session
  attach, editing, transcript, or normal unauthenticated local git work.

## Implementation-session handoff

For every PR/drev, the implementation session must:

1. read this whole contract and the repo's coding-agent protocol;
2. write failing contract/security tests before implementation;
3. list positive and negative scope in the PR body;
4. record every judgment call, especially any new field, operation, credential
   boundary, fallback, or source-specific branch;
5. stop and escalate rather than inventing arbitrary API/command passthrough or
   a new place to store token material;
6. report test counts, secret/redaction proof, live proof when required, and the
   next deployment dependency.

## Authoritative GitHub references

- [Generating an installation access token for a GitHub App](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/generating-an-installation-access-token-for-a-github-app)
- [Authenticating as a GitHub App installation](https://docs.github.com/en/enterprise-cloud@latest/apps/creating-github-apps/authenticating-with-a-github-app/authenticating-as-a-github-app-installation)
- [Generating a user access token for a GitHub App](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/generating-a-user-access-token-for-a-github-app)
- [Authenticating on behalf of a user](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/authenticating-on-behalf-of-a-user)
