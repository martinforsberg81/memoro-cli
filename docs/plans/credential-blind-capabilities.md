# Credential-blind capabilities and complete GitHub writes

Status: accepted
Date: 2026-07-24
Owners: `memoro` control plane + `memoro-cli` trusted runtime

Normative dependencies:

- `docs/plans/connected-capabilities.md`
- `docs/plans/github-app-capability.md`
- `docs/plans/worktree-lifecycle.md` §12

## 1. Absolute invariant

No secret stored in mc vault may ever become readable as plaintext by an LLM
tool or by a command surface the model controls.

This includes child environment, argv, files, prompt/stdin, tool output, logs,
errors, transcripts, browser payloads, shell expansion, subprocesses,
credential helpers, and process inspection available from the coding sandbox.
Mode `0600`, later shredding, and host-specific hooks do not make plaintext
materialisation acceptable.

The target flow is:

```text
LLM tool
  -> token-free typed operation
  -> trusted broker
  -> source/session/resource-bound grant
  -> isolated provider executor
  -> provider API
```

## 2. Credential custody

Every connection declares one custody class:

- **Control-plane custody:** preferred for the central Memoro GitHub App.
  Durable credentials remain in server secret storage; local/cloud sessions
  receive only short-lived Memoro capability grants.
- **Isolated local custody:** vault ciphertext remains in mc vault. Plaintext
  exists only in a dedicated executor outside the LLM process, filesystem,
  environment, and inspection boundary. Same-UID memory is insufficient where
  peer-process inspection is possible.
- **Workload custody:** a cloud workload identity is bound to one cloud
  session; local Keychain and the user's online computer are not dependencies.
- **Native runtime custody:** Codex, Claude, or another host may own its native
  login. mc reports readiness but never converts a vault secret into the
  runtime's credential file.

## 3. Vault product contract

Vault remains encrypted custody and policy storage. It may create, import,
label, rotate, revoke, and delete secrets; expose metadata-only audit; bind an
opaque secret id to a provider/resource/typed operation set; and decrypt only
inside an approved isolated executor.

It must never:

- materialise plaintext into a coding-tool or repo credential file;
- inherit plaintext in the coding-tool environment;
- pass plaintext through model-controlled argv or stdin;
- return plaintext through an mc command callable from a managed session;
- expose generic authenticated HTTP, provider API, shell, or credential-helper
  passthrough;
- treat a PreToolUse hook as the confidentiality boundary.

Future bindings describe authority, not destination files:

```json
{
  "schema": 2,
  "secret": "cloudflare-production",
  "provider": "cloudflare",
  "resource": {"type": "worker", "id": "worker_opaque_id"},
  "operations": ["worker.read", "worker.deploy"],
  "sources": ["local", "cloud"]
}
```

## 4. Immediate containment

1. Stop vault materialisation in `mc new`, `mc open`, and `mc resume`.
2. Reject new file/env bindings.
3. Stop Codex, Claude, generic-adapter, and repo dotenv materialisation.
4. Provide no managed-session override.
5. Preserve encrypted entries; never auto-delete or auto-rotate.
6. Keep legacy manifests and bindings readable only for metadata audit and
   provably-owned cleanup.
7. Report uncertain artifacts rather than deleting them.

## 5. Provider executor contract

Each request binds Memoro user, local device/cloud workload source, coding
session, provider, stable resource id, typed operation, normalized parameters,
effect, expiry, nonce/idempotency identity, and state preconditions.

Each response is schema-validated, bounded, credential-free, redacted,
repairable through stable error codes, and safe for prompt/transcript exposure.
Authenticated HTTP or provider CLI execution occurs inside the executor, never
in the coding-tool child.

## 6. GitHub write model

GitHub reads already use the central App. The complete write path must add:

- `git commit`: local host-owned operation, subject only to host-native
  approval policy.
- `repository.branch.publish`: derives repo/branch/base/local head from the
  registered session; publishes exact verified Git state through the App;
  expected-state + idempotency; no force push, installation token, or
  credential helper in the LLM process.
- `pull_request.create` / `pull_request.update`: require a server-known
  published branch, exact head/base state, bounded content, App permission,
  and idempotency.
- `pull_request.merge`: binds current repo, PR number, expected head/base,
  allowlisted merge method, required checks/mergeability, and idempotency.

Codex/Claude/host policy decides whether the model may invoke a write. mc
enforces hard capability and state policy but stores no duplicate “Always ask”
preference. Errors identify the denying layer.

## 7. PR plan and gates

Each segment is reviewed against this contract before the next begins.

### S1 — Contract and containment (`memoro-cli`)

- Make this plan normative.
- Disable automatic plaintext materialisation.
- Block new file/env bindings and plaintext export.
- Add negative Codex, Claude, generic, repo, and startup tests.

Gate: a managed session creates no plaintext secret artifact.

### S2 — Metadata-only exposure audit (`memoro-cli`)

Inventory legacy manifests/artifacts without reading values; report labels,
sessions, paths, and cleanup state; clean only provably-owned artifacts.

Gate: output contains no value, ciphertext, vault key, or usable credential
reference.

### S3 — Capability-backed bindings (`memoro` + `memoro-cli`)

Add schema v2 with custody, provider resource, source, and typed-operation
policy. Legacy bindings remain audit/migration input, never execution input.

Gate: onboarding core contains no provider-specific auth branch.

### S4 — Isolated executor (`memoro-cli` and/or `memoro`)

Define transport and OS isolation, short-lived audience-bound grants, bounded
schemas, and response redaction. Prove the LLM cannot inspect credentials.

Gate: the adversarial suite passes on every supported OS.

### G1 — GitHub branch publication (`memoro` + `memoro-cli`)

Implement credential-blind `repository.branch.publish` with verified exact Git
state and no force push.

### G2 — Complete PR writes (`memoro` + `memoro-cli`)

Harden PR create/update, add `pull_request.merge`, checks/state/idempotency, and
extend only allowlisted `gh` shim commands.

Gate: commit → publish → draft PR → update → checks → merge succeeds without
native GitHub credentials or raw CLI passthrough.

### G3 — Admin dogfood and release gate

Keep writes admin-only and test cross-user/repo, replay, stale head, suspended,
transferred, renamed, revoked, and missing-permission cases before enabling.

### S5 — Provider migration

Move Cloudflare and remaining vault-backed providers to typed executors, then
remove legacy materialisation code after metadata migration.

## 8. Adversarial acceptance

On each supported host/OS, probe direct and indirect file reads, env/shell/
subprocess inheritance, argv/process inspection, peer memory where available,
logs/errors/transcripts/browser reflection, generic HTTP/provider proxying,
credential-helper extraction, cross-boundary grant copying, replay after
expiry/revocation, and provider error-body injection.

Passing means the typed operation succeeds while the credential never appears
in an LLM-observable byte stream or storage surface.

## 9. Definition of done

1. No managed session materialises vault plaintext.
2. Existing exposure is auditable using metadata only.
3. Vault secrets back capabilities, never files/env.
4. GitHub supports commit → publish → PR → merge via the central App.
5. Cloudflare and future providers use the same custody/grant/executor model.
6. Local and cloud share operation/authorization semantics.
7. Windows, macOS, and Linux pass the same no-plaintext suite before support.
