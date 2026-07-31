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
- controller-only session and transaction capabilities: session attach/read/
  write/resize/stop/remove/relaunch and every transaction mutation fail closed
  without Memoro-derived controller authority; only one-way digests may be
  journaled, while reusable capabilities remain in trusted mc/broker memory and
  IPC and are never inherited by a provider;
- bind a new per-session host to its controller root through a strict
  anonymous-pipe bootstrap, never through launch input, argv, environment,
  files, logs, or provider-adapter input;
- authenticate the complete durable switch journal with that controller root,
  preserve an in-memory witness while the broker is live, and cross-check a
  missing post-restart journal against both provider cursors and server
  continuity before allowing work to proceed; only a zero-history session may
  create its first journal from an absent state;
- finalize source identity and handoff before target launch;
- fresh target launch on first use and native resume on later use;
- deliver only unconsumed handoffs as one handoff-only user turn, bound byte for
  byte to the journal and never combined with raw continuity grounding;
- withhold delivery acknowledgement until the exact target generation has
  captured its provider-native artifact;
- disable transcript fetch/upload authority on the target sidecar while the
  registry still names the source provider;
- crash recovery for every unambiguous journal phase, including session-host
  restart from the trusted local journal only after a controller-free status
  probe proves both definitive socket refusal and `ESRCH` for the recorded host
  PID, then repeats the socket probe to exclude a concurrent replacement;
  ambiguous evidence remains blocked, and an interrupted PTY write remains
  explicitly fail-closed rather than replayed;
- bounded, sanitized diagnostic events in the private transaction journal,
  without raw exception text, transcript data, credentials, environment, or
  launch arguments;
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

The sole real Claude credential source is the exact
`tool-auth:claude-code`/`tool-auth` record in `mc vault`. Claude's Keychain and
credential file are never runtime credential sources. A disposable synthetic
Keychain exists only as a hostile read canary: the unmanaged negative control
must read it and the managed candidate must not.

The controller-authenticated broker operation accepts only the session ID and
its Memoro-derived controller capability. The broker derives the terminal
runtime generation internally and refuses to open custody until the ordinary
provider process has exited and terminal cleanup is confirmed. The operation
does not accept a tool, path, command, environment, secret ID, callback, or
artifact location, and the provider-artifact socket cannot invoke it.
Once C1 starts, the broker reserves the dead session. A machine-local,
cross-broker interlock also makes every provider publish private active
evidence before spawn, while C1 creates an exclusive lock before scanning that
evidence. Parallel C1 leases, session removal, and every local provider
relaunch therefore remain blocked until custody and every trusted,
credential-bearing C1 process are terminally confirmed. Stale evidence is
never reaped from a PID guess; a broker crash fails closed. An ordinary native
or otherwise unmanaged provider can leave model-directed descendants outside
the PTY lifecycle, so its provider marker is never treated as terminal evidence
and remains a durable C1 barrier. Every global package installation atomically
mints a new private, value-free generation receipt and immediately baselines a
separate install epoch from that generation and the exact containment-release
digest. Exactly one later OS boot is required after every identity transition,
including same-version reinstall, upgrade, and rollback. Provider evidence is
v2 and bound to that identity: after the clean boot, exact v1 legacy evidence
and exact v2 evidence from another identity are superseded but never deleted;
current-identity, malformed, or otherwise ambiguous evidence remains a C1
barrier. If a receipt cannot safely yield an identity, provider launch retains
an exact unbound marker while C1 stays disabled; that marker is superseded only
by a later valid installation baseline and clean boot. Ordinary provider use
therefore remains available during missing or indeterminate C1 evidence. A
detached provider from older code cannot be mistaken for a clean machine. Only
the exact managed Codex descriptor that already passed
its hostile boundary can become C1-eligible; that boundary includes a real
fork-plus-`setsid` attack, and its in-memory evidence remains bound to the exact
session, credential-domain generation, launch nonce, native release hash,
policy hash, and manifest hash. After PTY exit, confirmed credential-domain
cleanup removes provider auth while any model-directed descendant remains
inside the credential-blind OS sandbox inherited by the executor tree. This is
a credential-safety receipt, not a claim that every OS descendant has exited.
The public command also refuses while any other local mc provider is live and
uses a bounded C1-specific wait rather than the broker client's ordinary short
request timeout.

Before custody opens, the broker verifies the one fixed private artifact root
for Claude 2.1.220 on Darwin arm64 and Sandbox Runtime 0.0.67. Verification
binds the signed release manifest and signer fingerprint, binary hash, size,
version, identifier and team, the known strict-codesign outcome, npm lock
integrity, exact SRT install-tree hash, ownership, modes, and real paths. The
fixed child verifies the installation again before reading credential FD 3,
and the harness re-resolves the same installation before execution. The final
private Claude copy is hash- and size-checked, and the SRT module is hash-
checked immediately before its dynamic import and before runtime credential
FD 3 is read. The broker also pins the source-closure verifier and lease host,
then hashes the complete generated local ESM closure plus package and native
probe build inputs. The lease host repeats that closure check before importing
vault code; the fixed child repeats it before reading credential FD 3. The
release check rejects a missing edge, digest drift, symlink, ownership drift,
or group/other-writable source before custody begins.

The vault lease is a fixed no-argument custody operation. It decrypts only
labels while selecting one unambiguous Claude tool-auth envelope, decrypts the
payload for that record alone in trusted mc code, and passes only the
access-token bytes through an anonymous FD 3 to a short-lived fixed child. The
long-lived broker never imports or executes vault decryption. A short-lived,
source-pinned lease host owns one process group inherited by every
credential-bearing descendant; the broker kills and confirms that whole group
gone before it releases the session reservation. A broker-held empty liveness
pipe makes broker crash or SIGKILL produce EOF in the lease host, which then
kills the trusted group. Model-directed descendants receive neither the real
credential nor the broker's process-group authority. They inherit SRT's
process-tree restrictions, receive only the revocable provider sentinel in the
Claude main process, and lose its proxy substitution on SRT reset; both main
and subagent subprocess probes must prove that even the sentinel was scrubbed.
Each probe also performs a real fork-plus-`setsid` escape and repeats the
private-file, credential-socket, loopback, provider-capability, and arbitrary-
egress checks outside the inherited process group.
Successful teardown additionally requires the pinned SRT manager to clear its
sentinel registry and proxy authenticator and for the former loopback proxy port
to reject a new connection. On the pinned Darwin runtime those proxy servers
live in the trusted C1 runtime process, and `reset()` awaits their close before
clearing its references. Even on a failed reset, the trusted runtime and real
credential remain in the C1 process group, whose terminal proof is required
before the broker releases the global lock.
Bounded stdout/stderr is scanned for raw, base64, hex, URI-encoded, and
JSON-escaped credential forms, mutable buffers are zeroed, and only `passed`,
`failed`, or `indeterminate` returns.

The token-free activation control must first prove that the exact SessionStart
hook, MCP server, and plugin are live before candidate blocking can count. The
real executor then runs with subprocess credential scrubbing and SRT sentinel
substitution: request policy sees only the fresh generation-scoped sentinel,
and the real token is substituted only after an allowed decision on verified
provider TLS egress. The proxy uses a strict allowlist and permits only HTTPS
to the exact Anthropic host, the two fixed messages routes without query
parameters, the exact bearer sentinel, an `application/json` content type, and
a size-bounded messages payload. The real credential, proxy capability, and
sentinel are all forbidden in model-visible output.

SRT necessarily gives the sandboxed executor an ephemeral local proxy transport
handle. It is not a Claude or Memoro login and is not accepted by either
provider; it can only reach the already-authorized typed operation while the
trusted proxy and current sentinel registry are live. Security therefore does
not depend on hiding that transport handle from the sandbox. It may never be
returned in model output, handoff, logs, or broker status, and subprocess probes
must still prove that the provider sentinel itself is absent.

The two-generation hostile fixture exercises Bash, Read/Edit, hooks, MCP,
plugins, subagents, nested Claude, mc/vault invocation, synthetic Keychain
lookup, environment and argv inspection, cross-sandbox process info, signal
and Mach task-port access, Unix and loopback sockets, provider-path and
provider-oracle attacks, arbitrary egress, transcripts, debug output,
replacement, and teardown. It never asks a process in the LLM domain to read a
real Memoro or Claude Keychain value, even if that output would be discarded.
The corresponding local Codex boundary probe follows the same rule and no
longer attempts a real Memoro Keychain read.

**Gate:** the unmanaged negative control demonstrably leaks its synthetic
canaries, while both managed generations complete a real provider operation and
public workspace operation without any real credential, sentinel, canary byte,
private path, or reusable provider authority appearing through a
model-directed or observable channel. The ephemeral local proxy handle must
remain confined to the sandbox transport and absent from every observable
output. The live run is initiated by the user from outside every active LLM
process and only after the exact installed containment release has observed its
own required clean boot. The epoch is keyed by the fresh installation generation
and a digest of the provider-marker, managed-Codex-boundary, and C1 interlock
implementation, and is atomically replaced whenever either changes. An upgrade,
downgrade, same-version reinstall, or A→B→A rollback in the same boot therefore
cannot inherit an older installation's clean-machine proof. Missing, stale,
malformed, or indeterminate evidence fails closed.

### C2 — Managed Claude adapter

**Dependency:** C1 passes for an exact signed release and host.

**Scope:**

- acquire and install the C1-pinned artifacts into the fixed private root;
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
- Treating Claude Keychain or a hydrated Claude credential file as the managed
  runtime's credential source.
- Claiming cloud Claude support from a local macOS result.
- Treating an unsandboxed native provider running as the same OS user as a
  hostile filesystem/process boundary. H3 prevents accidental or unprivileged
  protocol mutation; resistance to a same-UID provider that kills or
  impersonates mc itself requires the managed executor isolation gated by C1
  and C2.
- Defending against an independently compromised same-UID process that can
  concurrently rewrite the globally installed, trusted mc package itself.
  C1 closes model-directed and incomplete-source-chain drift before custody;
  signed and privileged package installation is a separate host trust concern.
