# mc V2 S0 — credential-boundary feasibility record

**Status:** active spike · 2026-07-26 · the S0 gate is not yet passed.

This record selects the candidate runtime topologies that may be tested for
[`mc-v2-cloud.md`](mc-v2-cloud.md) S0. It does not certify a host or coding tool.
Certification requires the adversarial harness below on the exact released
binary and production-equivalent host.

## 1. Boundary under test

The trusted credential domain may hold a provider login, CRK, DEK, or raw
secret. The LLM domain includes the model-directed command executor and every
surface it can inspect or influence: files, environment, argv, process state,
descriptors, sockets, network, PTY, results, logs, transcripts, snapshots, and
helpers.

A topology passes only when the LLM domain cannot:

- read credential bytes directly;
- cause a helper to return them;
- invoke an unrestricted authenticated proxy;
- modify the credential consumer into an oracle;
- obtain a transferable bearer with equivalent authority.

File mode, redaction, hooks, environment cleanup, and process teardown remain
defence in depth.

## 2. Platform findings

### 2.1 Codex

Current public Codex surfaces provide:

- file, OS-keyring, or automatic credential storage;
- OS-enforced command sandboxing and approval policy;
- permission profiles with exact-path and glob deny-read rules;
- environment, filesystem, network, and Unix-socket policy controls.

They do not document a portable credential-broker interface that independently
proves provider auth is inaccessible through process inspection, keyring access,
or a model-directed child on every supported host. Therefore an auth file or
keyring entry alone is not an mc credential boundary.

Evidence:

- [Codex credential storage](https://learn.chatgpt.com/docs/auth#credential-storage)
- [Codex sandbox and approvals](https://learn.chatgpt.com/docs/agent-approvals-security#sandbox-and-approvals)
- [Codex deny-read permissions](https://learn.chatgpt.com/docs/permissions#deny-reads-with-exact-paths-or-globs)

### 2.2 Cloudflare Sandbox

Cloudflare isolates separate sandboxes with separate VMs. Inside one sandbox,
all processes share the filesystem, process view, and network. A broker sidecar
in the same sandbox is consequently not a credential boundary by itself.

Cloudflare explicitly recommends keeping durable provider credentials in a
Worker proxy when the sandbox must call an external API. `destroy()` is the
platform operation that terminates processes and deletes sandbox state; idle or
connection timeout is not equivalent.

Evidence:

- [Sandbox security model](https://developers.cloudflare.com/sandbox/concepts/security/)
- [Container runtime](https://developers.cloudflare.com/sandbox/concepts/containers/)
- [Sandbox lifecycle](https://developers.cloudflare.com/sandbox/api/lifecycle/)

## 3. Selected candidate topologies

### 3.1 Control-plane providers

GitHub App authority and equivalent managed OAuth/App authority stay in the
Memoro control plane.

```text
LLM command
  -> typed, session-bound request
  -> Memoro capability broker
  -> provider operation
  -> bounded, redacted result
```

No installation token, Git credential helper, authenticated remote URL, or
generic provider proxy enters the coding host. Repository checkout is a
pre-LLM typed operation and is not implemented by passing a token to sandbox
`git`.

**Decision:** approved architecture; individual operations still require their
own contract and adversarial tests.

### 3.2 Local Codex

Candidate:

1. Trusted `mc vault` administration and the Memoro device token run outside the
   Codex command namespace and require verified peer identity plus local user
   presence for administrative actions.
2. Codex provider auth is available only to the Codex parent/provider process.
3. Every model-directed command runs under a pinned managed permission profile:
   no approval escalation, no login-shell inheritance, no credential paths,
   keyring control sockets, peer process inspection, or unrestricted network.
4. The full `mc` package and administrative CLI are absent from or denied to
   model-directed commands. Typed capabilities are exposed through broker-owned
   tool IPC. A future LLM-visible dispatcher must be a separately packaged,
   restricted client that contains no custody/admin imports.
5. Setup and adoption occur before the managed LLM session and never return
   credential material to it.

The candidate is rejected on any host where Codex cannot enforce all five
properties. File storage without a proven deny-read/process boundary is
unsupported. Keyring storage without proven child/keyring separation is also
unsupported.

**Decision:** candidate only; local macOS and Linux probes are required.
The exact current-flow gap, required topology, and certification criteria are
recorded without duplication in
[`mc-v2-local-codex-containment.md`](mc-v2-local-codex-containment.md).

### 3.3 Cloud Codex

Cloudflare's sandbox-to-sandbox VM boundary, not a same-sandbox sidecar, is the
minimum credential isolation boundary.

Candidate:

1. The model sandbox contains the workspace and model-directed executor.
2. Custody and provider-root material live in a separate per-session credential
   sandbox or control-plane executor.
3. The model sandbox receives only a recipient-bound, non-transferable session
   capability for the exact provider transport or typed adapter operation.
4. Codex command execution is additionally constrained by its pinned permission
   profile; the session capability, its minting channel, and broker control
   socket are unavailable to model-directed children.
5. The control plane fences every call by account, cloud session, coding
   session, runtime generation, recipient, policy digest, operation, and expiry.
6. Stop and sleep revoke grants, destroy both sandboxes, and require platform
   confirmation. Wake creates a new runtime generation and authorization.

Until that topology passes in the production image, cloud Codex auth must reject
ambient API keys, auth files, interactive login, and vault materialisation.

**Decision:** candidate only; production-equivalent Cloudflare proof is
required.

### 3.4 Claude Code

No equivalent host topology has been proven in this spike. Claude Code remains
unsupported for portable managed credential bootstrap until its provider
process, model-directed executor, auth store, IPC, process inspection, and
network boundaries pass the same harness.

**Decision:** unsupported, fail closed.

### 3.5 Project secrets

Arbitrary repository code is never a credential consumer. A supported project
operation requires an immutable, signed adapter outside LLM-writable paths with
a fixed schema, fixed destinations, parameter validation, bounded results, and
no generic shell/HTTP/template surface.

**Decision:** approved architecture; no generic secret-backed development
service is supported.

## 4. Release and platform identity prerequisite

Credential-boundary isolation is meaningful only for the exact verified broker,
tool, adapter, and sandbox image. The normative pre-registration release,
trust-bundle, signer rotation, emergency revocation, rollback, and
platform-derived identity contract is
[`mc-v2-release-trust.md`](mc-v2-release-trust.md).

The release-verifier core and pre-token gates now exist in both the CLI and
server paths and fail closed when their required trusted inputs are absent.
They are not production evidence: no independently pinned trust-bundle and
delivery channel, installed-artifact-byte verification, platform attestation,
or signer rotation/revocation integration is live. Until those controls and
the required recipient ordering exist, no candidate topology in this record may
register a custody recipient, receive a DEK grant, or claim the S0 gate. A
runtime self-report of image/version is not an acceptable substitute.

The cloud broker transport is deliberately narrower than credential delivery:
it uses an opaque single-use ticket, atomic consume, queryless WebSocket
upgrade, and a versioned, 64 KiB-bounded control wire. It does not create an
isolated credential domain. Recipient/grant routes remain absent, provider
startup still precedes recipient registration, and the attach token remains in
a control payload and URL. Cloudflare same-sandbox execution likewise remains
outside the approved isolation topology; external image/instance attestation
is not yet available.

## 5. Adversarial harness

Every candidate is tested with unique canaries and a hostile model-directed
executor. The harness must attempt:

- auth/vault file reads, traversal, links, races, recursive search, and deleted
  file recovery;
- environment, argv, shell history, process listings, `/proc`, descriptors,
  debuggers, core dumps, peer memory, keyring APIs, and control sockets;
- `mc vault` admin verbs and direct broker/helper invocation;
- unrestricted provider requests, redirects, alternate hosts, malformed
  parameters, response/error reflection, and capability replay;
- network exfiltration and local proxying;
- PTY, readiness, status, logs, audit, browser payload, transcript, snapshot,
  checkpoint, crash, timeout, and teardown output;
- raw, base64, hex, compressed, split, and derived canaries.

The harness reports booleans and stable error codes only. It must not print a
canary even when a probe succeeds.

## 6. S0 gate

The S0 gate passes for a tool/host pair only when:

- the exact release/image/tool/adapter digests are pinned;
- the release and platform identity verifier in `mc-v2-release-trust.md` has
  accepted the exact artifact set before broker registration or model launch;
- the selected OS/platform boundary is available and mandatory;
- the full canary harness passes twice, including replacement and teardown;
- unsupported or degraded hosts fail before credential delivery or model
  launch;
- a negative control proves the harness detects a deliberately exposed canary.

Passing local Codex does not certify cloud Codex. Passing Cloudflare VM isolation
does not certify a same-sandbox broker. Claude Code remains unsupported until
separately certified.
