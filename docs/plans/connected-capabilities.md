# Connected capabilities for mc

**Status:** normative foundation contract · local-first rollout

This contract defines one provider- and coding-tool-independent way to connect
external systems to mc. GitHub is the first typed service capability built on
it. Cloudflare, coding-tool runtimes, and future providers must use the same
connection, readiness, repair, source-binding, and credential-custody model
rather than adding provider-specific authentication paths to mc commands.

The provider-specific contract still owns its resource model, permissions, and
typed operations. This contract owns how a user, source, session, and provider
connection meet.

## Product contract

A user should experience one connection surface:

1. Sign in to mc once on a device.
2. `mc connections` shows every supported provider and whether it is ready for
   local and cloud use.
3. `mc connections connect <provider>` performs the provider's one-time
   onboarding or redirects to its native login when the provider must own
   authentication.
4. Resource selection, permission upgrades, suspension, revocation, and repair
   use the same bounded states and actions for every provider.
5. A new coding session receives token-free descriptors for the capabilities
   available to its exact source, session, and selected resources.
6. The coding-tool host applies the user's native approval settings to
   mutating tool invocations. mc adds no second approval preference or prompt.
7. Local and cloud sessions call the same typed operations and hard policy.
   Source kind chooses the trusted transport, never a weaker authorization
   rule.

`mc github status|connect|repos` remains a provider-specific convenience
surface. It must delegate to the common connection client and must not own an
authentication or credential-storage path.

## Three separate authorities

### 1. Memoro device or workload identity

This answers: *which Memoro user and trusted source is asking?*

- A local mc process authenticates through one first-party Memoro device
  identity.
- A cloud broker authenticates through a Memoro-issued workload identity bound
  to the cloud runtime and user.
- The identity layer exchanges that durable bootstrap authority for a
  short-lived broker grant.
- Provider implementations never read the device credential, OS credential
  store, environment fallback, browser cookie, or workload credential.
- The first-party device credential is not provider material and is never
  stored in mc vault. Its persistence is owned exclusively by the common mc
  identity service behind a platform-neutral interface.

Smooth local onboarding requires one durable first-party device identity. On
macOS the identity service may use Keychain; equivalent secure stores may be
used on other operating systems. This is the only allowed Keychain dependency
in the connected-capability path. A provider command, adapter, codec, session
broker, or executor must not import or call the Keychain module.

### 2. Provider connection

This answers: *what external account, installation, or native runtime has the
user connected?*

A provider declares one credential-custody mode:

| Mode | Custodian | Examples | What mc receives |
|---|---|---|---|
| `control_plane` | Memoro connection service | GitHub App, Cloudflare OAuth | Metadata and token-free capability state |
| `native_runtime` | The installed coding tool | local Codex, Claude Code, Gemini | Bounded readiness signal only |
| `workload` | Memoro cloud orchestrator | cloud coding runtime | Token-free workload capability state |

These modes share the public state machine and descriptor. They do not pretend
that every provider has the same credential mechanism.

Provider credentials are never mc vault material. Control-plane credentials
are held by the provider connection service in infrastructure secret storage
or encrypted per-user connection storage, according to the provider's own
threat model. Native-runtime credentials remain owned by the native runtime;
mc does not copy, export, or broker them. Workload credentials remain inside
the cloud trust boundary.

### 3. Broker grant

This answers: *what may this exact trusted broker do right now?*

The Memoro control plane issues a short-lived, audience-restricted grant bound
to:

- Memoro user id;
- source id and source kind (`local` or `cloud`);
- coding session id when the request is session-scoped;
- provider id;
- selected resource identities;
- allowed capability family;
- issue and expiry times plus a unique grant id.

The grant is held only in trusted broker memory. It must not enter the coding
tool's environment, argv, files, prompt, transcript, logs, browser payloads,
session records, git configuration, or mc vault. It cannot call unrelated
Memoro APIs or another provider. Session grants cannot be copied between local
and cloud sources or between sessions.

## Public connection descriptor

Every provider is represented by the same token-free envelope:

```json
{
  "schema": 1,
  "provider": {
    "id": "github",
    "label": "GitHub",
    "custody": "control_plane"
  },
  "state": "ready",
  "repair_action": null,
  "account": {
    "id": "provider-stable-opaque-id",
    "label": "display label"
  },
  "resources": [],
  "sources": {
    "local": "ready",
    "cloud": "unavailable"
  },
  "capabilities": [
    {
      "name": "pull_request.list",
      "effect": "read"
    }
  ]
}
```

The envelope may be narrowed for a session. It must never contain tokens,
cookies, private keys, authorization headers, credential references, secret
store paths, executable paths, arbitrary URLs, or provider-specific request
fragments. Provider extensions must be explicit versioned schemas, not
unvalidated maps.

Stable provider resource ids are authoritative. Names are display metadata and
may change.

## Common states and repair actions

Connection states:

- `unsupported`
- `disconnected`
- `connecting`
- `ready`
- `resource_not_selected`
- `permission_missing`
- `suspended`
- `revoked`
- `unavailable`

Source readiness is evaluated separately, so a provider connection can be
ready while its cloud executor is not released.

Repair actions:

- `connect`
- `resume`
- `select_resource`
- `accept_permissions`
- `reconnect`
- `retry`
- `contact_admin`

Provider contracts may narrow when an action is valid but may not invent a
second generic state vocabulary. Unknown states or actions fail closed.

## Common command surface

The canonical provider-neutral UX is:

```text
mc connections [--json]
mc connections status <provider> [--json]
mc connections connect <provider>
mc connections repair <provider>
mc connections disconnect <provider>
```

Provider aliases may add resource-oriented read commands, such as
`mc github repos`, but connection lifecycle behavior and JSON envelopes remain
common. `disconnect` is an explicit user mutation and must describe whether it
revokes a provider connection, removes only a source binding, or delegates to
the native runtime before executing.

Setup/onboarding consumes the same registry. Adding a provider must not require
new provider-specific branches in the core setup command.

## Session and operation flow

```text
local device identity                 cloud workload identity
          |                                      |
          +------ common identity exchange ------+
                             |
                   short-lived broker grant
                             |
            trusted local or cloud session broker
                             |
              typed provider operation request
                             |
              Memoro capability control plane
                             |
         provider API or narrowly trusted executor
```

The coding-tool child sits beside, not inside, this credential path. It receives
only a token-free descriptor and a bounded broker transport.

Operation contracts additionally bind immutable user, source, session, provider
resource, normalized parameters, effect, idempotency identity, and required
preconditions. A copied descriptor grants nothing.

## Coding tools

Codex, Claude Code, Gemini, and future LLM tools are providers in the connection
registry for onboarding and readiness, but they are also coding hosts.

- Local native login remains owned by the installed tool.
- mc may call a documented, token-redacted readiness probe.
- mc never reads or copies the tool's access or refresh token.
- A tool adapter renders launch conventions; it does not implement connection
  identity, provider policy, or service credential brokerage.
- Cloud coding authentication is represented by the same provider id and
  source readiness but is established by the cloud orchestrator.
- Host approval settings govern whether a mutating invocation reaches mc.
  Connection state never encodes an approval preference.

## GitHub and Cloudflare

GitHub uses `control_plane` custody through the central Memoro GitHub App.
Installation metadata selects repositories; App credentials and installation
tokens stay in the control plane. The GitHub session broker consumes a scoped
broker grant and never reads a local Memoro or GitHub credential.

Cloudflare should also use `control_plane` custody for user-connected accounts
and resources. Its provider contract must define OAuth or narrowly scoped token
onboarding, encrypted central custody, account/resource selection, typed
operations, and a separate trusted executor boundary. It must not expose a
general authenticated `wrangler`, arbitrary API URL, or raw token to a coding
session.

Cloudflare implementation is not part of the GitHub local milestone. The common
contract is its prerequisite so it does not grow a parallel auth system.

## Security invariants

1. Provider implementations do not import or call OS credential-store or mc
   vault modules.
2. Only the common identity service may read the first-party local Memoro
   device credential.
3. Provider credentials never enter mc vault.
4. Broker grants are short-lived, audience-restricted, source-bound, and kept
   in trusted memory.
5. No credential or broker grant enters the coding-tool child or its observable
   surfaces.
6. Provider connection metadata grants no operation by itself.
7. All operations use explicit versioned schemas, hard allowlists, immutable
   server bindings, and effect classification.
8. Local and cloud share authorization semantics; source-specific transports
   cannot weaken policy.
9. Native-runtime custody is never an implicit fallback for a control-plane
   provider.
10. Uncertain identity, connection, resource, grant, precondition, or provider
    response fails closed with a common repair action.
11. Revocation prevents new grants immediately. Existing grants have short
    bounded expiry and may be denied early by server-side revocation state.
12. Audit records contain stable identities, operation names, effects, and
    outcomes, but no credential, grant, request body, provider response body, or
    user-authored content unless a provider contract explicitly justifies a
    bounded field.

## Acceptance gates

The foundation is complete when:

- GitHub, one native coding tool, and a Cloudflare fixture render the same
  connection envelope and state/repair vocabulary;
- provider code cannot import Keychain or vault modules, enforced by a contract
  test;
- local and cloud fixtures receive byte-equivalent narrowed descriptors where
  source availability is irrelevant;
- a copied descriptor or broker grant cannot cross user, source, session,
  provider, or resource boundaries;
- a coding-tool child secret scan contains neither provider credentials,
  Memoro device credentials, nor broker grants;
- setup discovers providers through the registry without provider-specific
  branching;
- GitHub read/write live proof succeeds while the host `gh` login is absent and
  no GitHub-specific local auth storage exists.

## Corrective PR plan

### C1 review of the shipped GitHub slices

The 2026-07-23 review found:

| Finding | Result | Disposition |
|---|---|---|
| GitHub App private key and installation tokens stay in the control plane | Pass | Retain |
| Session descriptors, typed operation codecs, repository/session binding, write idempotency, preconditions, effect classification, and host-native approval boundary are token-free | Pass | Retain |
| Launch runtime scrubs `MEMORO_TOKEN` and GitHub token variables before creating the coding-tool child environment | Pass | Retain and extend to broker grants |
| `src/mc/commands/github.js` imports the legacy Keychain module and reads `ACCOUNTS.TOKEN` | Blocker | Remove in C3/C4 |
| `src/mc/broker/launch-client.js` and `src/mc/commands/broker.js` resolve a generic long-lived Memoro token from environment or Keychain | Blocker | Replace with common identity exchange in C3 |
| GitHub control-plane operations authenticate with the generic Memoro token rather than a short-lived provider/source/session-scoped broker grant | Blocker | Add grant validation in C2 and migrate in C4 |
| GitHub setup/status owns provider-specific auth branches instead of a common connection registry | Blocker for the general model | Replace in C3 while retaining aliases |
| Cloud and local do not yet establish the same grant schema through device and workload identities | Blocker for cloud parity | Implement in C2/C3 before any cloud claim |
| Production `GITHUB_OPERATIONS_WRITE_V1` is false | Pass | Keep false through C1-C4 |

No evidence of a GitHub credential entering mc vault, child env, prompt,
transcript, or session metadata was found. The correction is an authority and
portability fix, not a response to a known credential leak.

### C1 — common contract and GitHub review (`memoro-cli`)

- land this contract and make the GitHub capability contract depend on it;
- record the direct `getSecret(ACCOUNTS.TOKEN)` path as a blocking deviation;
- review already-merged GitHub slices against the three-authority model;
- keep production GitHub writes disabled.

No runtime code, server route, provider migration, flag change, or live write is
in scope.

### C2 — broker-grant issuance (`memoro`)

- add local-device and cloud-workload exchange paths that issue the same
  short-lived scoped broker-grant schema;
- validate user, source, session, provider, resource, audience, expiry, and
  revocation below provider routes;
- allow existing typed GitHub connection and operation routes to authenticate
  through a grant without accepting a repository or provider authority from
  the client;
- keep legacy Memoro API-token auth compatible for unrelated endpoints only.

No GitHub credential delivery, cloud executor, general OAuth broker, arbitrary
provider API proxy, or production write enablement is in scope.

### C3 — common identity and connection client (`memoro-cli`)

- add one trusted identity broker as the only reader of first-party local
  Memoro device identity;
- add the provider registry, common descriptor codecs, commands, states, repair
  actions, and setup integration;
- exchange device identity for broker grants and retain them only in broker
  memory;
- add native-runtime and control-plane test providers without reading their
  credentials.

No provider operation migration, Cloudflare live connection, coding-tool token
copying, or vault integration is in scope.

### C4 — migrate GitHub to the common broker (`memoro-cli`)

- remove direct Keychain imports and generic Memoro API-token reads from all
  GitHub commands, launch preparation, sidecars, and session operations;
- route GitHub lifecycle aliases and typed operations through the common
  connection/session broker;
- preserve the shipped GitHub schemas, hard policy, idempotency, shims, and
  native host approval behavior;
- repeat secret, child-boundary, local/cloud parity, and negative-command tests.

No git clone/fetch/push grants, cloud Sandbox executor, Cloudflare provider, or
write flag change is in scope.

### C5 — local GitHub acceptance

- deploy C2 with writes disabled;
- install C3/C4 from merged main;
- repeat exact new-user connect/select/session read flow;
- temporarily enable GitHub writes for the admin dogfood window;
- prove host allow/deny behavior, one draft PR, replay, substitution denial,
  stale precondition, and audit redaction;
- return the flag to disabled immediately if any gate fails.

Only after C5 passes may the existing GitHub git-transport and broader rollout
plan continue.
