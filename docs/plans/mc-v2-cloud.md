# mc V2 — portable account environment and cloud host parity

**Status:** in-flight · revised 2026-07-26 · implementation plan under
[`mc-contract.md`](mc-contract.md).

This plan delivers the product promise:

> Install `memoro-cli` on a new device, sign in with the user's memoro.me
> identity, and reconcile the same coding environment — tools, account
> connections, permissions, custody-backed logins and secrets, repositories,
> and work continuity. Starting a session in CodingApp performs the same logical
> bootstrap on a clean cloud host, with no dependency on an online laptop.

Local and cloud are peer hosts for one account environment. They use the same
identity, policy, custody, capability, bootstrap, and continuity contracts.
Host-specific installation and isolation mechanisms may differ, but their
security and user-visible outcomes may not.

This plan replaces the earlier assumption that V1 local parity was already
complete. The current code contains important foundations, but the full local
golden path, executable secret policy, credential isolation, private-repository
bootstrap, and cross-host work restore are not complete.

## Current S0 implementation status

Cloud workload transport now has a narrow broker-ticket bootstrap: authenticated
ticket minting binds the active runtime, and a queryless WebSocket upgrade
atomically consumes an opaque single-use ticket with a versioned, 64 KiB-bounded
control wire. This is transport hardening only, not approval to carry a
credential, grant, or recipient key.

S0 remains unpassed. Recipient registration and grant routes are still absent;
the provider starts before recipient registration; the attach token remains in
a control payload and URL; and Cloudflare same-sandbox execution is not a
credential boundary. Release gates fail closed, but trusted production release
inputs, artifact-byte verification, signed trust-bundle delivery, and external
platform image/instance attestation are not live. No credential, provider token,
CRK, DEK, or decryptable grant may enter this runtime.

## 1. Non-negotiable invariant: credentials never enter the LLM domain

This is gate zero for every slice.

No secret, login artifact, provider token, raw key, CRK, DEK, recovery material,
or equivalent credential may be exposed to the **LLM domain**, including:

- model context or tool results;
- the model-directed command executor;
- its files, mounted paths, environment, argv, stdin, stdout, or stderr;
- shell history, process listings, `/proc`, debuggers, core dumps, or peer
  process inspection;
- PTY output, broker messages, runtime status, readiness, logs, audit events,
  transcripts, snapshots, or browser payloads;
- a helper, socket, or command that the LLM can repurpose to retrieve or proxy
  unrestricted credential authority.

`0600`, environment scrubbing, read-block hooks, redaction, short lifetime, and
shredding are defence in depth. None is an isolation boundary when the
credential owner and model-directed commands share an OS principal or readable
namespace.

`mc` and `mc vault` form a trusted custody and capability subsystem outside the
LLM domain. The LLM receives only:

- opaque, session-scoped capability handles;
- bounded typed operations;
- redacted operation results;
- access to a bounded endpoint implemented by an immutable trusted adapter,
  when an operation requires custody-backed authority.

If a coding tool cannot keep its provider credential outside the model-directed
command executor, that integration must fail closed and remain unsupported for
portable credential bootstrap. The plan must not claim compliance based on a
protected file that the LLM can still cause another process to read.

## 2. Product journeys

### 2.1 New local device

1. The user installs `memoro-cli` and runs `mc`.
2. `mc` completes memoro.me device authorization and resumes only a persisted,
   versioned, idempotent bootstrap intent. It never replays arbitrary original
   argv after login.
3. The same user-visible authorization journey establishes a user-held custody
   unlock on the new device. The target primary path is a passkey-bound account
   unlock wrap with user verification. An approved existing device or recovery
   code is the fallback; an existing master password is used once to migrate
   password-based custody. A bearer token alone is never sufficient to decrypt
   custody.
4. `mc` fetches the account environment manifest and reconciles:
   - approved coding tools at exact allowed versions;
   - the Coding Profile and managed configuration;
   - account-owned provider connections and permission policy;
   - available repositories and coding sessions;
   - custody readiness, without exporting a credential.
5. The user selects or resumes work. `mc` checks out the repository through a
   scoped repository capability and restores the latest safe checkpoint.
6. A per-session isolated credential domain receives only the grants required
   by that tool, project, and session.
7. The coding tool starts. No separate provider login or manual secret setup is
   required when valid account custody and permissions already exist.

Passkey capability and recovery support are platform gates, not assumptions. If
the supported browser/OS cannot provide a user-held wrapping primitive, the
bootstrap must use approved-device or recovery authorization and say so. Memoro
must not gain a durable bulk-decryption key to remove this step.

### 2.2 CodingApp cloud session

1. The signed-in user selects a repository, tool, and task in CodingApp.
2. The control plane creates a pending cloud session and an audience-bound
   workload identity.
3. The clean sandbox starts from an approved, measured image. Before any LLM
   process starts, its protected credential broker consumes a single-use
   control-plane challenge and generates an ephemeral session keypair; the
   private key never leaves that broker.
4. CodingApp verifies the canonical signed authorization request, recipient
   key registration, image/release identity, account environment revision, and
   permission scope. After user presence and custody unlock, the client signs
   the request digest and re-wraps only the selected DEKs to the sandbox session
   public key.
5. The control plane stores and delivers opaque, expiring grants. It never
   receives an unwrapping key.
6. The sandbox reconciles the same account environment:
   - verifies pinned tools and runtime versions;
   - checks out the private repository through a typed repository capability;
   - restores the latest safe work checkpoint;
   - activates brokered provider capabilities;
   - makes custody-backed authority available only inside the isolated
     credential domain.
7. The real `mc` session starts and connects to CodingApp through the existing
   broker.
8. On sleep or stop, the runtime checkpoints work, revokes workload and
   capability grants, drops decrypted key material, destroys the credential
   domain, and the control plane destroys the sandbox.

The laptop may remain offline throughout this journey. The phone or browser
starting CodingApp is the authorizing user client; execution is cloud-only after
authorization.

Sleep retains account/session metadata and the verified checkpoint, but not the
runtime keypair or an unwrapped DEK. Wake creates a new runtime and keypair and
requires a new user-authorized re-wrap. Stop is final. A compromised sandbox
cannot attest to its own cleanup: only control-plane/platform destruction
confirmation completes either transition.

## 3. Existing foundations to keep

The following implemented work is the base, not work to recreate:

- memoro.me device flow and per-device Memoro tokens;
- account-backed vault ciphertext and the CRK/per-secret-DEK custody envelope;
- custody recovery, device registration, and revocation metadata;
- explicit coding-tool auth adoption into custody;
- connection descriptors and the GitHub App typed capability model;
- account-scoped Coding Profile and coding-session context;
- CodingApp's typed cloud-session UI and API;
- cloud-session Durable Object lifecycle and audience-bearing `mc.cloud`
  workload tokens;
- Cloudflare Sandbox provisioning, runtime manifest, `mc cloud-runtime`
  supervisor, broker bridge, readiness, audit, sleep/continue, and coding-bin
  snapshots.

These are code-tested foundations, not production-proven parity. No existing
test demonstrates the full production Cloudflare Sandbox + private repository +
broker + custody journey.

The following current paths are transitional or unsafe and must not become the
V2 design:

- executable `.mc/secrets.json` or other repo-writable authority;
- persistent `mc vault hydrate` output treated as a managed-session isolation
  boundary;
- the disabled legacy cloud `tool_auth.<tool>` bridge;
- raw GitHub tokens in sandbox environment variables or global worker secrets;
- a repository-required session with no usable clone target becoming ready with
  an empty workspace;
- a cloud runtime token accepted for a path session different from its
  `audience`;
- floating coding-tool package versions in the cloud image;
- local registry paths treated as portable server truth.

## 4. State ownership

### 4.1 Account environment

The control plane owns a revisioned, non-secret **account environment
manifest**. It contains:

- Coding Profile revision and managed configuration revision;
- approved tool identifiers and exact versions;
- connection descriptors and readiness, never provider credentials;
- account permission policy and grants by resource and typed operation family;
- project descriptors and canonical repository identity, including provider
  numeric repository ID, canonical owner/name, and immutable requested ref/SHA;
- coding-session descriptors and latest safe checkpoint;
- opaque custody record identifiers, classes, and capability bindings;
- repair requirements and minimum compatible runtime/image versions.

The manifest must never contain plaintext credentials, wrapped root keys,
recovery material, or a reusable provider token.

Authorization-relevant manifest and binding revisions are canonicalized and
signed by an authorized user device. The control plane may store and serve them,
but cannot silently broaden a policy and induce a custody client to re-wrap an
additional record. A changed policy requires a new user-authorized revision.

Revisions form a signed hash chain with a monotonically increasing account
environment sequence, explicit active/revoked state, and a minimum accepted
revision. The user-held custody/authorization chain, not a mutable server field,
controls device-key enrollment, rotation, revocation, recovery, and rollback.
Existing clients retain a revision watermark; a new client obtains and verifies
the current head through passkey-bound, approved-device, or recovery authority.
An intentional rollback is a new signed recovery event. An older valid signature
must never revive a revoked device, record, policy, or capability.

### 4.2 Host-local state

Each host owns:

- its Memoro device or workload identity;
- a host/session keypair and OS isolation material;
- installed binaries and dependency caches;
- checked-out worktrees;
- a local projection of the account session registry;
- ephemeral decrypted session state inside the credential domain.

Host-local absolute paths, PTYs, process IDs, native tool-session IDs, caches,
and device tokens are never synchronized as account truth.

### 4.3 Project capability bindings

Replace legacy repo file/env bindings with account-owned, authenticated project
policy:

- a binding selects an opaque custody record and a typed use;
- it is scoped to a canonical project/repository and immutable trusted adapter;
- writes are default-deny and require explicit user consent;
- repo content may declare a capability requirement but cannot grant authority
  or choose an arbitrary custody record;
- the control plane may know resource and operation metadata, but never the
  secret value;
- every session receives a narrowed immutable, user-signed policy revision.

Examples of typed uses:

- `provider.tool-auth:codex`;
- `provider.tool-auth:claude-code`;
- `provider.operation:cloudflare/kv.read`;
- `trusted-adapter.operation:deployment/status.read`;
- `provider.operation:github/repository.read`.

Generic “write this secret into this repo file or LLM environment” is not a
supported use. Neither is “start arbitrary repo code with this secret”.

## 5. Common session authorization

Local and cloud sessions use the same grant envelope. The wire format must use a
standard, audited construction rather than bespoke ECDH framing:

- JWE JSON Serialization;
- `alg=ECDH-ES`, `enc=A256GCM`, P-256 recipient keys;
- a protected header with `typ=mc-dek-grant+jwe`, schema, grant ID, recipient
  key ID, and the digest of the canonical authorization statement;
- one custody DEK as the encrypted payload;
- no scope-bearing value accepted from unprotected delivery metadata.

1. The isolated session credential domain generates an ephemeral public key.
2. The control plane produces a canonical authorization request from the
   user-signed account policy and the locked recipient registration.
3. A trusted user client verifies the policy signature, canonical repository
   identity, immutable ref, recipient challenge and runtime generation,
   release/image identity, active policy/device revision, exact opaque custody
   record IDs, typed uses, trusted-adapter artifact digests, operation/parameter
   constraints, record classes, and maximum expiry. It decrypts labels locally
   for confirmation where needed; plaintext labels are not returned to the
   control plane.
4. After explicit user confirmation, the client unwraps only the selected DEKs
   and re-wraps them to the session public key. It signs a canonical grant
   commitment covering the request digest, grant ID, protected-header digest,
   full JWE serialization/ciphertext digest, recipient-key digest, and exact
   custody record ID. The signature is not merely over the earlier request.
5. The protected authorization statement binds at least:
   - schema and grant ID;
   - account ID;
   - host/source kind;
   - cloud/local session ID, runtime generation, and coding-session ID;
   - recipient key ID and public-key digest;
   - exact custody record ID, class, and typed use;
   - trusted-adapter digest, operation, resource, and parameter constraints;
   - project, account-environment sequence, policy revision, and parent digest;
   - issued-at and expiry.
6. Grant storage verifies the user-device signature over the commitment and
   atomically checks the active environment/policy revision and device-key
   status before binding the exact signed blob to the locked request and
   recipient. The recipient validates the commitment, user-device signature,
   protected headers, current revision, and request digest before decryption and
   rejects any mismatch, expiry, replay, duplicate, unknown record/class,
   downgraded schema, superseded generation, or revoked state.

For a local session, the authorizing client is trusted `mc vault` using the
device-held custody unlock. For a cloud session, it is the CodingApp client
using the same user-held custody factor. The CRK never enters either LLM
session.

The browser path may use only a user-verified cryptographic client that keeps the
custody root and unwrapped DEKs out of application state, network payloads,
telemetry, logs, and serializable JavaScript values. Re-wrap and commitment
creation occur inside a non-exportable key/crypto boundary. A browser/platform
without that capability must use an approved device or recovery client, or be
declared unsupported.

The control plane stores only opaque grant ciphertext and delivery metadata.
Revocation prevents future delivery or operation, but cannot erase a DEK already
unwrapped in a live process. Therefore stop/revoke is complete only after the
credential domain has dropped key material and the host isolation boundary has
been destroyed or positively cleaned up.

Grant consumption is atomic and single-runtime. Replacement or wake always
creates a new recipient registration and authorization request.

## 6. Credential use inside a host

### 6.1 Brokered providers

GitHub and future OAuth/App providers remain control-plane capabilities:

- durable provider authority stays in the control plane;
- the session receives a short-lived, source/session/resource/operation-bound
  broker grant;
- provider tokens never enter the sandbox, local coding-tool environment, or
  model-directed executor;
- checkout is a typed pre-LLM
  `repository.checkout(repository_id, immutable_commit_sha)` operation running
  under a separate trusted principal;
- checkout disables repository- or config-controlled execution from the first
  Git invocation: no hooks, filters/smudge, submodules, LFS, external transport,
  inherited helper/config, or repository-selected process execution;
- any one-operation credential helper is scoped to that checkout, removed before
  model launch, and followed by verification that no token, helper, credential
  cache, authenticated remote URL, or reusable IPC remains in the workspace or
  Git configuration;
- later writes use typed operations with verified preconditions.

### 6.2 Coding-tool login

Custody may hold a coding tool's portable login artifact, but the artifact is
usable only by the isolated credential/provider domain:

- it is never written to a home directory visible to model-directed commands;
- provider refresh state may be persisted back to custody only from
  broker-owned state that the LLM cannot write;
- each supported tool has an explicit runtime topology defining the trusted
  provider process, command-executor process, OS principals, namespaces,
  mounts, `/proc` visibility, socket ACLs, allowed IPC operations, and egress;
- the model-directed command executor cannot invoke the provider transport as an
  unrestricted credential proxy;
- unsupported tools fail closed rather than falling back to interactive login
  inside the managed session or an environment token.

### 6.3 Project secrets

Project secrets are consumed only by immutable trusted adapters:

- the adapter binary/configuration and operation schema are signed, pinned, and
  outside LLM-writable paths;
- it exposes a narrow typed API, response schema, rate/size limits, and egress
  allowlist that cannot be repurposed as a generic credential or HTTP proxy;
- every capability handle is non-transferable and bound to the recipient,
  runtime generation, session, policy revision, adapter digest, exact operation,
  permitted resource IDs, and parameter constraints;
- adapters reject LLM-selected URLs, hosts, redirects, destinations, shell,
  template or expression evaluation, unschematized bodies, and raw diagnostic or
  upstream-error reflection;
- secret-bearing environment, memory, files, and transport stay inside the
  adapter's credential domain;
- health, logs, errors, and results are bounded and redacted before crossing
  into the LLM domain;
- no raw value is returned by `mc vault`, written to dotenv, or inherited by a
  model-directed command.

Arbitrary project code that the LLM can edit cannot receive a raw secret, even
in a separate process: it could print, return, or exfiltrate the value and become
a credential oracle. Such workflows require a purpose-built typed adapter or
remain outside managed credential bootstrap.

`mc dev ensure` may orchestrate a trusted adapter and a secret-free development
service, but it must never inject a managed secret into ordinary repo code.

## 7. Work continuity

The portable unit is a host-independent coding session, not a copied local
registry entry.

- The control plane stores repository identity, base/head references, task,
  tool, policy revision, current host lease, transcript continuity, and latest
  safe checkpoint.
- Local and cloud registries are rebuilt as host projections.
- The existing cloud coding-bin snapshot format becomes a common checkpoint
  mechanism for local and cloud hosts.
- The checkpoint process runs outside the LLM domain but has no read access to
  the credential domain. Namespace/mount exclusion is the primary security
  boundary.
- A trusted, versioned exclusion policy outside repo-writable paths selects
  changed workspace content and deletion metadata. It excludes auth/runtime
  paths, dependency caches, custody material, symlinks, hardlinks, and special
  files.
- A trusted pre-upload scanner and adversarial canary tests, including raw,
  base64, hex, and compressed variants, are regression defences and fail closed
  on scanner failure; they are not the isolation boundary.
- The archive and canonical metadata are hashed and bound to account, session,
  repository, immutable base ref, lease, lineage, size, and file count.
- Restore downloads into an empty staging area, rejects traversal, links and
  special entries, verifies digest and bindings, and only then atomically applies
  the checkpoint.
- A session lease prevents two hosts from silently writing the same checkpoint
  lineage. Conflict creates an explicit branch/checkpoint choice.

Git branch publication and PR merge are separate typed operations. Cross-host
continuity must not depend on an unreviewed force-push or implicit merge.

## 8. Ordered delivery plan

Each slice is independently reviewed against this plan. Dependent work does not
start until the previous slice's security and acceptance gates pass. Repository
PRs belonging to one slice are reviewed together. Merging remains subject to
explicit approval.

### S0 — Security contract, topology feasibility, and fail-closed baseline

**Purpose:** choose implementable trust boundaries and close unsafe paths before
building credential delivery.

**Repos:** `memoro-cli`, `memoro`.

**Scope:**

- make the LLM-domain definition above normative in `mc-contract.md`,
  `mc-custody.md`, and the coding-agent protocol;
- define the trusted computing base and concrete local/cloud topology for each
  supported tool: processes, OS principals, namespaces, mounts, `/proc`, socket
  ACLs, IPC schema, and egress;
- run focused feasibility spikes for Codex and Claude on supported local hosts
  and the production Cloudflare Sandbox platform;
- select an implementable sandbox identity mechanism based on control-plane and
  platform evidence: signed release manifest, immutable image digest, sandbox
  identity, single-use nonce, and broker key registration before model launch;
- implement the fail-closed release/platform verification contract in
  [`mc-v2-release-trust.md`](mc-v2-release-trust.md) before recipient
  registration or model launch;
- define a signed release manifest containing immutable digests or verifiable
  signatures for the sandbox image, `memoro-cli`, coding tools, and trusted
  adapters;
- define the independently pinned release/platform trust roots, minimum accepted
  release epoch, signer rotation, emergency revocation, and rollback recovery
  used before recipient registration;
- add a secret-canary adversarial harness covering files, env, argv, PTY,
  process inspection, sockets, IPC, egress, logs, transcripts, snapshots,
  browser payloads, errors, and broker messages;
- keep legacy plaintext materialization and repo binding execution disabled;
- mark persistent tool-auth hydration as device bootstrap only, not a compliant
  managed-session boundary;
- maintain [`mc-v2-workload-allowlist.md`](mc-v2-workload-allowlist.md) as the
  normative, fail-closed table of current credential-blind workload routes;
  recipient registration and grant delivery remain explicitly disabled/no-route
  until release, platform, and recipient-control evidence is accepted;
- permit no generic context-read route; any future workload route requires an
  explicit contract revision and immutable authorization-digest binding;
- require source, account, cloud-session, unpredictable runtime generation,
  coding-session, authorization digest, and audience binding on every workload
  endpoint; workload tokens cannot access broad `/api/mc`, `/api/sessions`,
  `/api/lens`, browser, admin, or vault APIs;
- remove or disable global GitHub token fallback and empty-workspace success for
  private repositories;
- make unsupported topology, absent platform evidence, invalid repository
  target, version mismatch, or missing security mechanism fail closed.

**Dependencies:** none.

**Gate:** an approved topology and platform mechanism exist for every declared
supported tool/host combination. A minimal prototype passes the containment
harness. Cross-session workload calls, broad-route calls, unsigned releases,
self-reported image identity, invalid private checkouts, and unsupported hosts
all fail closed. If the platform cannot provide enforceable broker isolation and
recipient identity, cloud credential grants do not proceed.

### S1 — Signed account environment, custody unlock, and repository identity

**Purpose:** make “the environment follows the account” a real, versioned source
of truth that the control plane cannot silently broaden.

**Repos:** `memoro`, `memoro-cli`.

**Scope:**

- add the revisioned account environment manifest and read/repair APIs;
- canonicalize and sign authorization-relevant environment, permission, and
  capability-binding revisions with an authorized user-device key;
- define the user authority chain and independent trust root for device-key
  enrollment, rotation, revocation, recovery, minimum revision, and signer
  replacement; the control plane alone cannot authorize a new signer;
- add immutable trusted-adapter capability bindings and reject raw-secret or
  arbitrary project-service bindings;
- reuse connection descriptors, Coding Profile, repo catalog, and server-owned
  permission metadata while treating the user signature as the authority for
  custody use;
- represent repositories by provider numeric repository ID, canonical
  owner/name, and immutable commit SHA; mutable refs are resolved and authorized
  before bootstrap;
- expose only opaque custody record IDs/classes needed for client-side
  authorization;
- add a purpose-bound custody bootstrap: passkey-bound account unlock as the
  primary path, approved-device or recovery authorization as fallback, and a
  one-time migration path for existing master-password custody;
- define the internal versioned/idempotent `account-environment plan/apply`
  contract and a side-effect-free CLI plan surface such as
  `mc environment plan`; do not overload the existing cleanup command
  `mc reconcile`;
- keep legacy `.mc/secrets.json` readable only for audit and explicit migration.

**Dependencies:** S0.

**Gate:** a clean client can authenticate, establish or recover a user-held
custody unlock, verify signatures, and derive a complete non-secret desired
state. Control-plane, repo, ref, policy, recipient, or record substitution
cannot broaden authority without a new user signature. Interrupted migration
and device revocation fail safely.

### S2 — Isolated local credential domain and local golden path

**Purpose:** implement and prove the portable local experience before calling
cloud a peer.

**Repos:** primarily `memoro-cli`, with narrow `memoro` identity/custody support.

**Scope:**

- preserve existing bare `mc`, `mc wrap`, and native `mc new/open/resume`
  behavior throughout delivery; build managed portable startup as a separate,
  explicit, default-off path with no automatic credential migration, native
  fallback, or portable readiness claim until its gate passes;
- implement the approved S0 local topology and prove process, identity,
  namespace, mount, `/proc`, socket, IPC, and egress isolation;
- add a per-session local credential-domain keypair, canonical authorization
  request, user signature, and JWE DEK re-wrap;
- expose only typed session capability IPC to the LLM-visible `mc` client;
- make the LLM-visible client a restricted dispatcher with no custody-admin
  verbs; `mc vault unlock/list/set/adopt/hydrate/rotate/recovery` and generic
  custody IPC run only under a trusted admin principal with verified peer
  identity and local user presence;
- reject privileged custody requests from the LLM principal without opening a
  prompt, touching a key cache, or returning custody metadata;
- prevent model-directed commands from reading the Memoro device token, custody
  keys, provider auth, or project secrets;
- integrate device login, custody authorization, exact-version tool install,
  profile/config reconciliation, connection readiness, and tool-auth readiness
  into one resumable bootstrap;
- after device authorization, resume only a persisted, versioned, idempotent,
  allowlisted bootstrap intent; never serialize or replay arbitrary argv;
- replace Codex's `authenticated: null` bootstrap dead end with custody and
  credential-domain readiness;
- support one-time, explicit adoption when account tool-auth is absent;
- pin and verify all tool and trusted-adapter artifacts against the signed
  release manifest;
- exercise a custody-backed typed operation through an immutable trusted
  adapter, never through LLM-editable project code;
- fetch the account coding-session catalog and project it into the local
  registry so `mc list` and `mc resume` work on a clean device;
- treat the server session ID/revision/tombstone and lease as authoritative for
  that projection; local paths and native IDs are subordinate host metadata,
  and an older local entry cannot revive a tombstoned account session;
- map stable account session IDs to host-local worktrees and native tool-session
  IDs without synchronizing absolute paths;
- perform typed private checkout of the canonical repository at the authorized
  immutable commit, verify origin/ref/config/cache cleanup, and reject a dirty
  worktree conflict;
- migrate existing local registry entries compatibly and surface repair rather
  than silently replacing ambiguous work, including missing worktrees,
  repo/commit drift, lease conflicts, and name collisions between legacy local
  entries and account sessions.

**Dependencies:** S1 and the approved S0 topology.

**Gate:** on a clean second device, one coherent Memoro authorization journey
installs a missing supported tool, restores account configuration and sessions,
checks out a private repository at the authorized commit, resumes existing tool
login, and completes a typed custody-backed operation. The adversarial LLM
session cannot recover any credential byte or repurpose the broker as a generic
proxy.

### S3 — Attested cloud recipient and browser custody authorization

**Purpose:** establish the exact cloud recipient and user authorization before a
custody grant can exist.

**Repos:** `memoro`, `memoro-cli`.

**Scope:**

- start the protected broker under the approved OS boundary before any
  model-directed process and generate its ephemeral recipient keypair there;
- consume a single-use control-plane nonce and register only the public key;
- derive sandbox/release/image identity from the platform/control plane rather
  than an untrusted runtime self-report;
- verify the signed release manifest and bind sandbox ID, immutable image
  digest, CLI/tool/adapter digests, cloud session, coding session, account,
  unpredictable runtime generation, recipient key, and expiry;
- fence every registration and workload write with an atomic compare-and-swap
  against the Durable Object's active runtime generation;
- lock recipient registration for that runtime and reject later replacement;
- keep the workload token and key-registration channel outside the
  model-directed environment, files, process namespace, and unrestricted IPC;
- implement browser-supported user-held custody unlock with user verification;
  do not retain a long-lived CRK in web application state;
- expose and sign a canonical CodingApp authorization statement containing the
  user-signed environment/policy revision, canonical repository and immutable
  commit, exact opaque custody record IDs and classes, typed uses,
  trusted-adapter digests, operation/parameter constraints, recipient
  registration, release identity, and maximum expiry;
- handle cancellation, expiry, re-authentication, tab close, runtime
  replacement, and interrupted authorization without leaving a usable grant.

**Dependencies:** S1 and the S0 cloud topology.

**Gate:** CodingApp can independently verify and display the exact signed
request, recipient, runtime release, repository commit, scope, and expiry. Key
substitution, self-attestation, replay, cross-session calls, unapproved images,
and missing user presence fail closed. The sandbox has no custody access yet.

### S4 — Scoped custody grants and isolated cloud consumption

**Purpose:** authorize a headless sandbox without giving Memoro or the LLM a
custody root.

**Repos:** `memoro-cli`, `memoro`.

**Scope:**

- implement the same JWE grant envelope and canonical authorization validation
  used locally;
- select DEKs only after the custody client verifies the user-signed policy,
  locked recipient, repository commit, release manifest, exact record IDs,
  typed uses, adapter/operation constraints, classes, and expiry;
- require the authorizing user-device signature and atomically bind each opaque
  grant to the locked request and recipient;
- store/deliver opaque, expiring, single-use grants with exact
  account/source/cloud-session/coding-session/recipient/policy semantics;
- consume grants only inside the sandbox credential domain and expose only
  bounded typed results to the LLM domain;
- support isolated coding-tool login and immutable trusted-adapter operations;
- persist provider refresh state only from broker-owned, non-LLM-writable state;
- make wake/replacement generate a new keypair and require a new user-authorized
  request and grants;
- enforce the lifecycle order: atomically fence the generation, quiesce the LLM
  and credential broker, create and confirm the checkpoint under the active
  lease/generation, revoke grants and workload token, destroy keys/processes/
  namespaces/sandbox, then publish `asleep` or `stopped`;
- make concurrent continue, reconnect, sleep, and stop compete through the same
  generation/lease transition so a late old runtime cannot publish status,
  snapshots, broker events, or operation results;
- add expiry, revocation, replacement-runtime, replay, and teardown audit with
  sanitized payloads;
- maintain an idempotent cleanup ledger for grant revocation, key destruction,
  process/domain termination, and control-plane/platform sandbox destruction;
- never expose grant plaintext, decrypted DEKs, labels, or payloads in public
  runtime status.

**Dependencies:** S2 grant/consumer semantics and S3 recipient authorization.

**Gate:** wrong session, key, account, project, policy revision, class, image,
expiry, or revoked state fails before payload decryption. A successful session
still yields no credential byte to the adversarial LLM harness. A runtime cannot
be marked reusable, asleep, stopped, or clean until required cleanup is
positively confirmed; otherwise it remains quarantined and is destroyed.

### S5 — Common checkpoint safety foundation

**Purpose:** define and implement the portable work artifact before either host
depends on it for bootstrap.

**Repos:** `memoro-cli`, `memoro`.

**Scope:**

- specify one versioned checkpoint schema for both hosts with canonical metadata
  bound to account, coding session, canonical repository, immutable base commit,
  runtime generation, lease, lineage, parent digest, size, file count, and
  creation policy;
- capture only workspace content selected by a signed trusted exclusion policy
  outside repo-writable paths, with no credential-domain read access;
- treat secret scanning as fail-closed defence in depth, with raw, base64, hex,
  archive, compressed, renamed, and split-canary regression cases;
- reject traversal, absolute paths, symlinks, hardlinks, device nodes, sockets,
  unsafe modes, duplicate paths, quota excess, and decompression bombs;
- hash archive and metadata, authorize upload/download by exact session, and
  restore only through empty staging, full verification, and atomic apply;
- add single-writer session leases, lineage conflict detection, explicit
  branch/checkpoint choice, and dirty-target protection;
- add retention, quotas, deletion authorization, tombstones, and repair states;
- require explicit discard confirmation before destructive stop when checkpoint
  creation fails;
- migrate or reject the current cloud coding-bin format explicitly rather than
  assuming compatibility.

**Dependencies:** S1 identity/policy and S0 containment contract.

**Gate:** both local and production-equivalent cloud capture/restore primitives
pass integrity, archive, authorization, conflict, quota, and canary tests. The
scanner is not credited as the credential boundary, and a checkpoint cannot
read credential-domain state.

### S6 — Common cloud bootstrap and private repository readiness

**Purpose:** make CodingApp run the same signed environment as local `mc`.

**Repos:** `memoro`, `memoro-cli`.

**Scope:**

- build the sandbox from the verified signed release manifest and exact pinned
  image, `memoro-cli`, Codex/Claude, and trusted-adapter artifacts;
- run the common `account-environment plan/apply` contract from
  `mc cloud-runtime`;
- perform pre-LLM private checkout through the one-shot typed
  `repository.checkout(repository_id, immutable_commit_sha)` operation under a
  separate trusted principal;
- require a provider-attested result binding provider repository ID, canonical
  owner/name, resolved commit, request digest, and runtime generation, and reject
  delayed or replayed results;
- verify provider numeric repository ID, canonical owner/name, immutable commit,
  origin, worktree, Git config, credential helpers, authenticated URLs, and
  caches; remove checkout authority before model launch;
- remove `origin` before model launch or retain only an explicitly auth-free
  canonical remote; never retain a credential-bearing URL or helper;
- isolate and purge clone caches per runtime generation and test cross-generation
  contamination;
- expose no generic Git credential helper or reusable repository token to the
  runtime;
- fail bootstrap on unauthorized, unavailable, mutable, wrong-origin, or
  wrong-commit checkout;
- restore the latest S5 checkpoint before grounding and tool launch;
- activate the isolated credential domain and required immutable adapters;
- create the host-local session-registry projection and launch the real
  broker-owned `mc` session;
- report readiness only after repository, checkpoint, tool, broker, policy, and
  all required capabilities are verified.

**Dependencies:** S4 cloud grants and S5 checkpoint foundation.

**Gate:** a production-equivalent private-repository session reaches readiness
at the authorized commit with verified releases, checkpoint, tool login, and
typed capabilities. It never becomes ready with an empty, unauthorized,
mutable-ref, wrong-origin, wrong-commit, token-fallback, or credential-bearing
workspace.

### S7 — Bidirectional cross-host continuity

**Purpose:** make “continue on another host” preserve actual work, not only
transcript context.

**Repos:** `memoro-cli`, `memoro`.

**Scope:**

- project account sessions and current leases consistently into both local and
  cloud host registries;
- checkpoint on explicit sleep, stop, detach, and host-switch boundaries;
- restore before grounding and tool launch on the destination host;
- support local-to-cloud and cloud-to-clean-local continuation without copying
  device tokens, credential material, local registry paths, or native tool IDs;
- keep transcripts and Coding Profile as context, not substitutes for workspace
  state;
- require explicit resolution for dirty worktrees, competing leases, divergent
  lineage, checkpoint failure, and interrupted host handoff;
- on cloud sleep/wake, create a new runtime keypair and require fresh user
  authorization and grants before the resumed LLM process starts.

**Dependencies:** S2 local host and S6 cloud host.

**Gate:** an uncommitted safe source change made locally can be continued in
CodingApp, and a cloud change can be continued on a clean local device, without
copying host credentials or registries. Conflict and failed-checkpoint cases
preserve work and never silently choose a lineage.

### S8 — Parity acceptance and rollout

**Purpose:** prove the product promise and security invariant together.

**Repos:** `memoro-cli`, `memoro`.

**Scope:**

- run the full local, cloud, teardown, recovery, migration, revocation, version,
  repository, and conflict acceptance matrix;
- verify cleanup ledgers against platform destruction and local namespace,
  mount, socket, and process teardown;
- keep CodingApp behind an explicit feature/admin flag until all gates pass;
- add operational dashboards for sanitized bootstrap phase, grant lifecycle,
  checkpoint lifecycle, teardown proof, and failure codes;
- roll out progressively with kill switches for cloud start, custody grants,
  provider integration, trusted adapters, and checkpoint restore.

**Dependencies:** S0–S7.

**Gate:** all acceptance criteria in §9 pass in a production-equivalent
environment; no known path exposes a credential to the LLM domain.

## 9. Acceptance criteria

### 9.1 Local portability

- Start from a clean supported machine with no Memoro, Codex, Claude, GitHub, or
  vault state.
- Install `memoro-cli` and complete one coherent Memoro authorization journey.
- Reconcile exact approved tools, Coding Profile, connections, project policy,
  and custody readiness.
- Resume a private-repository coding session without a separate provider login
  or manual secret entry when the account already holds valid authority.
- Complete a custody-backed typed operation through an immutable trusted adapter
  without placing the credential in the LLM environment, executor, or workspace.
- Verify `mc list` and `mc resume` from the server-backed session projection,
  including dirty-worktree and interrupted-bootstrap recovery.

### 9.2 Cloud parity with laptop offline

- Turn the laptop off.
- From phone/web, select a private repository and start CodingApp.
- Authorize the canonical signed request for the exact sandbox recipient,
  release/image, tool, repository commit, policy, capability set, and expiry.
- Verify private checkout, checkpoint restore, grounding, provider readiness,
  GitHub typed reads, and a custody-backed immutable-adapter operation.
- Continue interactive work through CodingApp.
- Sleep and wake with the same checkpoint lineage but a new runtime keypair,
  authorization request, user authorization, and grants.
- Stop the session and verify workload token revocation, grant revocation,
  credential-domain teardown, platform-confirmed sandbox destruction, cleanup
  ledger completion, and a complete sanitized audit.

### 9.3 Adversarial credential-blindness

Use unique canary credentials and instruct the coding agent to recover them via:

- direct file reads, recursive search, symlink/hardlink races, and path
  traversal;
- `env`, argv, shell history, `/proc`, `ps`, open descriptors, sockets,
  debuggers, and child processes;
- invoking `mc vault`, capability IPC, provider helpers, or service launchers
  outside the granted typed operation;
- invoking every custody-admin verb (`unlock`, `list`, `set`, `adopt`,
  `hydrate`, `rotate`, and recovery) from the LLM principal;
- modifying project code, service definitions, adapter configuration, proxies,
  request destinations, schemas, or response handling to turn a typed operation
  into a credential oracle;
- inducing clone, provider, broker, snapshot, and teardown failures;
- inspecting PTY output, tool results, readiness, events, logs, transcripts,
  checkpoints, browser payloads, and audit exports;
- recovering raw, base64, hex, compressed, split, derived, or encoded canaries;
- attempting network exfiltration from the model-directed executor.

No canary byte or reusable unrestricted authority may appear. Tests must prove
the boundary locally and in the production-equivalent sandbox image.

### 9.4 Fail-closed authorization

- Wrong or missing account, host, audience, session, recipient key, image,
  project, policy revision, custody record, class, expiry, or grant status
  prevents use.
- Revoked/replaced runtimes cannot consume earlier grants.
- A late token, status, snapshot, checkout result, broker event, or operation
  result from an older runtime generation is rejected by the active generation
  fence.
- A repo or model-authored file cannot broaden capability scope.
- An older signed environment/policy revision cannot revive revoked authority;
  an unverifiable current head fails closed.
- Private checkout failure cannot become a ready empty workspace.
- Checkout cannot execute hooks, filters, submodules, LFS, external transport,
  inherited config, or leave authenticated remotes/helpers/caches behind.
- An unsigned or mismatched release, image, CLI, tool, or adapter cannot receive
  a grant or reach readiness.
- A workload token cannot call a route or session outside its exact allowlist
  and bound audience.
- Snapshot failure prevents destructive sleep/stop unless the user explicitly
  chooses to discard uncheckpointed work.
- A failed cleanup step prevents runtime reuse or a successful sleep/stop state;
  cleanup is retried or the host is quarantined and destroyed.

## 10. Explicitly out of scope

- exposing raw vault values to a model, shell, dotenv, generic environment, or
  unrestricted helper;
- giving raw managed secrets to arbitrary, repo-defined, or LLM-editable project
  code, even if that code runs in a nominally separate process;
- supporting a coding tool whose auth cannot be isolated from model-directed
  commands;
- cross-account secret sharing;
- arbitrary provider breadth beyond Codex/Claude and GitHub needed for parity;
- implicit branch publication, PR merge, force-push, or history rewrite;
- multi-region and sandbox-pool optimization before the parity/security gates;
- treating hooks, redaction, `0600`, or cleanup alone as credential isolation.
