# Managed session lifecycle transaction

**Status:** in-flight

## Outcome

`mc open <name> --managed-portable` survives client timeouts, terminal loss,
broker restarts, provider exit, and interruption during credential
finalization without changing the logical mc session or provider-native
conversation.

Recovery is an ordinary, automatic part of `mc open`. It does not require a
special storage-repair command for expected crash windows.

## Root cause

The current managed lifecycle has no single durable transaction. Its state is
split across:

- the mutable worktree registry;
- an in-memory broker session and credential-domain map;
- a lifecycle file and provider artifact under a removable host directory;
- a credential-domain lease and manifest;
- a separately written provider-session archive;
- callbacks owned by the interactive attach client.

Those stores are updated independently. A process interruption can therefore
leave several individually valid facts that disagree. Later code tries to
infer which fact is newest from liveness, file presence, registry values, or a
launch response. Repeated fixes move the ambiguity to another boundary rather
than removing it.

## Invariants

1. `coding_session_id` is allocated once for a registry entry and is immutable
   for every resume and provider generation.
2. A managed runtime generation has one immutable launch intent and one
   append-only receipt chain.
3. A broker launch is idempotent by exact session ID, runtime generation, and
   intent digest. Repeating the same request returns the same generation;
   another generation conflicts.
4. Host processes, sockets, and in-memory maps are observations. They are never
   the durable source of lifecycle truth.
5. Provider exit is recorded synchronously in the durable generation before
   asynchronous custody, archive, or cleanup work begins.
6. Custody persistence, rollout archival, and credential-domain cleanup are
   individually idempotent and have separate durable receipts.
7. Registry fields are projections of a completed receipt chain. A missing
   registry callback cannot lose a provider session.
8. Credential values, auth bodies, CRK/DEK material, environment values,
   controller capabilities, transcript bodies, and model output never enter
   lifecycle receipts.
9. An ambiguous generation fails closed. It never causes a second provider
   launch and never deletes evidence.

## Durable layout

Each managed generation uses a private directory outside the removable host
tree:

```text
${MC_HOME}/managed-sessions/<session-part>/
  generation-claims/
    000000000001.json
    000000000002.json
  runtime-generations/
    <runtime-generation>/
      domain-ready.json
      broker-accepted.json
      live.json
      provider-artifact.json
      exited.json
      custody-persisted.json
      archive-ready.json
      domain-cleaned.json
      ready.json
      aborted.json
```

The sequence-numbered claim is the immutable launch intent. Starting a new
generation atomically claims the next sequence number. Two racing clients
therefore contend for the same non-replaceable file instead of creating two
independently plausible generations. A later sequence is valid only when the
previous generation has a terminal `ready` or `aborted` receipt.

Every receipt:

- has an exact, versioned schema;
- binds `coding_session_id`, `runtime_generation`, and the immutable intent
  digest;
- is written privately and atomically without replacing an existing receipt;
- treats an identical retry as success and conflicting content as corruption;
- contains only bounded metadata.

New credential domains use the runtime generation as their domain generation.
This binds the domain to the already-claimed intent even if interruption occurs
between manifest publication and `domain-ready`; a differently identified
legacy domain is never deleted as compensation for that intent.

At most one generation without `ready.json` or `aborted.json` may exist for a
session. Multiple non-terminal generations are an explicit fail-closed state.

## State model

```text
intent (claimed before credential-domain preparation)
  -> domain-ready
  -> broker-accepted
  -> live
  -> exited
  -> custody-persisted
  -> archive-ready
  -> domain-cleaned
  -> ready
```

`aborted` is allowed only before `broker-accepted`, or after positive broker
evidence that the generation never reached a provider process. A generation
that may have launched cannot be aborted merely because the client timed out.

Provider-artifact capture may occur after `live` and before or during `exited`.
Finalization cannot advance past `exited` without the exact artifact for the
same session and generation.

## Reconciliation

Every named and picker-based `mc open` path calls one reconciler before deciding
whether to attach or launch:

1. Validate the registry entry and its immutable `coding_session_id`.
2. Load all generation receipt chains for that ID.
3. Reject malformed chains or more than one non-terminal generation.
4. If the generation is live and the exact broker generation responds, attach
   to it.
5. If exit is durable, resume idempotent finalization from the first missing
   receipt.
6. If `ready` is durable, project its provider ID and generation into registry,
   then start a new resume generation only when the user is opening the
   session.
7. If launch was accepted but neither live nor exited can be proven, report an
   actionable indeterminate state and do not relaunch.
8. If only an intent/domain exists and broker acceptance is absent, safely
   abort that never-launched generation and retry the requested open.

The reconciler returns one typed action:

- `attach`
- `resume`
- `finalize`
- `start`
- `blocked`

Command handlers render the action; they do not reimplement lifecycle
decisions.

## Idempotent finalization

Finalization is restartable:

- Custody update may be retried with the same fixed secret record. A receipt is
  written only after the update succeeds.
- Rollout archival uses an immutable generation-specific target and an atomic
  manifest. Existing matching content is success; conflicting content is
  fail-closed.
- Credential-domain and lease removal validate the exact session and domain
  generation. Already absent paths are success only after the earlier custody
  and archive receipts exist.
- `ready` is written last and binds the provider-native session ID from the
  durable provider artifact.

## Migration

Existing state is imported without guessing:

- A quarantined domain is imported only when its lease, manifest, provider
  artifact, durable lifecycle exit, and session identity form one exact chain.
  Import itself is an idempotent receipt sequence, so it can be interrupted and
  resumed.
- A complete legacy archive can remain the registry's resume source when its
  provider ID was already projected. A legacy v1 archive by itself has no
  runtime-generation binding and is never promoted to journal authority.
- An unjournaled live broker session is not imported from a caller-provided
  flag. Older brokers do not expose the required transaction binding, so that
  case remains blocked instead of being duplicated or deleted.
- Missing or conflicting legacy evidence remains blocked and is never silently
  converted.

The current `--managed-provider-recovery` command first imports the same
generation receipt chain and then uses the same idempotent credential close.
It no longer finalizes state outside the lifecycle transaction.

## Completion criteria

- Repeating an identical launch after a lost response returns or attaches to
  the original generation.
- Killing the client after every lifecycle receipt leaves the next `mc open`
  able to continue or fail closed deterministically.
- Killing and restarting the broker after provider exit resumes finalization
  without losing the provider-native ID.
- Registry update failure does not lose a completed provider generation.
- Host cleanup cannot remove the durable receipt chain.
- Native and managed live sessions are distinguished by broker-owned durable
  evidence, not a caller-provided flag.
- Credential-boundary and C1 invariants remain green.

## Delivery

1. Add the strict receipt store and crash-matrix unit tests.
2. Make credential archival and cleanup idempotent.
3. Bind broker launch, provider artifact, exit, and finalization to receipts.
4. Add the single managed reconciler.
5. Route both named and picker `open` paths through the reconciler.
6. Import exact legacy exited generations and run the restart matrix. Ambiguous
   live legacy state remains quarantined for explicit operator review.
