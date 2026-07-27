# Local Codex containment feasibility spike

**Status:** active S0 feasibility spike — **not certified**.

**Scope:** this note records the observed gap between the credential-boundary
prototype and the current local Codex launch paths. It is evidence for the S0
topology decision, not an implementation authorization and not a claim that a
current Codex session has portable managed authentication.

## Compatibility constraint and current increment

Existing local development must remain usable throughout S2. Bare `mc`,
`mc wrap`, and ordinary `mc new/open/resume` therefore remain native,
host-owned paths until a separately certified managed topology is ready.
Existing Codex auth, local worktrees, registries, and provider-native session
IDs are not migrated, replaced, deleted, or relabelled as portable.

The first S2 compatibility increment adds only an explicit
`--managed-portable` request to `mc new/open/resume`. It is default-off and
currently returns `managed-portable-topology-unavailable` before first-run
identity inspection, branch/worktree mutation, registry access, attach,
vault/tool-auth startup, broker startup, or PTY launch. Repo config, stored
session state, and inherited environment cannot enable it. There is no native
fallback. The flag is a fail-closed integration seam, not a working or
certified managed-auth path, and it is not projected to the server.

## Finding

The current local Codex integration cannot provide the required credential
boundary by adding another environment scrub, file mode, or PATH guard. The
prototype exercises an outer Codex sandbox with a named permissions profile;
the interactive production launch does not use that mechanism and has no
separate credential-domain principal or restricted LLM-visible `mc` client.

Until the S2 controls below exist and pass the adversarial harness, managed
custody and portable tool-auth remain disabled. Native Codex authentication may
continue as a host-owned native mode, but it must never be represented as
portable managed authentication.

## Prototype versus production

| Boundary property | Prototype (`credential-boundary-probe`) | Current production launch | Result |
| --- | --- | --- | --- |
| Codex execution form | Runs an arbitrary child through `codex sandbox` with a named permissions profile. | Starts the interactive Codex binary directly in a PTY. | Not equivalent. |
| Managed config | Creates a private temporary Codex configuration with a restrictive shell environment policy, no login shell, and a named profile. | Does not create a private Codex home or select a managed permissions profile. | Missing. |
| Filesystem boundary | Profile extends the workspace policy and denies the credential domain and the coordinator/runtime source area. | Generic `--sandbox read-only` or `--sandbox workspace-write` may be rendered from policy; no credential-domain deny rules are installed. | Missing. |
| Network boundary | Profile disables direct network access. | The adapter declares network policy unsupported; no managed network policy is rendered. | Missing. |
| Environment boundary | Uses a minimal environment and excludes canary/secret-shaped variables. | The broker path removes selected runtime secrets before the child, but the direct wrap path does not apply the same scrub. | Partial, not a boundary. |
| Process and inspection boundary | Harness attempts canary recovery through the parent process and open descriptors under the outer sandbox. | Broker, sidecar, and coding tool use the same local OS identity; no separate namespace, mount, or `/proc` isolation is established. | Missing. |
| Socket and IPC boundary | Harness denies the credential socket and reports whether it was reachable. | The coding tool receives a session socket for typed GitHub operations; no independently authenticated principal boundary exists. | Missing. |
| Custody administration | Harness treats a callable `mc vault` surface as a violation. | The LLM-visible `mc` command remains the full dispatcher, including custody-admin verbs. | Missing. |

The prototype is useful evidence that the Codex sandbox can constrain a child
process on a supported host. It does **not** prove that an interactive Codex
session, its native authentication, or a same-user broker can safely share that
topology. The harness also requires a host that permits a local Unix-domain
test socket; a sandbox that denies such binds cannot certify the spike.

## Codex 0.145.0 command-surface evidence

The observed `codex --help` command surface for a full interactive launch
offers:

- `--sandbox read-only|workspace-write|danger-full-access`;
- `--ask-for-approval …`;
- `-p` / `--profile`, which layers a normal Codex configuration profile.

It does **not** offer `--permission-profile` or `--include-managed-config`.
Those flags appear on `codex sandbox --help`, together with the explicit
`--allow-unix-socket` escape hatch.

Consequently, `codex …` cannot directly select the prototype's named
permissions profile. An outer form such as `codex sandbox … codex …` is a
different launch architecture, not a drop-in adapter flag. It would still need
to prove that the inner TUI, its tool children, native authentication, and any
required typed socket all remain inside the intended enforcement boundary.

## Current flow classification

| Entry path | Current classification | Relevant containment properties |
| --- | --- | --- |
| Direct `codex` | Native / unmanaged. | No `mc` policy, broker, environment preparation, or managed topology. |
| Bare `mc` and `mc wrap` | Legacy native wrapper / unmanaged for custody. | `src/bin-mc.js` creates a direct PTY for Codex. This path does not use the broker launch client or its runtime-secret scrub and session GitHub preparation. |
| `mc new`, `mc open`, and `mc resume` with Codex | Broker-owned, partially managed session; not certified for custody. | The launch client removes selected runtime secrets, adds token-free GitHub descriptors and PATH shims, and starts a session host. It still starts the normal interactive Codex binary with only generic sandbox flags and runs all local processes as the same OS user. |
| `mc cloud-runtime` Codex path | Runtime-managed lifecycle, not portable managed custody. | Cloud runtime lifecycle and clone hardening do not establish the local S2 credential domain. Native Codex device login remains host/provider authentication, not custody-backed tool auth. |

The words “broker-owned” and “partially managed” describe lifecycle ownership
only. They must not be interpreted as credential isolation certification.

## Why current defences are insufficient

`0600` socket permissions, PATH shims, secret-name environment scrubbing, and
command-specific guards are defence in depth only:

- A coding process and broker under the same OS identity do not have an
  enforceable principal boundary. File permissions and same-user socket paths
  do not prevent a model-directed process from attacking peer state wherever
  the host sandbox permits inspection or connection.
- A PATH shim can be bypassed through an absolute executable, a copied binary,
  an alternate interpreter, or a different IPC client. It cannot establish
  identity or authority for a credential consumer.
- The GitHub session socket is intentionally reachable by the coding tool for
  typed operations. Without a separately authenticated recipient and a narrow
  protocol endpoint, reachability is not a credential-domain boundary.
- The full `mc` dispatcher exposes custody-admin command parsing in the
  LLM-visible process domain. Even a command that eventually fails is not the
  required fail-closed principal separation.
- Native Codex login is owned by Codex. `mc` cannot infer that its stored
  authentication is outside every model-directed process, filesystem,
  process-inspection, and egress path.

## Required S2 controls before certification

S2 must provide all of the following as one topology, not as independent
best-effort patches:

1. A per-session credential-domain principal with separate OS identity or an
   equivalent enforceable container/sandbox ACL boundary.
2. Proven separation of process, filesystem/mount, environment, keychain,
   `/proc`, descriptors, IPC, sockets, and egress between that principal and
   model-directed execution.
3. A recipient-bound, authenticated, typed capability protocol. It must bind
   account, source, session, policy, operation, parameters, expiry, and replay
   state, and must never expose arbitrary shell, secret read, provider API, or
   generic proxy behaviour.
4. A separate LLM-visible `mc` dispatcher containing only allowed session
   operations. Custody administration requires a trusted admin principal,
   verified peer identity, and local user presence; it is not callable from
   the coding session.
5. A launch topology that applies the approved Codex sandbox/profile outside
   the model-directed TUI, while retaining only the minimum explicitly
   authorized typed IPC endpoint.
6. An adversarial canary suite that proves the exact enforcing layer for
   files, environment, argv, PTY, process inspection, sockets, IPC, egress,
   logs, transcripts, snapshots, browser payloads, errors, and broker
   messages.

## S0 gate

Do not enable managed custody, vault hydration into tool state, or portable
Codex tool-auth on the basis of the current launch paths or this spike.

The only acceptable S0 outcome before S2 implementation is fail closed:

- no managed credential or reusable credential authority enters a Codex child,
  its workspace, environment, argv, output, transcript, or broker-visible
  request;
- unsupported local topology reports unavailable or native-only readiness;
- native/unmanaged sessions are never labelled as portable managed auth; and
- an absent or unproven platform boundary prevents custody-backed operations
  from starting.

## Validation record

- Inspected the production adapter, PTY/broker launch chain, session sidecar,
  GitHub capability plumbing, legacy wrap path, and dispatcher.
- Confirmed the Codex 0.145.0 help surfaces described above without logging in
  or using network access.
- Targeted launch, broker, and GitHub capability tests passed.
- The local probe could not be certified in the current development sandbox
  because that environment rejects binding the harness's local Unix-domain
  socket. This is an environment limitation, not a passing containment result.
