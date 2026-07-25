# The mc contract

**Status:** foundation — accepted backbone · 2026-07-25 · owners: Memoro control
plane + `memoro-cli` trusted runtime

This is the north-star contract for what `mc` is and how it must behave. It is
security-first by construction: the trust model comes first, and every other
part is derived from it. Existing plans are implementation detail **under** this
contract, not alongside it:

- [`mc-custody.md`](mc-custody.md) — **Phase 1 of V1**: the account-custody
  design (envelope encryption, unlock, tool-auth adoption).
- [`connected-capabilities.md`](connected-capabilities.md) — the connection /
  identity / broker-grant foundation.
- [`credential-blind-capabilities.md`](credential-blind-capabilities.md) — the
  confidentiality and provider-execution rules.
- [`github-app-capability.md`](github-app-capability.md) — GitHub as the first
  provider on the model.
- [`chat-coordinator-coding.md`](../../../memoro/docs/plans/chat-coordinator-coding.md)
  — the cloud/CodingApp surface.

When any of those conflicts with this contract, this contract wins.

## 0. What mc is

A **portable, identity-anchored coding environment**. One human orchestrates
work; the environment follows the human, not the device. Local machines and the
cloud (CodingApp on Cloudflare Sandbox) are **peer hosts** for the same runtime.

The product promise, end to end:

> Install `memoro-cli` on any device, sign in with your memoro.me identity, and
> your environment materialises — tools, integrations, and continuity — exactly
> as it was on your other device. Open CodingApp in the memoro me app and start
> an mc session that behaves the same as a local one.

There is **no hand-off**. Local and cloud are not a relay; they are two places
the same session can run.

---

## 1. Trust model (the fundament)

Security is not a section; it is the shape of everything below. State first who
is trusted and what must never happen.

| Party | Trust | Rule |
|---|---|---|
| **The model** (coding agent) | **Untrusted.** Assume adversarial / prompt-injectable. | A credential must **never** reach the model's context, the tools it drives, its argv, the environment or files it can read, logs, or transcripts. This is axiom 1. |
| **The host** (local broker / cloud sandbox) | **Ephemerally semi-trusted.** | Holds materialised secrets briefly, in memory or protected paths the model cannot read; shredded at session end. Per-session, per-tenant isolation. |
| **Memoro control plane** (custody) | **Root of trust — and the highest-value target.** | Must be designed so that a breach yields ciphertext, not credentials (see §2). |
| **Other users** | **Isolated.** | Strict per-user tenancy; no cross-user access or inference. |

**What must never happen:** a model exfiltrates a credential; a Memoro breach
discloses usable credentials in bulk; one user reaches another's access; a host
retains a credential past its session; an integration acts beyond what the user
granted.

---

## 2. Custody invariants (non-negotiable)

Because mc custodies high-value credentials (your LLM-provider account auth,
GitHub authority, raw API keys) for many developers across devices and cloud,
these are binding:

1. **Credential-blindness is absolute.** Secrets are materialised just-in-time
   to a tool's expected path on the host and shredded at session end; they never
   enter model-reachable surfaces. The GitHub App already proves this shape
   (tokens never returned to the client); it generalises to every provider.
2. **Revocable brokered authority before raw secrets.** Prefer holding authority
   that you or the provider can revoke without Memoro's cooperation (OAuth /
   installation grants) over storing the ultimate key. Raw-secret custody is
   actively minimised.
3. **Envelope encryption — Memoro cannot bulk-decrypt at rest.** Secrets are
   encrypted under keys rooted in a **user-held factor** (zero-knowledge: the
   unlock key never reaches Memoro), unlocked only through your authenticated
   identity. A database breach yields ciphertext — and Memoro could not decrypt
   even if compelled. Design: [`mc-custody.md`](mc-custody.md).
4. **Scoped, expiring unlock for headless runs.** Invariant 3 would block a
   cloud session that runs while you are away. Resolution: you **pre-authorise**
   a session with a **scoped, time-boxed unlock grant**. Memoro may decrypt only
   for that session's scope and lifetime — never in bulk, never durably. The
   root stays encrypted; a per-session envelope opens under an explicit,
   expiring, audited, revocable authorisation you gave.
5. **Short-lived, scoped grants per host/session.** The durable authority never
   leaves the control plane; hosts receive time-boxed use.
6. **Everything is audited and revocable now.** Every credential use is logged.
   You can revoke a device, a session, a provider, or a single grant instantly.

---

## 3. Identity is the root

The only credential a user supplies is **memoro.me sign-in**. It is the root of
trust: it unlocks custody (§2.3), authorises sessions (§2.4), and scopes tenancy.
Everything else — tools, integrations, continuity — is derived from it and is
never device-bound. Identity security (MFA-worthy sign-in, device authorisation,
session integrity) is therefore a foundational control, not a convenience.

---

## 4. Custody model (the one model)

All integration and tool access is **account-owned custody + credential-blind
JIT injection**. Two access forms sit on the same custody:

- **Brokered operation** — OAuth-style providers (GitHub, and future ones). The
  control plane mints and executes; no token leaves it. Preferred form (§2.2).
- **Injected secret** — raw keys and a coding tool's own auth (e.g. Claude's
  `.credentials.json`). Fetched from custody, materialised JIT to the tool's
  path, shredded at end.

**The existing vault — already zero-knowledge and account-backed — is upgraded
into this custody** (envelope hierarchy, per-device unlock, recovery, tool-auth
adoption; see [`mc-custody.md`](mc-custody.md)). One model, not two. A coding
tool's provider credential (Anthropic / OpenAI account auth) lives in this
custody, which is what makes tools seamlessly portable across devices — the
deliberate, accepted trust posture, made safe only by §2.

---

## 5. Authorization — the user governs, default-deny

The user governs, **account-scoped** (following identity), what each integration
may do: which resources and which operation classes. This is a security control,
not a UX nicety:

- **Default-deny for writes.** Reads are allowed once connected; writing requires
  explicit opt-in, per resource and operation class.
- **Least privilege, revocable, audited.** A grant is the minimum needed, and can
  be withdrawn at any time.
- **General, not provider-specific.** The same consent shape applies to GitHub,
  the coding tool, and future providers.

---

## 6. Host parity — local ≡ cloud

One execution contract. The local broker and the cloud sandbox both materialise
the identity-anchored environment (tools + scoped grants + continuity) and run
the session. A session started in CodingApp behaves as a local one. The cloud
host must be **as trustworthy as local**: per-session/per-tenant isolation,
egress control so a compromised session cannot exfiltrate, and verifiable image
integrity. No implicit fallback to a device-local tool login.

---

## 7. Bootstrap — install and run

On a fresh device or sandbox: `memoro-cli` → sign in → mc installs the required
tools (codex / claude / …) and pulls the account environment, then the user
works. No manual setup. Bootstrap carries a **supply-chain integrity**
requirement: the mc binary, the downloaded tools, and the cloud sandbox image are
verifiable / signed, because a compromised binary or image defeats every
invariant above.

---

## 8. Scope — bringing it home

**V1 is local mc only.** Cloud (CodingApp / Cloudflare Sandbox host parity, §6)
is **V2**. V1 proves the promise on any local device; V2 makes the cloud a peer
host of the same runtime.

**In for V1 → prod (the single local loop):**

- Sign-in loop: install `memoro-cli` → memoro.me → environment materialises.
- **Account custody with envelope encryption (§2.3) — the foundation.** Every
  other V1 step materialises from here; build it first.
- Tool bootstrap: required tools installed and **authenticated via custody**, so
  a fresh device has a logged-in coding tool with no per-device login.
- Integrations reachable credential-blind: GitHub + the coding tool at minimum.
- Consent gate (default-deny writes) and the §2 custody invariants in force.
- Acceptance: on a second device, install + sign in and the same environment is
  present — safely.

**Deferred to V2:**

- Cloud host parity (§6): CodingApp on Cloudflare Sandbox running the same
  runtime; scoped/expiring unlock grants for headless runs (§2.4).

**Deferred beyond V1 (either track):**

- Git transport (branch push via the App), PR merge.
- Additional providers (Gmail and other connectors).
- Fine-grained consent UX polish beyond the default-deny gate.

The de-risk point is the local loop, not breadth: if "install on a new device,
sign in, and my environment is here — safely" does not hold locally, cloud does
not matter yet.
