# mc Provider Handoff and Managed Claude

**Status:** in-flight · 2026-07-28

## Outcome

An mc coding session can move from Claude to Codex and back without losing
workspace state, provider-native conversation identity, or the causal order of
work. Each provider resumes its own native thread and receives only the bounded
handoff produced since it was last active.

After that continuity contract ships, managed-portable Claude support is enabled
only if the pinned Claude release passes the same credential-blind adversarial
gate as managed Codex.

## Non-negotiable boundaries

- `coding_session_id` is the stable account/session identity.
- Provider-native IDs and transcript paths are host-local projections and are
  never server truth.
- Managed credentials, provider auth, vault material, environment values, raw
  tool results, PTY output, transcript paths, and raw transcript bodies never
  enter a handoff, heartbeat, browser payload, or LLM context.
- Scanner and redaction are defence in depth. The credential domain remains the
  primary isolation boundary.
- A handoff is prior-work data delivered at user-message priority. Transcript
  material is never appended to a system prompt.
- A stale generation, ambiguous transcript, missing parent, scanner failure, or
  conflicting handoff fails closed before a target provider starts.
- The broker is the single writer for a local switch transaction. A durable
  switch journal makes interruption recoverable; registry temp-file writes
  alone are not treated as a concurrency primitive.

## Causal model

```text
Claude native A
  ├─ same workspace
  └─ handoff H1
       ↓
Codex native B (consumes H1)
  └─ handoff H2 (parent H1)
       ↓
Claude native A (resumes A and consumes only H2)
```

Each provider projection records its native session identity and
`last_consumed_handoff_sequence`. The handoff chain records a monotonically
increasing sequence and parent digest. A provider never receives handoffs it
already consumed.

## Handoff contract

`mc-session-handoff-v1` is a strict, unknown-key-rejecting schema:

- stable coding-session identity and sequence;
- parent digest and server-computed canonical digest;
- source kind, source ID, source tool, and runtime generation;
- canonical repository/workspace anchor and workspace-state digest;
- bounded goal, state, decisions, next actions, risks, and changed paths;
- scanner version, result, and redaction count.

The payload does not contain messages, transcript excerpts, code, patches,
diffs, commands, stdout/stderr, environment data, auth material, or local
absolute paths. The trusted client may deterministically derive candidate fields
from the approved session objective, the generation-bound provider identity,
and git projection, but the resulting allowlisted fields are scanned again
before persistence and before rendering. Transcript bodies are never a
candidate source.

The authoritative initial objective is captured from the explicit `mc new`
task and later projected from the account coding-session descriptor. Legacy
sessions without that field use a visibly derived, low-authority objective and
cannot silently promote repository-authored text into the contract.

The first production candidate source is deliberately deterministic: the
approved session objective plus the generation-bound provider identity and a
git/worktree projection. It does not ask a second LLM to reopen or summarize
the source transcript. Decisions and next actions remain absent unless a later
explicit, structured, scanner-approved source is added; raw final messages are
never promoted into those fields.

## Storage and rollout

- D1 owns immutable handoff rows and the current head per user and coding
  session. KV transcript snapshots remain dashboard caches; external session
  items remain archive content.
- `POST /api/sessions/handoff` initially accepts only the exact authenticated
  local client scope and terminal generation binding. Cloud append is added
  separately inside the cloud runtime's terminal authority.
- `/api/mc/context` returns the current bounded handoff projection and never
  falls back to `items.body`, `metadata.payload`, or transcript snapshots.
- Worker support deploys additively behind a version capability. Old clients
  keep transcript archive behavior but receive no raw transcript continuity
  once the v1 handoff read path is enabled.
- Account deletion, expiry, and bounded pruning cover all handoff rows.

## Ordered delivery

### H1 — CLI handoff foundation

**Purpose:** make provider identity and candidate handoff construction safe
before adding a network or launch side effect.

**Scope:**

- provider-keyed host-local native-session projection with unambiguous legacy
  migration;
- generation/ID-bound transcript discovery;
- deterministic, bounded handoff builder and scanner portal;
- per-provider consumed sequence;
- metadata-only broker heartbeats;
- no public switch behavior yet.

**Gate:** provider A and B identities survive a round-trip in pure lifecycle
tests; ambiguous or secret-bearing input cannot mutate registry state or reach a
launch payload.

### H1.5 — Exact provider artifact and candidate capture

**Purpose:** bind the source provider's native identity to the exact broker
generation and construct the safe deterministic candidate required by H3.

**Scope:**

- capture exactly one provider-native session ID and transcript artifact for the
  broker generation, with ambiguity failing closed;
- persist the provider ID, local transcript path, and runtime generation as one
  broker-owned provider projection;
- derive the handoff candidate only from the approved session objective and
  bounded git/worktree facts;
- never parse message bodies into handoff fields and never use a latest-file
  fallback as source authority.

**Gate:** concurrent or ambiguous provider artifacts cannot become source
authority; the deterministic candidate contains no transcript, code, diff,
command, output, environment value, or absolute path.

### H2 — Worker handoff authority

**Purpose:** provide durable ordering, source/generation fencing, and bounded
grounding without using the transcript archive.

**Scope:**

- D1 migration and deletion/expiry integration;
- strict schema, canonical digest, idempotency, parent/sequence conflict
  handling, and scanner enforcement;
- exact local authentication/generation fencing;
- bounded, ordered context projection after an explicit consumed-sequence
  cursor, with gaps and window overflow failing closed;
- no dashboard history or transcript archive changes.

**Gate:** concurrent/stale/cross-session writers fail closed; context tests
prove that no archive or snapshot content can reach grounding.

Cloud handoff authority remains required for the final outcome, but is coupled
to the cloud runtime's terminal transition. The current `mc.cloud` workload
token is revoked while that transition is committed, so widening it to the
generic session-handoff route would create a stale-writer window. The cloud
implementation must append through the cloud-session authority during its
terminal transaction; it is not emulated by broadening the workload token.

### H3 — Broker-owned provider switch

**Purpose:** make the causal handoff transaction user-visible.

**Scope:**

- broker-owned switch journal and single-writer lease;
- finalize source identity and handoff before target launch;
- fresh target launch on first use and native resume on later use;
- deliver only unconsumed handoffs as a user-level startup turn;
- crash recovery for every journal phase;
- Claude A → Codex B → Claude A → Codex B regression coverage.

**Gate:** the exact native IDs A and B are reused, one coding-session ID and
worktree remain stable, handoff order is monotonic, and no failed handoff starts
the target.

### H4 — Privacy cutover and smoke

**Purpose:** remove the transitional raw-continuity path and prove the complete
local flow.

**Scope:**

- disable raw external-session continuity;
- credential-canary tests across heartbeat, archive shaping, handoff, context,
  launch argv/environment, journal, and browser-facing payloads;
- local native Claude/Codex round-trip smoke plus managed Codex coverage.

**Gate:** all exact local checks pass, the Worker capability is live, and the
installed CLI completes the round-trip without silent degradation.

### C1 — Managed Claude topology spike

**Purpose:** determine whether a pinned Claude release can provide a real
credential-blind executor boundary.

Anthropic's current documented candidate controls are native OS sandboxing,
`sandbox.failIfUnavailable`, `allowUnsandboxedCommands: false`, managed-only
permission rules, managed read-path control, managed-domain-only network
policy, and managed hook/plugin restrictions. Documentation is not evidence
that the complete boundary holds.

The non-shipping spike must use a disposable home and Keychain plus a synthetic
credential canary. It must exercise Bash, Read/Edit, hooks, MCP, plugins,
subagents, nested Claude, Keychain lookup, environment/argv/process inspection,
Unix and loopback sockets, provider and arbitrary egress, transcripts, debug
output, and two replacement generations.

**Gate:** a negative control demonstrably leaks, while the managed candidate
allows provider operation and workspace work without any canary byte or
reusable authority appearing through any model-directed or observable channel.
Missing or indeterminate coverage fails.

### C2 — Managed Claude adapter

**Dependency:** C1 passes for an exact signed release and host.

**Scope:**

- pin and verify the Claude artifact, signature, architecture, and behavior;
- add the credential-domain/provider-adapter lifecycle;
- install an immutable managed policy outside model-writable paths;
- adopt, launch, refresh, resume, replace, and clean up without exposing the
  provider credential;
- keep unsupported hosts/releases fail-closed.

**Gate:** the production adapter passes the C1 harness unchanged plus normal
session, handoff, failure, and cleanup tests. Cloud Claude remains a separate
production-image gate.

## Explicit non-goals

- Treating file mode, environment scrubbing, hooks, redaction, or user approval
  as a credential isolation boundary.
- Copying a provider transcript into another provider.
- Synchronizing native provider IDs or absolute paths between hosts.
- Using a server-side LLM to compact raw transcripts for handoff.
- Enabling managed Claude before the hostile boundary harness passes.
- Claiming cloud Claude support from a local macOS result.
