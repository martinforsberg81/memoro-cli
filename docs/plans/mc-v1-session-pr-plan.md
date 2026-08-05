# mc V1 session implementation and PR plan

**Status:** accepted delivery plan

This plan delivers [`mc-v1-session-architecture.md`](mc-v1-session-architecture.md)
across `memoro-cli` and `memoro`. Each PR is reviewed against the contract and
its own slice before merge. A failed contract review, unexpected migration
condition, or security regression stops the sequence.

**Revision (2026-08-04): validation is suspended.** Test runs are no longer part
of this plan's delivery flow. The suite asserts large amounts of removed
architecture, and re-running it turned every step into a loop that never
terminated. Each PR below therefore states purpose, scope, and dependencies
only. The per-PR validation lists that used to sit inline are preserved
verbatim in the appendix as deferred input for PR 12 — they are an inventory,
not an instruction to run anything. The normative rule lives in
`docs/coding-agent-protocol.md`, "Validation is suspended".

## Delivery rules

- Keep one focused PR per step and stack only declared dependencies.
- Preserve the currently installed mc and all active sessions until the explicit
  cutover step.
- Add the new authority before routing user commands to it.
- Do not introduce feature flags, `--native`, compatibility fallbacks, or
  permanent dual reads/writes to make intermediate states look complete.
- Do not run tests as a condition of publishing or merging, and do not record
  missing coverage as a blocker. Reintroducing validation is PR 12's work.
- Review the complete diff after every PR. Merge only when the slice and the
  cumulative stack conform to the contract.
- Production deployment and package release remain separate explicit rollout
  actions even after their source PRs merge.

## PR 0 — Ratify the V1 session contract (`memoro-cli`) — merged (#263)

**Purpose:** establish one current product and delivery authority.

**Scope:** add the V1 contract and this plan; mark the repository-scoped product
definition, old PR plan, worktree lifecycle, managed-only cutover, and runtime
hardening plans as superseded where they conflict; preserve their security
evidence as historical input.

**Dependencies:** none.

## PR 1 — Build the local session-home kernel (`memoro-cli`) — merged (#264)

**Purpose:** replace the global registry architecture with isolated, bounded,
transactional session homes.

**Scope:** path and schema contracts; immutable identity; atomic metadata and
projection writes; per-name atomic claims; enumeration; permissions and trusted
root validation; per-session mutation serialization; repairable catalog reads.
No public lifecycle command cuts over yet.

**Dependencies:** PR 0.

## PR 2 — Add workspace and owned-resource records (`memoro-cli`) — merged (#265)

**Purpose:** make repositories and worktrees associations rather than session
identity or cleanup authority.

**Scope:** workspace schema and observations; launch context; repository and Git
metadata as optional observations; multiple checkouts; relocation and missing
paths; immutable resource creation intents and receipts; cleanup planning with
exact target revalidation.

**Dependencies:** PR 1.

## PR 3 — Add cloud-session canonical storage (`memoro`)

**Purpose:** give cloud-owned sessions a canonical V1 identity and relational
model without making Memoro authoritative for local lifecycle.

**Scope:** D1 migrations for cloud sessions, workspace associations, runtime
generations, and source projections; indexes and uniqueness constraints; map
existing cloud and coding ids into bounded legacy-reference columns; update
tenancy export/deletion registries. KV and R2 remain non-authoritative.

**Dependencies:** PR 0 contract.

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

## PR 5 — Re-key conversations and generation journals (`memoro-cli`) — merged (#267)

**Purpose:** make `mc_session_id` the durable runtime correlation and fold the
existing generation journal into the session home.

**Scope:** conversation records; generation intents and receipts; one-live-
generation claim; exact attach/resume/replacement/switch state machine; derived
status projection; move durable host lifecycle facts out of `hosts/` and
`managed-sessions/`. New code uses tool/conversation vocabulary only.

**Dependencies:** PRs 1–2.

## PR 6 — Replace the PTY and runtime-host data path (`memoro-cli`) — merged (#268)

**Purpose:** make attachment fast and terminal-correct without coupling reads
or status to a busy PTY event loop.

**Scope:** per-session ephemeral runtime host under `run/`; exact socket
routing; terminal screen model and bounded scrollback; bounded client queues and
backpressure; deterministic resize/redraw; throttled projections; artifact and
prompt observation outside the output callback; no global broker on the new
path.

**Dependencies:** PR 5.

## PR 7 — Establish one certified tool-execution path (`memoro-cli`) — merged (#269)

**Purpose:** finish the interrupted execution redesign and remove mode/fallback
behavior.

**Scope:** one adapter launch/resume/switch contract for Codex and Claude;
remove `--native` parsing/help/recovery and managed/native selection; fail
closed on missing readiness; remove host-login and tool-home credential paths;
remove local `gh`/keyring authority and transitional host-GitHub environment
contracts; retain only the typed GitHub App shim.

**Dependencies:** PRs 4–6.

## PR 8 — Build the one-time migration and cutover interlock (`memoro-cli`) — merged (#270)

**Purpose:** preserve real sessions while ending legacy authority permanently.

**Scope:** inventory and plan old registry, identity, conversation, generation,
host, worktree, and projection state; preserve valid `mcs_*`; create bounded
backup and immutable receipts; resume interrupted migration; refuse live
incompatible runtimes; reconcile derived liveness from the exact lifecycle
journal rather than a stale registry projection; block older binaries after
completion. The migrator is finite and never becomes a runtime fallback.

**Dependencies:** PRs 1–2 and 5–7.

**Known defects:** fixed by PR 8b.

## PR 8b — Make migration explicit and survivable (`memoro-cli`) — merged (#277)

**Purpose:** stop legacy state from deciding whether a new session can exist,
and let a real machine's history actually migrate.

**Scope:**

- `mc new` no longer runs the cutover. Creating, opening, and listing a session
  depend on session homes alone; migration is the explicit `mc migrate`.
- Cutover liveness is derived from the process table, not from recorded `live`
  rows. A journal or registry row whose broker pid is dead is stale
  bookkeeping; a running broker still refuses.
- `mc migrate [--dry-run] [--stop-legacy-runtimes] [--json]` reports which
  runtime blocks, why, and with which pid, and can stop them.
- `mc migrate --session <name>` moves named sessions only, quarantining
  nothing and publishing no completion, so a machine can rehearse the
  migration on work it can afford to lose. Receipts under `cutover/partial/`
  make the full cutover skip what was already moved. A session whose own
  runtime is alive is refused; the global broker is not a blocker here,
  because a selective migration takes nothing away from it.
- Differing provider handles across a session's generations are history, not a
  conflict: the registry handle wins, the latest generation fills a gap.
- A managed identity left under a reused session name is recorded as stale
  rather than aborting the migration, and is deliberately not bound.

**Dependencies:** PR 8.

## PR 9 — Cut over the daily lifecycle and session list (`memoro-cli`) — merged (#271)

**Purpose:** route the user-visible core to source-owned V1 sessions.

**Scope:** `new`, `open`, `list`, `status`, `rename`, working-directory helpers,
send/read, and local/cloud presentation; `new` uses the current directory and
does not create Git resources; `open` attaches or exactly resumes; local list
enumerates projections without sockets/network; cloud rows come from the V1
API and remain separately source-owned. Local attach/send/read route directly
to the session-owned machine-local runtime host; they do not use the Memoro
UserSession WebSocket as a runtime command or liveness channel.

**Dependencies:** PRs 4 and 8.

## PR 10 — Separate end, delete, and resource cleanup (`memoro-cli`) — merged (#275)

**Purpose:** make lifecycle cleanup predictable and non-destructive by default.

**Scope:** `end` stops and archives; explicit session deletion; explicit owned-
resource cleanup; adapt doctor, gc, storage, repair, dev-server, and sidecar
cleanup to session homes and exact provenance; remove implicit branch/worktree
deletion.

**Dependencies:** PR 9.

## PR 10b — Make the migrated machine actually usable (`memoro-cli`) — merged (#279–#283)

**Purpose:** close the gap between "the cutover completed" and "the user can
open a session", found by walking one machine's real state end to end rather
than by reading the code.

**Scope, one defect per merge:**

- #279 — a missing package reported a raw `ERR_MODULE_NOT_FOUND` stack after
  the command had printed success; it now names the package and the exact
  install command. The cutover also stopped trusting `broker.pid` alone and
  probes the legacy sockets before quarantining them.
- #280 — migrated sessions looked for their provider transcript under the new
  `mcs_*` id instead of the legacy id the migration recorded, so none could
  resume. Sessions whose conversation predates managed execution have no
  transcript at all; mc starts a fresh conversation for them and journals
  `legacy-transcript-unavailable` rather than asking for a flag.
- #281 — mc's own dev-server lock directory failed its own inventory, and
  teardown judged one session by every other session's records, so `mc end`
  failed for all of them. A failed generation demanded `--replace` forever for
  a conversation that never existed. An archived session could not be reopened.
  The credential-boundary diagnostic reached the surface for the first time.
- #282 — `mc delete` carried the same global dev-server gate as `end`.
- #283 — a session whose workspace is mc's own installation can never build a
  credential boundary there; mc now moves it to a workspace that works instead
  of refusing.

**Known and accepted:** `mc doctor` still reports pre-V1 dev-server manifests
as `dev-server-session-unbound`. They are inert bookkeeping — all 15 on the
reference machine have dead processes — and no command reaps them yet. Reaping
belongs with PR 11A's legacy removal, under an explicit verified-dead rule.

**Dependencies:** PRs 8b–10.

## PR 11A — Remove local legacy implementation (`memoro-cli`) — merged (#284)

**Purpose:** leave one comprehensible implementation rather than another
half-finished cutover.

**Scope:** delete unreachable registry lifecycle, global broker, old launch and
resume branches, local GitHub fallback code, legacy environment contracts, and
superseded active documentation; remove the local-runtime heartbeat WebSocket,
its `runtime_event` path, and the legacy credential-domain double-persist
recovery branch; retain only bounded migration readers and non-executable
backups; publish the command/support matrix.

Deleting a legacy subsystem includes deleting the tests that only existed to
assert it. Those deletions are part of this PR, not a later cleanup.

**Delivered:** wrap mode, the global broker, the legacy registry lifecycle, the
teardown engine, and the commands built on them (`spawn`, `broker`,
`supervisor`, `reconcile`, `fanout`, `gather`, `sessions watch|stop|remove`,
bare `mc` wrapping a tool). 56 source modules and 37 test files removed;
`mc restart` rebuilt on the V1 runtime primitives. Bare `mc` lists sessions and
no command is gated on being inside a Git repository. The matrix is
[`docs/mc-command-matrix.md`](../mc-command-matrix.md).

**Deferred to its own step:** reaping pre-V1 dev-server manifests, which
`mc doctor` reports and nothing removes.

**Dependencies:** PR 8b, PR 10, and a successful local migration journey.

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

## PR 12 — Rebuild validation deliberately (`memoro-cli`)

**Purpose:** end the suspension with a suite that can run to completion and
means something, rather than reintroducing assertions one PR at a time.

**Scope:** inventory every remaining test against current architecture; delete
what asserts removed subsystems; classify what survives; decide which
invariants of the V1 session contract are worth asserting at all and at which
level; make the suite hermetic and finite on a loaded developer machine;
restore the delivery-flow rule in `docs/coding-agent-protocol.md` once the
suite is trustworthy. The appendix below is the input inventory.

**Dependencies:** PR 11A. Independent of `memoro`-side work.

## Dependency and merge order

```text
PR 0
  ├─> PR 1 ─> PR 2 ─> PR 5 ─> PR 6 ─> PR 7 ─> PR 8 ─> PR 8b ─> PR 9 ─> PR 10 ─> PR 10b ─> PR 11A ─> PR 12
  └─> PR 3 ─> PR 4 ──────────────────────────────────────────────┘

PR 4 deployed before the V1 CLI release
PR 11A released and verified before PR 11B
```

PRs 3–4 may be implemented in parallel with PRs 1–2 after PR 0, but merge and
rollout follow the dependency graph. The local chain is stacked because later
steps replace the same lifecycle surface. PRs 9 and 10 merged before PR 8b
existed; PR 8b is sequenced next because nothing downstream is reachable on a
machine that cannot migrate.

## Review contract after every PR

The review records:

1. the contract clauses delivered by the PR;
2. scope and non-goal compliance;
3. what was and was not exercised, stated honestly and without claiming runs
   that did not happen;
4. security and destructive negative-space findings;
5. migration and rollback behavior;
6. loose ends, classified as blocking or a named later PR;
7. cumulative compatibility with all already-reviewed PRs.

If the review passes, the PR may merge in the declared order. Any change to
source ownership, session identity, workspace freedom, single-path execution,
cleanup authority, or the deferred cross-source scope changes this contract and
requires explicit agreement before implementation continues.

## Appendix — deferred validation inventory (not executable)

Preserved from the pre-revision plan as input for PR 12. These lines describe
what each slice was once expected to prove. They are not a to-do list, not a
merge gate, and not an instruction to write tests during PRs 8b–11B.

- **PR 0:** links resolve, conflicting active-plan claims are marked, no runtime
  files change, and `git diff --check` passes.
- **PR 1:** create/read/update/rename races, malformed and symlinked state,
  interrupted writes, one corrupt session among healthy sessions, name-claim
  repair, permissions, and a 1,000-session enumeration fixture.
- **PR 2:** multiple repositories, multiple worktrees of one repository,
  ordinary directories, same basenames, relocated/missing paths, external versus
  mc-created resources, forged ownership, and destructive negative space.
- **PR 3:** migration tests, source/name uniqueness, user isolation,
  projection-versus-canonical constraints, runtime-generation ordering, SQL
  inventory/governance, export, and account deletion.
- **PR 4:** authentication, tenancy, source spoofing, stale observations, KV
  loss, Durable Object concurrency, multiple workspaces, wrong-repository GitHub
  requests, local/cloud authority separation, and existing cloud-runtime
  security suites.
- **PR 5:** concurrent starts, accepted-outcome timeouts, crash at every journal
  phase, replay/idempotency, missing/conflicting handles, explicit replacement,
  Codex↔Claude switch, and zero transcript/argv/env leakage.
- **PR 6:** alternate-screen fixture, Unicode/chunk boundaries, resize, slow and
  disconnected clients, sustained output flood, attach during output, host
  crash/restart, no duplicate process, bounded memory, and event-loop/list
  latency benchmarks compared with the recorded baseline.
- **PR 7:** shared adapter contract, rejected `--native`, missing/stale
  readiness, no implicit new conversation, credential boundary and source
  closure, GitHub target policy, installed-package smoke, and bounded live
  Codex/Claude journeys on the exact artifact.
- **PR 8:** every supported old schema fixture, duplicate and ambiguous
  identity, live-host refusal, interruption at every write boundary, retry,
  rollback before publication, exact backup, no dual writer, old-binary
  interlock, a registry `live` row whose exact lifecycle journal says `exited`,
  and no legacy read after completion.
- **PR 9:** full fresh/new/open/attach/exit/reopen journey; multiple workspaces;
  rename; absent workspace; same names across sources; JSON stability; offline
  local list; 1,000 sessions; busy runtime; cloud reachability; and no
  registry/global-broker imports or local-runtime UserSession WebSocket traffic
  in active commands.
- **PR 10:** live/idle/dead sessions, interrupted end, external and relocated
  workspaces, mc-created worktrees, dirty/unmerged Git state, forged/stale
  receipts, repeated cleanup, and guarantees that end alone changes no Git
  resource.
- **PR 11A:** source-inventory assertions for forbidden imports/vocabulary, full
  test suite, credential/security suites, `npm pack` installation smoke, local
  migration smoke, PTY stress suite, and live Codex/Claude/GitHub App journeys.
  Source inventory also proves that local runtime liveness has no UserSession
  `ping`/`pong` dependency and credential cleanup is receipt-driven and
  idempotent after its source directory is gone.
- **PR 11B:** route-removal tests, no legacy writes, V1 local/cloud/GitHub
  journeys, tenancy export/deletion, SQL governance, full affected tests, and
  production-readiness review before a separately approved deployment.
