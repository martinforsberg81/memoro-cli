# mc V1 session implementation and PR plan

**Status:** accepted delivery plan

This plan delivers [`mc-v1-session-architecture.md`](mc-v1-session-architecture.md)
across `memoro-cli` and `memoro`. Each PR is reviewed against the contract and
its own slice before merge. A failed contract review, unexpected migration
condition, security regression, or failed check stops the sequence.

## Delivery rules

- Keep one focused PR per step and stack only declared dependencies.
- Preserve the currently installed mc and all active sessions until the explicit
  cutover step.
- Add the new authority before routing user commands to it.
- Do not introduce feature flags, `--native`, compatibility fallbacks, or
  permanent dual reads/writes to make intermediate states look complete.
- Add failure, interruption, concurrency, and negative-space tests in the PR
  that introduces each invariant.
- Review the complete diff and actual GitHub checks after every PR. Merge only
  when the slice and the cumulative stack conform to the contract.
- Production deployment and package release remain separate explicit rollout
  actions even after their source PRs merge.

## PR 0 — Ratify the V1 session contract (`memoro-cli`)

**Purpose:** establish one current product and delivery authority.

**Scope:** add the V1 contract and this plan; mark the repository-scoped product
definition, old PR plan, worktree lifecycle, managed-only cutover, and runtime
hardening plans as superseded where they conflict; preserve their security
evidence as historical input.

**Dependencies:** none.

**Validation:** links resolve, conflicting active-plan claims are marked, no
runtime files change, and `git diff --check` passes.

## PR 1 — Build the local session-home kernel (`memoro-cli`)

**Purpose:** replace the global registry architecture with isolated, bounded,
transactional session homes.

**Scope:** path and schema contracts; immutable identity; atomic metadata and
projection writes; per-name atomic claims; enumeration; permissions and trusted
root validation; per-session mutation serialization; repairable catalog reads.
No public lifecycle command cuts over yet.

**Dependencies:** PR 0.

**Validation:** create/read/update/rename races, malformed and symlinked state,
interrupted writes, one corrupt session among healthy sessions, name-claim
repair, permissions, and a 1,000-session enumeration fixture.

## PR 2 — Add workspace and owned-resource records (`memoro-cli`)

**Purpose:** make repositories and worktrees associations rather than session
identity or cleanup authority.

**Scope:** workspace schema and observations; launch context; repository and Git
metadata as optional observations; multiple checkouts; relocation and missing
paths; immutable resource creation intents and receipts; cleanup planning with
exact target revalidation.

**Dependencies:** PR 1.

**Validation:** multiple repositories, multiple worktrees of one repository,
ordinary directories, same basenames, relocated/missing paths, external versus
mc-created resources, forged ownership, and destructive negative space.

## PR 3 — Add cloud-session canonical storage (`memoro`)

**Purpose:** give cloud-owned sessions a canonical V1 identity and relational
model without making Memoro authoritative for local lifecycle.

**Scope:** D1 migrations for cloud sessions, workspace associations, runtime
generations, and source projections; indexes and uniqueness constraints; map
existing cloud and coding ids into bounded legacy-reference columns; update
tenancy export/deletion registries. KV and R2 remain non-authoritative.

**Dependencies:** PR 0 contract.

**Validation:** migration tests, source/name uniqueness, user isolation,
projection-versus-canonical constraints, runtime-generation ordering, SQL
inventory/governance, export, and account deletion.

## PR 4 — Publish the V1 cloud control-plane API (`memoro`)

**Purpose:** expose source-owned session operations and projections through one
versioned server contract.

**Scope:** authenticated create/read/update/list for cloud sessions; bounded
local-source projection and presence ingestion; per-session Durable Object
runtime coordination; multi-workspace tool handoff; GitHub capability routing
by session plus validated workspace target; no lifecycle mutation for local
projections.

Older client routes may remain only for the declared rollout window and share
no automatic fallback with the V1 routes.

**Dependencies:** PR 3.

**Validation:** authentication, tenancy, source spoofing, stale observations,
KV loss, Durable Object concurrency, multiple workspaces, wrong-repository
GitHub requests, local/cloud authority separation, and existing cloud-runtime
security suites.

## PR 5 — Re-key conversations and generation journals (`memoro-cli`)

**Purpose:** make `mc_session_id` the durable runtime correlation and fold the
existing generation journal into the session home.

**Scope:** conversation records; generation intents and receipts; one-live-
generation claim; exact attach/resume/replacement/switch state machine; derived
status projection; move durable host lifecycle facts out of `hosts/` and
`managed-sessions/`. New code uses tool/conversation vocabulary only.

**Dependencies:** PRs 1–2.

**Validation:** concurrent starts, accepted-outcome timeouts, crash at every
journal phase, replay/idempotency, missing/conflicting handles, explicit
replacement, Codex↔Claude switch, and zero transcript/argv/env leakage.

## PR 6 — Replace the PTY and runtime-host data path (`memoro-cli`)

**Purpose:** make attachment fast and terminal-correct without coupling reads
or status to a busy PTY event loop.

**Scope:** per-session ephemeral runtime host under `run/`; exact socket
routing; terminal screen model and bounded scrollback; bounded client queues and
backpressure; deterministic resize/redraw; throttled projections; artifact and
prompt observation outside the output callback; no global broker on the new
path.

**Dependencies:** PR 5.

**Validation:** alternate-screen fixture, Unicode/chunk boundaries, resize,
slow and disconnected clients, sustained output flood, attach during output,
host crash/restart, no duplicate process, bounded memory, and event-loop/list
latency benchmarks compared with the recorded baseline.

## PR 7 — Establish one certified tool-execution path (`memoro-cli`)

**Purpose:** finish the interrupted execution redesign and remove mode/fallback
behavior.

**Scope:** one adapter launch/resume/switch contract for Codex and Claude;
remove `--native` parsing/help/recovery and managed/native selection; fail
closed on missing readiness; remove host-login and tool-home credential paths;
remove local `gh`/keyring authority and transitional host-GitHub environment
contracts; retain only the typed GitHub App shim.

**Dependencies:** PRs 4–6.

**Validation:** shared adapter contract, rejected `--native`, missing/stale
readiness, no implicit new conversation, credential boundary and source closure,
GitHub target policy, installed-package smoke, and bounded live Codex/Claude
journeys on the exact artifact.

## PR 8 — Build the one-time migration and cutover interlock (`memoro-cli`)

**Purpose:** preserve real sessions while ending legacy authority permanently.

**Scope:** inventory and plan old registry, identity, conversation, generation,
host, worktree, and projection state; preserve valid `mcs_*`; create bounded
backup and immutable receipts; resume interrupted migration; refuse live
incompatible runtimes; reconcile derived liveness from the exact lifecycle
journal rather than a stale registry projection; block older binaries after
completion. The migrator is finite and never becomes a runtime fallback.

**Dependencies:** PRs 1–2 and 5–7.

**Validation:** every supported old schema fixture, duplicate and ambiguous
identity, live-host refusal, interruption at every write boundary, retry,
rollback before publication, exact backup, no dual writer, old-binary
interlock, a registry `live` row whose exact lifecycle journal says `exited`,
and no legacy read after completion.

## PR 9 — Cut over the daily lifecycle and session list (`memoro-cli`)

**Purpose:** route the user-visible core to source-owned V1 sessions.

**Scope:** `new`, `open`, `list`, `status`, `rename`, working-directory helpers,
send/read, and local/cloud presentation; `new` uses the current directory and
does not create Git resources; `open` attaches or exactly resumes; local list
enumerates projections without sockets/network; cloud rows come from the V1
API and remain separately source-owned. Local attach/send/read route directly
to the session-owned machine-local runtime host; they do not use the Memoro
UserSession WebSocket as a runtime command or liveness channel.

**Dependencies:** PRs 4 and 8.

**Validation:** full fresh/new/open/attach/exit/reopen journey; multiple
workspaces; rename; absent workspace; same names across sources; JSON stability;
offline local list; 1,000 sessions; busy runtime; cloud reachability; and no
registry/global-broker imports or local-runtime UserSession WebSocket traffic
in active commands.

## PR 10 — Separate end, delete, and resource cleanup (`memoro-cli`)

**Purpose:** make lifecycle cleanup predictable and non-destructive by default.

**Scope:** `end` stops and archives; explicit session deletion; explicit owned-
resource cleanup; adapt doctor, gc, storage, repair, dev-server, and sidecar
cleanup to session homes and exact provenance; remove implicit branch/worktree
deletion.

**Dependencies:** PR 9.

**Validation:** live/idle/dead sessions, interrupted end, external and relocated
workspaces, mc-created worktrees, dirty/unmerged Git state, forged/stale
receipts, repeated cleanup, and guarantees that end alone changes no Git
resource.

## PR 11A — Remove local legacy implementation and certify V1 (`memoro-cli`)

**Purpose:** leave one comprehensible implementation rather than another
half-finished cutover.

**Scope:** delete unreachable registry lifecycle, global broker, old launch and
resume branches, local GitHub fallback code, legacy environment contracts, and
superseded active documentation; remove the local-runtime heartbeat WebSocket,
its `runtime_event` path, and the legacy credential-domain double-persist
recovery branch; retain only bounded migration readers and non-executable
backups; publish the command/support matrix and measured performance comparison.

**Dependencies:** PR 10 and successful migration/release-candidate journeys.

**Validation:** source-inventory assertions for forbidden imports/vocabulary,
full test suite, credential/security suites, `npm pack` installation smoke,
local migration smoke, PTY stress suite, and live Codex/Claude/GitHub App
journeys. Source inventory also proves that local runtime liveness has no
UserSession `ping`/`pong` dependency and credential cleanup is receipt-driven
and idempotent after its source directory is gone.

## PR 11B — Retire server legacy routes (`memoro`)

**Purpose:** end the bounded rollout window after the V1 client is deployed and
verified.

**Scope:** remove old coding-session/cloud-session route handlers and writes,
stop runtime use of legacy projection/handoff tables, update tenancy registries
for retained historical rows, and keep no server-side fallback from V1 to the
old contract. Destructive historical-data deletion is a separate explicitly
approved retention operation.

**Dependencies:** PR 11A released, V1 control-plane deployed, and verified
absence of supported old-client traffic.

**Validation:** route-removal tests, no legacy writes, V1 local/cloud/GitHub
journeys, tenancy export/deletion, SQL governance, full affected tests, and
production-readiness review before a separately approved deployment.

## Dependency and merge order

```text
PR 0
  ├─> PR 1 ─> PR 2 ─> PR 5 ─> PR 6 ─> PR 7 ─> PR 8 ─> PR 9 ─> PR 10 ─> PR 11A
  └─> PR 3 ─> PR 4 ────────────────────────────────────┘

PR 4 deployed before the V1 CLI release
PR 11A released and verified before PR 11B
```

PRs 3–4 may be implemented in parallel with PRs 1–2 after PR 0, but merge and
rollout follow the dependency graph. The local chain is stacked because later
steps replace the same lifecycle surface.

## Review contract after every PR

The review records:

1. the contract clauses delivered by the PR;
2. scope and non-goal compliance;
3. tests and live evidence actually run;
4. security and destructive negative-space findings;
5. migration and rollback behavior;
6. loose ends, classified as blocking or a named later PR;
7. cumulative compatibility with all already-reviewed PRs.

If the review passes and checks are terminal, the PR may merge in the declared
order. Any change to source ownership, session identity, workspace freedom,
single-path execution, cleanup authority, or the deferred cross-source scope
changes this contract and requires explicit agreement before implementation
continues.
