# mc V2 — cloud host parity

**Status:** planned · 2026-07-26 · V2 under [`mc-contract.md`](mc-contract.md)
§6/§8. V1 (local) is code-complete; this plan makes the cloud a **peer host**
of the same runtime — CodingApp on Cloudflare Sandbox starts an mc session
that behaves like a local one. No hand-off; two places one session can run.

## What V1 already guarantees V2

- **Custody with a stable CRK and per-secret DEKs** (`mc-custody.md`, S1–S4,
  shipped). The DEK layer exists precisely so a cloud session can be granted
  *specific* secrets without ever exposing the root.
- **Brokered providers** (GitHub App) already execute centrally — nothing
  device-bound to port.
- **Continuity** is server-owned (User/Coding Profile + session context), so
  grounding works identically wherever the session runs.
- Cloud scaffolding exists (`mc cloud-session`, `mc cloud-runtime`,
  Sandbox snapshots, broker cloud bridge) but has never reached prod.

## The V2-specific problem: headless unlock

A sandbox cannot read a device keychain, and Memoro must stay unable to
decrypt (contract §2.3). Resolution — contract §2.4, designed into S1:

**Scoped, expiring unlock grants by DEK re-wrap.** At pre-authorisation, the
*user's client* (holding the CRK):

1. resolves which secrets the cloud session may use (its tool-auth + the
   repo's bound `secret` labels — same default-deny bindings as local);
2. unwraps exactly those DEKs and **re-wraps each to the sandbox session's
   ephemeral public key** (HPKE-style), with an expiry and session binding
   in the AAD;
3. posts the re-wrapped grants to the control plane, which delivers them to
   the sandbox at boot.

Memoro never holds an unwrapping key; the sandbox can decrypt exactly those
secrets, for that session, until expiry. Revoking the session voids the
grants. The CRK never leaves the user's devices.

## Delivery slices

| Slice | Repo(s) | Contents |
|---|---|---|
| C1 | memoro-cli + memoro | Ephemeral sandbox keypair + grant schema: `mc cloud grant <session>` re-wraps the session's DEK set to the sandbox pubkey (client-side); server stores/delivers opaque grants with expiry + audit |
| C2 | memoro | Sandbox bootstrap consumes grants: materialise tool-auth + bound secrets inside the sandbox (0600, shred on stop), never into model-reachable surfaces; egress control per contract §6 |
| C3 | memoro | CodingApp starts a real mc session: `mc setup --bootstrap` equivalent in the sandbox image (tools preinstalled in image — supply-chain: pinned versions, image integrity), session registers in the same registry `mc list` reads |
| C4 | both | Parity acceptance: from the phone/web, start a session on a private repo with the laptop **offline** — grounding, tool sign-in, repo secrets, GitHub reads all work; stop → grants void; audit complete |
| C5 | both | Prod rollout: flags on, CodingApp surfaced, V2 acceptance in `mc-contract.md` §8 satisfied |

Slices land in order; C1 gates C2. Merge after each slice (standing
instruction).

## Trust requirements carried from the contract

- Sandbox is **as trustworthy as local**: per-session/per-tenant isolation,
  egress control (a compromised session cannot exfiltrate), verifiable image.
- The model stays untrusted inside the sandbox: same read-block enforcement,
  env scrub, and 0600 broker-owned files as local.
- Every grant is audited and instantly revocable; expiry is mandatory.

## Explicitly out of V2

- Git transport via the App (branch push) and PR merge — unchanged from V1
  deferral.
- Additional providers.
- Multi-region/sandbox-pool scaling work.
