# Account custody — Phase 1 design (V1 foundation)

**Status:** proposed design · 2026-07-25 · Phase 1 of the V1 plan under
[`mc-contract.md`](mc-contract.md) §2/§4. Everything else in V1 materialises
from this; build it first.

## Purpose

One account-owned custody for every injected secret — raw API keys, dotenv
secrets, and the coding tools' own provider auth (Claude Code, Codex) — with the
contract's invariants enforced by construction: credential-blindness, envelope
encryption with **no bulk decrypt**, per-device unlock, audit, revocation.
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
- **JIT materialisation + shred.** Adapter contract `tokenLocations()` /
  `materializeToken()` / `shredToken()` (e.g. Claude's `.credentials.json`,
  0600) and `materialiseVaultBeforeLaunch` in the launch paths; shred at
  session end.
- **Model-read blocking.** The PreToolUse hook (`block-secret-reads`) denies the
  model reads of credential-shaped paths — axiom-1 enforcement that exists and
  is active today.
- **Repo bindings + audit.** `mc vault bind <label> <ENV_KEY>` (value-free,
  per-repo) and an audit layer (`vault/audit.js`).

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
  passwordlessly. The model cannot reach the keychain (hook-enforced).
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
- Secret **classes**: `tool-auth` (claude-code, codex — well-known schemas
  matching each adapter's `tokenLocations()`), `secret` (API keys / dotenv),
  extensible.
- The server keeps: ciphertext, wrapped keys, verifiers, audit — never
  plaintext, never unwrapped keys.

## Tool auth in custody (the portability maker)

`mc vault adopt <tool>` — with explicit user confirmation, the **trusted
runtime** (never the model; never logged) reads the tool's local auth (e.g.
Claude keychain entry / `.credentials.json`, Codex `auth.json`), encrypts it
client-side, and stores it as `tool-auth`. On any other device, bootstrap
materialises it and the tool is signed in.

This deliberately supersedes the older `connected-capabilities.md` clause "mc
never reads or copies the tool's access token": the contract decision (§4) is
that tool credentials live in account custody. The confidentiality rules still
hold — only the trusted runtime touches it, under the user's explicit action,
client-side encrypted before it leaves the process.

Prefer-revocable still applies (§2.2): where a tool later offers a revocable
grant flow, custody switches to holding that instead of the raw file.

## Materialisation contract (session start/end)

1. Session launch (existing `materialiseVaultBeforeLaunch` seam) → broker
   resolves what this session gets:
   - `tool-auth` for the session's tool: materialised automatically.
   - `secret` class: **default-deny** — only labels the user bound to this repo
     (`mc vault bind`) materialise. Unbound secrets never leave custody.
2. Client-side decrypt (CRK from keychain → DEK → plaintext in broker memory) →
   adapter `materializeToken()` writes the tool-expected path, 0600.
3. Enforcement stack: file modes + PreToolUse read-block hook + env scrub — the
   model never sees the value (axiom 1).
4. Session end (or `mc end`): `shredToken()` removes materialised files; broker
   memory dropped. Audit records fetch + materialise + shred per session.

## Threats → mechanisms

| Threat (contract §1) | Mechanism |
|---|---|
| Model exfiltrates a credential | Never in model-reachable surfaces; read-block hook; env scrub; 0600 broker-owned files; shred at end |
| Memoro breach → bulk credentials | Zero-knowledge: server holds ciphertext + wrapped keys only; unlock factor is user-held |
| Stolen device | Keychain-bound CRK cache behind OS user auth; device revocation + CRK rotation |
| Lost passphrase | Recovery code (second CRK wrap); otherwise data is unrecoverable **by design** |
| Row tampering / repurposing | AES-GCM AAD binds class + scope; auth verifier gates API |
| Overshared secrets | Default-deny bindings; per-repo scope; audit trail |

## V2 hook (design now, build later)

Headless cloud cannot read a device keychain. The scoped unlock grant
(contract §2.4) becomes: at pre-authorisation, the **user's client re-wraps the
specific DEKs** the session may use to the sandbox's ephemeral session public
key (HPKE-style), with expiry. Memoro still never holds an unwrapping key; the
sandbox can decrypt exactly those secrets, for that session, until expiry.
The per-secret DEK layer above exists precisely so this is possible without
touching CRK.

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
| S3 | memoro-cli (+ memoro) | `mc vault adopt <tool>` + tool-auth class + bootstrap materialisation (claude-code, codex) |
| S4 | memoro + memoro-cli | Recovery code + passphrase/CRK rotation |
| S5 | both | Acceptance: fresh second device → sign in → unlock once → tools signed in, repo secrets materialise by binding — safely (hook/scrub verified) |

Slices land in order; S1 gates everything. No production flag flips before S5
passes.

## Open questions (not blocking S1)

- **Passkey/PRF as an additional unlock factor** (WebAuthn PRF could replace the
  passphrase on supporting platforms) — attractive later, not baseline.
- **Naming:** the model is "account custody"; the CLI keeps `mc vault`. A
  cosmetic rename can happen post-V1 if wanted.
