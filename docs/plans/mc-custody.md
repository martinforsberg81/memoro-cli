# Account custody — the design `mc vault` is built on

**Status:** shipped for S1–S3 · 2026-07-25 · **the last plan standing in this
directory, kept because it is the only record of why `src/vault/` looks the way
it does.** The mc-cut project (`docs/project/mc/mc-cut/`) removed the rest of
`docs/plans/` with the session manager it described. What survives here is the
custody design that `mc vault` implements today: S1 (the CRK/DEK envelope,
`src/vault/engine/custody-crypto.js`), S2 (per-device unlock, `key-cache.js`),
and S3 (`mc vault adopt`, `tool-auth.js`). S4 (recovery + rotation) is
`mc vault recovery|recover|change-password`.

Read the rest as history. `mc-contract.md`, `connected-capabilities.md` and
`mc-v2-cloud.md` are named below and no longer exist — the trust model they
carried is restated in
[`docs/coding-agent-protocol.md`](../coding-agent-protocol.md) §*Credential
boundary (normative)*, which is the normative copy. The "isolated credential
domain", "typed adapter" and cloud-grant topologies this document plans for
were never finished and their code is gone; `mc vault` is a trusted CLI
subsystem the model does not call, not a capability broker.

## Purpose

One account-owned custody for raw API keys and coding-tool provider auth
(Claude Code, Codex), with the contract's invariants enforced by construction:
credential-blindness, envelope encryption with **no bulk decrypt**, per-device
unlock, audit, and revocation. Custody records are not injected into dotenv,
repo files, generic environments, or model-directed tools. They are consumed
only by a supported isolated credential domain or immutable typed adapter.
Brokered providers (GitHub App) do not pass through custody at all; their
authority stays in the control plane (contract §2.2).

## What already exists (verified in code)

Phase 1 is an **evolution of the existing vault**, which is further along than
the contract assumed:

- **Zero-knowledge, account-backed.** `src/mc/vault/client-crypto.js`: Master
  Password → PBKDF2(600k) → 512 bits, split into a client-only **Vault Key**
  (AES-256-GCM) and an **Auth Hash** (server-side proof). Ciphertext (data AND
  labels) is stored via `/api/vault/*` on the Memoro server. The server never
  sees plaintext — this already realises "Memoro cannot bulk-decrypt", in the
  strongest form: the unlock factor is user-held, so Memoro *cannot* decrypt at
  all, breach or not.
- **Legacy materialisation code and shred hooks.** Historic adapter seams
  (`tokenLocations()`, `materializeToken()`, `shredToken()`) and the
  `materialiseVaultBeforeLaunch` path are retained only for audit/migration;
  managed plaintext materialisation is disabled. A `0600` tool-auth file is not
  a compliant session boundary.
- **Read-block hook.** The PreToolUse `block-secret-reads` hook is useful
  defence in depth, but it cannot enforce axiom 1 when the credential owner and
  model-directed commands share a readable namespace or OS principal.
- **Legacy repo bindings + audit.** `mc vault bind <label> <ENV_KEY>` bindings
  are audit/migration metadata only. They cannot authorise or cause a secret to
  be written into a repository or environment.

**Contract correction:** the contract's "vault is retired as a device-local
store" was inaccurate — the vault is already account-backed. What Phase 1 does
is upgrade it to the full custody contract. §2.3's "rooted in a KMS/HSM" is
realised as **rooted in a user-held factor** (master password), which is the
stronger reading of "no bulk decrypt" and the only honest one on our stack.

## Gaps Phase 1 closes

1. **No envelope hierarchy.** Today the passphrase-derived key encrypts secrets
   directly → a passphrase change would re-encrypt everything, and there is no
   recovery path.
2. **No per-device unlock cache.** Every process starts locked (15-min in-memory
   cache only); daily use needs the passphrase far too often for the "sign in
   and it works" promise.
3. **Tool auth is not in custody.** Claude/Codex login state lives in device
   keychains/files — exactly what breaks portability.
4. **No recovery, rotation, or device revocation model.**

## Key hierarchy (envelope encryption)

```
Master Password ──PBKDF2(600k, salt)──► KUK  (Key-Unlock Key, client-only)
                                          │ wraps
Recovery Code  ──KDF──► RUK ──────────────┤
                                          ▼
                                   CRK  (Custody Root Key — random 256-bit)
                                          │ wraps (per secret)
                                          ▼
                                   DEK_i (per-secret Data Encryption Key)
                                          │ AES-256-GCM
                                          ▼
                                   ciphertext_i  (stored server-side)
```

- **CRK is random**, not derived — so passphrase rotation re-wraps one key
  instead of re-encrypting every secret, and a **recovery code** (generated at
  setup, shown once) is a second wrap of the same CRK. Memoro cannot reset a
  lost passphrase — that is the point — so recovery must exist client-side.
- **Per-secret DEKs** keep blast radius per secret and are what V2's scoped
  unlock re-wraps (see below).
- Auth Hash (existing split) continues to prove identity to the server without
  revealing key material.
- All crypto stays client-side WebCrypto (Node ≡ browser, byte-identical — the
  existing port-verification test pattern extends to the new hierarchy).

## Unlock and the device model

- **First run on a device:** `mc setup` → memoro.me sign-in → master password
  prompt → derive KUK → unwrap CRK → cache **CRK** in the OS keychain,
  device-bound. One prompt per device, ever.
- **Daily use:** the trusted identity service (the only Keychain-reading module,
  per `connected-capabilities.md`) reads the cached CRK; sessions unlock
  passwordlessly. The credential domain, not a hook, must be outside the model
  executor's principal, namespace, mounts, process inspection, and IPC surface.
- **Device revocation:** server tracks device registrations; revoking a device
  deletes its registration and the next sync instructs key-cache purge. True
  cryptographic revocation = CRK rotation (re-wrap + re-encrypt DEK wraps), a
  deliberate, audited operation.

## Data model (server, additions to `/api/vault`)

- `custody_keys` (per user): KDF salt + iterations, `wrapped_crk_passphrase`,
  `wrapped_crk_recovery`, auth verifier, rotation timestamps.
- `custody_secrets` (evolves the existing secret rows): `class`, encrypted
  label, `wrapped_dek`, ciphertext + IV, integrity metadata (AAD binds class +
  binding scope so a row cannot be repurposed), timestamps.
- Secret **classes**: `tool-auth` (claude-code, codex — only for a supported
  isolated tool topology), `secret` (API keys consumed through typed adapters),
  extensible. `dotenv` and generic environment injection are not custody uses.
- The server keeps: ciphertext, wrapped keys, verifiers, audit — never
  plaintext, never unwrapped keys.

## Tool auth in custody (the portability maker)

`mc vault adopt <tool>` — with explicit user confirmation, the **trusted
runtime** (never the model; never logged) reads the tool's local auth (e.g.
Claude keychain entry / `.credentials.json`, Codex `auth.json`), encrypts it
client-side, and stores it as `tool-auth`. On another device it is usable only
when that tool's approved topology keeps it inside the credential/provider
domain; bootstrap must fail closed rather than writing it to a tool home
directory visible to model-directed commands.

This deliberately supersedes the older `connected-capabilities.md` clause "mc
never reads or copies the tool's access token": the contract decision (§4) is
that tool credentials live in account custody. The confidentiality rules still
hold — only the trusted runtime touches it, under the user's explicit action,
client-side encrypted before it leaves the process.

Prefer-revocable still applies (§2.2): where a tool later offers a revocable
grant flow, custody switches to holding that instead of the raw file.

## Credential-blind session-use contract

1. A session receives an immutable, user-authorised policy that selects exact
   opaque custody records and bounded typed uses. A repo file, label, command,
   or model request cannot select another record or broaden that policy.
2. Client-side decrypt (CRK → DEK → plaintext) happens only in the trusted
   custody/credential domain. A raw secret, DEK, CRK, login artifact, or
   recovery material never crosses into the LLM domain.
3. A `tool-auth` record is usable only through a documented supported topology
   with an enforced separation between provider process and model-directed
   command executor. A raw `secret` record is usable only by an immutable,
   signed, policy-bound typed adapter. Arbitrary project code cannot receive a
   secret, even in a separate process, because it can print, return, or
   exfiltrate it.
4. `0600`, hooks, environment scrubbing, redaction, TTLs, and shredding are
   defence in depth. They do not replace principal, namespace, mount, process,
   socket, IPC, and egress isolation.
5. On end, revoke session grants, terminate the credential domain, and have an
   external host/control-plane authority confirm process, mount, socket, and
   sandbox cleanup. A compromised runtime cannot attest to its own cleanup.
   Audit records contain only sanitised metadata.

## Threats → mechanisms

| Threat (contract §1) | Mechanism |
|---|---|
| Model exfiltrates a credential | Enforced credential-domain separation; immutable typed adapters; bounded/redacted IPC and egress. Hooks, scrubbing, 0600, and shredding are defence in depth only. |
| Memoro breach → bulk credentials | Zero-knowledge: server holds ciphertext + wrapped keys only; unlock factor is user-held |
| Stolen device | Keychain-bound CRK cache behind OS user auth; device revocation + CRK rotation |
| Lost passphrase | Recovery code (second CRK wrap); otherwise data is unrecoverable **by design** |
| Row tampering / repurposing | AES-GCM AAD binds class + scope; auth verifier gates API |
| Overshared secrets | Default-deny bindings; per-repo scope; audit trail |

## V2 hook (design now, build later)

Headless cloud cannot read a device keychain. The scoped unlock grant
(contract §2.4) becomes: after user presence, the **user's client re-wraps the
specific DEKs** the session may use to an attested sandbox credential-domain
ephemeral public key, using the standard JWE envelope defined by
`mc-v2-cloud.md`, with expiry. The user signature binds the canonical
authorisation statement and exact grant commitment; Memoro stores only opaque
ciphertext and never holds an unwrapping key. The sandbox can decrypt exactly
those secrets, for that session, until expiry. The per-secret DEK layer above
exists precisely so this is possible without touching CRK.

## Migration & compatibility

- Existing vault secrets: on first unlock after upgrade, lazily re-encrypt under
  the new hierarchy (decrypt with legacy vault key → wrap new DEK under CRK).
  One-way, transparent, resumable.
- API: additive endpoints/fields on `/api/vault/*`; existing clients keep
  working until migrated.
- CLI surface: keep `mc vault …` (no verb churn); new: `mc vault adopt <tool>`,
  `mc vault recovery`, `mc vault devices|revoke-device`.

## Delivery slices (PR plan)

| Slice | Repo(s) | Contents |
|---|---|---|
| S1 | memoro + memoro-cli | Envelope hierarchy: CRK/DEK client crypto + wrapped-key storage + lazy migration + port-verification tests |
| S2 | memoro-cli | Device unlock cache (OS keychain via identity service) + device registry + revocation |
| S3 | memoro-cli (+ memoro) | `mc vault adopt <tool>` + tool-auth class + supported isolated provider topology; unsupported tools fail closed |
| S4 | memoro + memoro-cli | Recovery code + passphrase/CRK rotation |
| S5 | both | Acceptance: fresh second device → sign in → unlock once → supported tools and immutable typed adapters work without exposing a credential to the LLM domain |

Slices land in order; S1 gates everything. No production flag flips before S5
passes.

## Open questions (not blocking S1)

- **Passkey/PRF as an additional unlock factor** (WebAuthn PRF could replace the
  passphrase on supporting platforms) — attractive later, not baseline.
- **Naming:** the model is "account custody"; the CLI keeps `mc vault`. A
  cosmetic rename can happen post-V1 if wanted.
