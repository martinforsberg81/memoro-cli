# mc V1 session architecture

**Status:** accepted implementation contract

This contract defines the V1 session model for `mc`. It supersedes the
repository-scoped session hierarchy in `mc-product-definition.md` and the
worktree-owned lifecycle in `worktree-lifecycle.md`. Existing security and
credential-blind capability contracts remain normative.

## Outcome

The stable lifecycle unit is an mc session. A session is owned by exactly one
source: one local machine or Memoro Cloud. Its identity is independent of any
repository, worktree, branch, coding tool, tool conversation, process, PTY, or
runtime generation.

A local session is authoritative in a private machine-local session home.
Memoro is authoritative for a cloud session. Local session projections sent to
Memoro are read models and presence signals, never a second lifecycle authority.

V1 has one certified execution path for each supported tool and source. There
is no `--native` flag, native/managed mode, credential fallback, tool-session
fallback, global-broker fallback, or local `gh` authority fallback.

## Product model

```text
mc_session_id
  owner: machine:<source_id> | cloud:<source_id>
  session metadata
  workspace associations (0..n)
  tool conversations (0..n)
  runtime generations (0..n, at most one live)
    process and transport state
  terminal clients (0..n)
```

`mc_session_id` is opaque, globally collision-resistant, immutable, and the
only new session lifecycle identifier. A name is unique within its owning
source and may change without changing or moving the session identity.

`coding_session_id`, `cloud_session_id`, provider session ids, transcript
paths, process ids, worktree paths, and socket paths are not session identity.
Old identifiers may be retained only in bounded migration records that point to
their V1 identity. New APIs and storage use `(source_id, mc_session_id)`.

## Local authority

Durable local state lives under:

```text
${MC_HOME}/sessions/<mc_session_id>/
  identity.json
  metadata.json
  workspaces/
  conversations/
  generations/
  resources/
  projection.json
```

Ephemeral runtime state lives separately under:

```text
${MC_HOME}/run/sessions/<mc_session_id>/
```

The session home is trusted mc control-plane state. It is not a project
directory, launch working directory, credential store, or general filesystem
surface for the coding-tool executor. Workspace freedom does not grant the
tool authority to forge session identity, resource ownership, cleanup intent,
or runtime-control state.

The durable files contain bounded metadata only. They never contain raw
credentials, reusable authority, environment values, command arguments,
transcript bodies, source code, patches, or PTY output.

### File responsibilities

- `identity.json` is immutable and records schema, identity, owner, and
  creation time.
- `metadata.json` is atomically replaced and contains user-controlled name,
  objective, and launch preferences. It contains no derived liveness state.
- `workspaces/` contains independent associations to directories, repositories,
  checkouts, and worktrees.
- `conversations/` contains bounded tool conversation handles and their
  generation relationship. A handle is an adapter detail, not a user-selectable
  execution mode.
- `generations/` contains immutable launch intents and append-only phase
  receipts for runtime generations.
- `resources/` records creation intent, ownership evidence, and cleanup receipts
  for resources created by mc.
- `projection.json` is a small, atomically replaced, rebuildable read model for
  commands such as `mc list`.

Sessions are discovered by enumerating bounded session homes. Human names use
one atomic claim per normalized name so concurrent creation and rename cannot
silently collide. Name claims are independently repairable and rebuildable;
there is no global mutable registry document.

All mutations are serialized per session. A corrupt session or name claim may
make that session unavailable, but cannot make unrelated sessions disappear or
look empty.

## Workspace contract

A workspace association is context and navigation metadata, not an allowlist.
The coding tool may read and write any path permitted by its host and own
approval/sandbox policy, including paths not yet known to mc.

Each association records only bounded facts needed for return and cleanup,
including:

- an opaque association id and kind;
- current absolute path and last successful observation;
- repository identity when one can be established without credentials;
- optional checkout/worktree and branch observations;
- whether mc created the resource or merely observed/referenced it;
- last launch use and an optional preferred-launch hint.

There is no primary repository in session identity. The same session may use
multiple repositories, multiple worktrees of one repository, ordinary
directories, relocated paths, and paths that later disappear.

Every runtime generation records its explicit launch working directory. `mc
new` creates a session from the current directory; it does not implicitly
create a branch or worktree. Worktree creation remains an explicit convenience
operation and creates an owned-resource record before mutation.

Merely visiting or associating a path never makes it mc-owned. Cleanup requires
an exact creation intent and matching creation receipt. Ambiguous ownership
fails closed.

## Runtime and tool contract

A session has zero or more immutable runtime generations and at most one live
interactive generation. Starting, resuming, switching tools, replacing a lost
conversation, and attaching to a live runtime are distinct operations.

- Attaching never starts another process.
- Opening an inactive session resumes the recorded tool conversation through
  the one certified adapter path.
- Missing, conflicting, or unverifiable conversation evidence fails closed.
- Creating a replacement conversation requires explicit user intent and a new
  generation. It is never a timeout or readiness fallback.
- Switching tools preserves the mc session while recording the source and
  target conversations and one bounded in-session context handoff.

The tool keeps its own TUI, approvals, sandbox semantics, and conversation
format. mc supplies stable launch conditions, grounding, credential-blind
capabilities, lifecycle journaling, and terminal attachment. It does not wrap
the tool in a workspace allowlist or invent a cross-tool approval language.

The words and concepts `native session`, `native custody`, and `managed versus
native` are absent from the active product contract. Internal code uses `tool`,
`conversation`, `runtime generation`, and `certified execution`.

## Runtime host and terminal contract

Each live local session has an isolated ephemeral runtime host. This is an
internal process owner, not the `mc supervisor` product. The host owns the live
tool process and transport for one generation; it never owns session identity
or durable metadata.

The runtime data path must satisfy these invariants:

- `mc list` reads bounded projections and never probes PTYs, runtime sockets, or
  the network to discover local sessions.
- PTY output callbacks perform no recursive filesystem scan, synchronous full
  history concatenation, server call, or other unbounded work.
- Socket writes honor backpressure. Slow clients have bounded queues and may be
  disconnected without stopping or corrupting the runtime.
- Reattachment reconstructs the current terminal screen and bounded scrollback;
  it does not replay an arbitrary raw byte suffix as if that were screen state.
- Resize is sent to the exact attached session host and causes a deterministic
  terminal redraw.
- Artifact observation, prompt readiness, status projection, and cloud presence
  are throttled or processed outside the PTY hot path.
- Runtime crash, host restart, or stale ephemeral files are reconciled from the
  durable generation journal without creating a duplicate tool process.

The legacy global broker is not a V1 launch or attach path.

## Cloud authority

All cloud implementation lives in the `memoro` repository.

- D1 stores canonical cloud-session metadata, workspace associations, runtime
  generation audit, and queryable projections.
- A per-session Durable Object coordinates live cloud runtime concurrency and
  terminal transport.
- KV stores only presence and rebuildable indexes/caches; eventual KV state is
  never lifecycle authority.
- R2 stores explicitly defined workspace snapshots or artifacts, not session
  identity.
- Local-source rows in D1 are projections keyed by `(user_id, source_id,
  mc_session_id)`. They cannot create, rename, end, or delete the local session.

A cloud session and a local session are separate source-owned sessions in V1.
The server does not synchronize their lifecycle.

## Lifecycle and cleanup

Session lifecycle and resource lifecycle are separate.

- `mc end` stops any live generation and archives the session.
- Ending a session does not delete a repository, worktree, branch, tool home,
  snapshot, or other workspace resource.
- Explicit cleanup may remove only resources with exact mc ownership evidence,
  after revalidating that the target still matches the creation receipt.
- Session deletion is explicit and separate from ending and resource cleanup.
- Missing, malformed, relocated, or ambiguous state is reported without a
  destructive guess.

## Execution and capability cutover

V1 exposes one certified execution path per supported tool/source combination.
If readiness or the credential boundary cannot be proven, launch fails before
the tool process starts.

There is no fallback to:

- a host tool login or tool-home credential file;
- `--native` or any equivalent flag/configuration;
- a new conversation when exact resume was requested;
- a global or legacy broker;
- a local `gh` login, token, keyring, arbitrary API, or real-CLI passthrough;
- an older registry or server protocol after a session has completed V1
  migration.

`mc github` remains canonical. A session-scoped `gh` compatibility shim may map
only documented commands to the same typed GitHub App operations; it is not a
fallback authority.

## Migration and cutover

Migration is an explicit, finite product transition, not a permanent dual
system.

- Existing `mcs_*` ids are preserved as `mc_session_id` where valid.
- Entries without a valid id receive one exactly once.
- Legacy registry, managed-generation, runtime-host, workspace, conversation,
  and server projection data is imported idempotently into the new model.
- The migrator writes an immutable plan, exact receipts, and a bounded backup
  before publishing completion.
- A live incompatible legacy runtime blocks cutover with an exact list of
  sessions to exit. It is never killed or guessed away.
- Interrupted migration resumes or rolls back from receipts without dual
  authority.
- After the completion receipt, the current binary reads and writes only V1
  state. Old storage may remain as a non-executable migration backup until
  explicit cleanup.
- Release/interlock metadata prevents an older binary from writing legacy state
  after V1 cutover.

Server endpoints for older released clients may coexist during one bounded
rollout window. The V1 client never calls them as a fallback, and their removal
is a required cleanup step once the new client is deployed and verified.

## Non-goals

V1 does not define:

- continuation, migration, `continued_from`, or `handed_off_from` relationships
  between machine and cloud sessions;
- synchronization of the same session across sources;
- the `mc supervisor` product or structured multi-session control;
- autonomous agent orchestration, scheduling, or merge loops;
- a replacement for Git, the coding-tool TUI, shell, editor, or host sandbox;
- arbitrary project/dependency/vendor capability redesign unrelated to the
  session cutover;
- new tool, operating-system, or cloud-host support claims without separate
  certification.

## Completion criteria

V1 is complete only when all of the following are true:

1. Fresh local and cloud sessions use `mc_session_id` as their sole lifecycle
   identity and are owned by exactly one source.
2. Local lifecycle commands use session homes; no active command depends on
   `registry.json`, a repository-scoped name, or a worktree-owned identity.
3. A local session can launch successively from multiple repositories,
   worktrees, and ordinary directories without identity change.
4. `mc new` creates no branch or worktree unless the user explicitly requests
   that resource.
5. Attach/resume under timeout, crash, output flood, alternate-screen TUI, and
   resize tests cannot duplicate a process and reconstruct a usable terminal.
6. Local listing performs no socket or network probes and remains bounded when
   fixtures contain at least 1,000 sessions.
7. End, delete, and resource cleanup pass destructive negative-space tests;
   external and merely observed workspaces are untouched.
8. Local and cloud projections cannot mutate the other source's lifecycle.
9. Codex and Claude pass the same certified launch/resume/switch contract and
   the credential-boundary suites.
10. Active source, help, tests, and documentation contain no `--native`,
    managed/native selection, global-broker fallback, local GitHub authority
    fallback, or new lifecycle use of `coding_session_id`.
11. Migration fixtures, interrupted cutover, incompatible-live-runtime, old
    binary interlock, installed-package smoke, and the published local/cloud
    journey matrix pass.
