# MEMORO.md — memoro-cli

The intent-map for this repo: **what** we're building, **where** we're headed,
and **where everything stands.** Sparse by rule — a node is never more than a
name, 2–3 sentences, a `status · scope · timeframe` line, and an optional pointer
to its detailed plan. Detail lives in `docs/plans/`, never here. The orchestrator
grounds in this file at session start and keeps it current as work lands.

## North star

Make **one human able to run grounded coding work** — across any tool, model,
repo, and machine — through a structural control plane that keeps map, sessions,
tools, branches, and memory coherent without depending on a fragile
"orchestrator" prompt persona.

## Long-term goals

- **G1 — Roadmap and end-goal awareness.** The session always sees the
  project's north star, active roadmap, and why the current work matters before
  it starts touching details.
- **G2 — Structural control-plane discipline.** mc keeps the session topology,
  map, tool choice, worktree state, and dispatch/read/control actions explicit;
  any LLM surface may use that frame, but mc should not rely on an
  orchestrator prompt role to function.
- **G3 — Cross-session work-project order.** Work projects stay coherent across
  sessions, tools, branches, and days through a small committed `MEMORO.md` map
  plus reliable session/worktree/tool continuity.

## Delmål & projects   (`status · scope · timeframe`)

### Grounding — the core mechanic   · serves G1, G2, G3
A session must be handed the right context *before the user types*. Today
`mc new` gives almost none — this is the first thing to get right.

- **Session grounding at entry** — `shipped · L · now`
  Every entry (`mc`, `mc new`, `mc resume`) injects the bundle `{ map + role +
  lens + focus }` into standing context before the user types, so the LLM wakes
  grounded. Phase 1 shipped bare `mc`; Phase 2 shipped entry-parity (`mc new
  [<task>]` / `mc resume` ground via the same seam), the MEMORO.md lifecycle
  (seed/update as committed coordinator state, never hidden background churn),
  and the adapter-sync drift-fix
  (grounding block stripped before the wrapper byte-compare). Phase 3 shipped
  tool-switching: the launcher is adapter-routed (no longer claude-hardcoded),
  codex has writeGrounding/removeGrounding parity into AGENTS.md, `mc new
  --codex`/`--claude` sugar over `--tool`, and resume tool flags never mutate a
  live TUI session. `mc tool-switch` sets the default for future bare `mc` /
  `mc new` starts. Drift-strip now covers BOTH adapters' markers. Phase 4 made lens auto-injection first-class
  (the whole `portrait-coding` response is pulled in one call, no manual `lens
  pull`) and derives the session's render language from the lens/user_state →
  a "respond in <language>" directive, English default. Language is SERVER-
  GATED: the lens endpoints expose no language/locale field today (verified
  live), so it resolves to English for every real response — the seam is wired
  to light up the instant the server adds the field. A per-repo `language`
  setting in MEMORO.md (a single `<!-- memoro:language: <Lang> -->` line, any
  position) now un-gates language steering locally and WINS over the server
  locale (`MEMORO.md > server locale > English`), stripped from the rendered
  map so it never shows as prose. Phase 5 (Universal) shipped: the orchestrator
  role + coordination canon now ship INSIDE the mc package (`canon/`, in
  `package.json` `files`), so `buildRole` is package-canon-aware — an empty repo
  with no `.claude`/`docs` files still wakes with the FULL role (framing + the
  two load-bearing purposes inline + canonical-source pointers), resolved from
  mc's own install root (works `npm i -g`/npx/cloned checkout). Terse fallback
  now means a broken install only, never "repo has no .claude". The checked-in
  canon copy is guarded against drift from its repo source by a test. Grounding
  MVP is complete.
  → `docs/plans/mc-new-grounding.md`

### Orchestration — minimal coordinator runtime   · serves G2, G3
mc should not become a PM system. Its job is to expose a reliable structural
frame around coding tools: map, sessions, worktrees, broker state, transcript
tails, dispatch, and cleanup. LLM surfaces can sit above that frame, but the
frame itself must work as terminal commands first.

- **Session Fabric: tracked project sessions** — `active · M · now`
  The endgame is one coordinator session plus several durable project sessions
  (`i18n`, `automations`, `courses`, etc.), all created and tracked by mc. Tool
  agents remain disposable inside a project session; mc owns the top-level
  topology: parent/child, worktree, branch, focus, policy, transcript/status,
  and MEMORO.md reconciliation. First slices shipped in 0.7.6: `mc spawn`
  creates tracked project sessions with briefs, and `mc list --tree` exposes
  the coordinator/project shape. The current slice adds `mc supervisor` as the
  terminal entrypoint for a single online-synced supervisor conversation backed
  by separate scoped Memoro device auth (`mc.supervisor`), never the primary
  Memoro auth token. Supervisor tokens live in their own keychain account,
  require server scope+audience proof before storage, and are client-guarded
  to supervisor API paths; local broker controls underneath cover snapshot,
  read, send, stop, and remove. → `docs/plans/session-fabric.md`
- **Continuity: resume work in a new session** — `active · S · now`
  mc is a **continuity layer**, not an agent-runner: the engine (agents, spawn,
  parallelism) comes free from the underlying model/tool; mc adds grounding +
  MEMORO.md as living project state. Payoff: resume a piece of work in a new
  session (other day/machine/tool) because it grounds in the map. 0.7.6 fixed
  the concrete resume/list incident: named sessions now reuse stable mc coding
  session IDs, `mc list` separates reachable active sessions from local dead
  sessions, and numbered resume/picker paths are usable. A fanout/verify/gather
  spine, PM-ish map verbs, and resume-by-intent machinery remain rejected for
  now: keep the start state excellent and let the coordinator session do the
  orchestration. → `docs/plans/fanout-spine.md`
- **Session runtime hardening** — `active · M · now`
  A named mc session must be more than a worktree: resume must re-enter the
  same broker-owned Codex/Claude PTY when it is live, and must never silently
  create a fake new session in the same worktree. The immediate work is to lock
  the runtime contract with tests, harden broker attach/matching, make cold
  restart interactive/confirmed, make never-launched tracked sessions start
  fresh with grounding on first resume, and keep cloud/local launch paths on the
  same session-intent seam. → `docs/plans/session-runtime-hardening.md`
- **Main/worktree hygiene** — `active · M · now`
  `mc` must be stricter than `cs` about git/session order: primary `main` is a
  clean baseline, while real work lives in named session worktrees and branches.
  Next work should make `mc status`, `mc list`, `mc end`, and `mc reconcile`
  expose dirty primary drift, local/remote divergence, squash-merged session
  branches, and safe cleanup paths without hidden resets or PM behavior.
  → `docs/plans/main-worktree-hygiene.md`
- **Coordinator wake-up quality** — `active · M · now`
  The next quality bar is not more CLI verbs; it is a sharper first minute. A
  resumed coordinator should immediately see the north star, active project
  nodes, role boundary, current worktree/tool, and the rule that non-trivial
  implementation gets delegated via a brief rather than done heads-down here.
  → `docs/plans/fanout-spine.md`
- **Map reconciliation guard** — `active · S · now`
  Reading MEMORO.md at startup is not enough; 0.7.6 itself proved that shipped
  work can leave the map stale unless reconciliation is prompted deliberately.
  Design is now locked: `/mc map` is primarily an in-session reconciliation
  habit, not a terminal CRUD surface; it is a concise prompt to the live LLM
  session to update `MEMORO.md` if the roadmap needs it. Slice 1 shipped the
  managed session affordance: `/mc map` is the single user-facing habit across
  tools; Claude gets a managed `/mc` command that handles `map`, and
  grounding/canon teaches other tools the same convention. Next slices are
  live-use polish and later optional status/list/end tripwires. Avoid hidden
  background edits, duplicate `/mc end` reconciliation flow, and PM-style map
  CRUD.
  → `docs/plans/map-reconciliation.md`
- **Hosted live-session workspace** — `active · M · now`
  Memoro gets a browser-native coding workspace where cloud exposes only a
  constrained `mc` orchestrator surface, not a free shell. The browser is a real
  PTY viewport into `mc` sessions owned by explicit sources: local machine
  brokers today, and Memoro Cloud sandboxes next. Phase 1 shipped PTY extraction;
  Phase 2 shipped broker-owned local launch/attach plus multi-attach input;
  Phase 3a shipped the CLI-side cloud bridge; Phase 4 source-aware list/attach
  is live across memoro-cli + Memoro. Phase 5a/5b shipped the typed
  `/api/mc/cloud-sessions` lifecycle, `MC_CLOUD_RUNTIME` Sandbox launcher,
  booting/runtime status, and stop-time token revoke. Phase 5c now tightens the
  product/security contract: cloud start uses a server repo catalog (`repo_id`),
  not browser-entered repo strings; broker sessions advertise credential-scrubbed
  repo refs; local broker connections now advertise a source-level repo catalog
  before any session exists; and the LLM child env is scrubbed of the runtime
  token. The current foundation slice adds a non-user-facing `mc.cloud` runtime
  scope, factors the server repo catalog into repo grants, adds explicit cloud
  lifecycle state, and stops broker-daemon/upload children from inheriting raw
  Memoro tokens. The launch contract is now unified in memoro-cli: local `mc
  new`, `mc resume`, and internal `mc cloud-session start` all render through
  one session-intent seam before reaching the broker-owned PTY runtime. The
  current MVP boundary is one active cloud worktree/session per user: Memoro
  resolves a server-approved launch target, prepares a sandbox worktree, starts
  `mc` inside it, and returns the existing active cloud session unless the user
  explicitly stops/replaces it. Next gate is the real capability boundary for
  cloud connector auth plus private repo clone/fetch: secrets must be consumed
  by a control-plane/sidecar, never exposed to the session env, argv, files,
  prompt, transcript, or browser.
  → `docs/plans/hosted-live-session-workspace.md`
- **Ensemble & hierarchy** — `later · M · —`
  Multi-model ensembles and recursive mid-agents, layered on the spine. → §10b/§10c

### Policy & safety — same freedom across tools   · serves G2, G3
- **Unified permissions and secrets policy** — `active · M · now`
  Users should configure their desired freedom and secret handling once, not
  separately for Claude, Codex, Gemini, and future tools. P1-P3 are landed:
  status now explains effective policy, explicit vault targets prevent
  provider-name guessing, and permission profile precedence is visible as
  `session > repo > global > default` with unsupported adapter fields labelled
  honestly. Configuration model work has shipped: `mc status --json` and
  `mc auth status --json` expose `effective_config`, package defaults are
  safety-floored, repo policy/local config are first-class, and Codex launch
  policy renders explicit `workspace`/`approval` only. Claude remains
  visibility-only until its mapping is defensible. → `docs/plans/unified-policy.md`
- **Data-access guard policy** — `shipped · S · now`
  Codex sessions launched by `mc` install a PATH guard that blocks direct
  Cloudflare data surfaces (`d1 execute`, R2 object access, KV reads, tail,
  secrets, and similar). The admin-script bypass is no longer hardcoded for
  Memoro; repos declare their own safe wrappers through
  `dataAccess.cloudflare.approvedScripts` in `.mc/policy.json`, with no bypass
  by default. → `docs/plans/configuration-model.md`
- **Vault import from local secret files** — `active · M · now`
  The user path must be migration, not manual copy-paste: scan `.env` /
  `.dev.vars`, import selected secret values into mc vault, commit only
  value-free bindings, and materialise session/worktree runtime files when
  needed. Core migration shipped in 0.7.6: scan/import, duplicate-safe previews,
  value-free `.mc/secrets.json` repo bindings, `mc vault set --bind`, repo-bound
  runtime materialisation, LLM read-blocking, shred on `mc end`, and honest
  cache/metadata-read diagnostics. Remaining slices are inspection/manual
  materialisation (`mc vault materialise --dry-run`), existing-label
  overwrite/rotate UX, and explicit source-file rewrite (`--move`).
  → `docs/plans/vault-import.md`

### Memory loop — Memoro ↔ session   · serves G1, G3
- **Wire the bidirectional loop** — `shipped · M · —`
  Both directions live. Emit: session-end observations → `/api/sessions/external`
  now belongs to `mc` itself (wrap cleanup + broker sidecars schedule upload
  through `src/commands/session.js`, with deterministic annotations + a
  first-upload trust moment), so raw `claude` / `codex` can stay clean. Pull:
  the `portrait-coding` lens auto-injects into standing context — delivered by
  grounding Phase 4. Remaining enhancement is the server-side language field
  (cross-repo), which sharpens the lens but is not required for the loop.
  → `docs/plans/worktree-lifecycle.md` §16

### Tool-portability — any tool, any repo   · serves G2, G3
- **Materialise package-canon into any repo** — `shipped · M · —`
  The orchestrator canon ships IN the mc package (Phase 5) and `buildRole`
  inlines the role at grounding time — but a fresh repo never received the
  actual skill/command FILES, so `/be-coordinator` + the agent-coordination
  skill didn't exist on disk there. `mc adapter materialise` now copies the
  package canon (coding-agent-protocol.md, agent-coordination.md,
  be-coordinator.md) into the repo's docs/ + .claude/ at their verified
  destinations, so any repo can carry the coordinator tooling. Drift-aware
  (never silent clobber: missing → materialise, differs → refuse without
  --force), idempotent, exit-before-side-effect (a single drift aborts the
  whole run — no half-materialised state). Same `mc adapter` verb family as
  `sync`, opposite direction (materialise lays down the canonical sources;
  sync points the per-tool wrappers at them). → §13c
- **Tool-switch in ordinary repos** — `shipped · S · —`
  0.7.6 fixed the portability gap found live in `memoro`: `mc tool-switch` can
  use the installed package canon when an ordinary repo has no materialised
  local canon, and wrapper drift no longer blocks persisting the selected
  default tool. → `docs/plans/mc-hardening.md`

### Knowledge access — memoro-agent   · serves G1, G3
- **`mc auth agent` enrollment** — `gated (memoro server) · S · —`
  MCP endpoint + agent scope don't exist server-side yet (code-verified). Park
  until memoro ships them. → §15

## Keeping the map current

`MEMORO.md` is living project state, not a read-only artifact. Agents should
update it directly when work materially changes roadmap state, creates a new
project node, lands a phase, or changes what "next" means; no separate
confirmation step is required. Keep edits sparse, never turn the map into a
changelog or plan dump, and report map changes in the final summary so they are
visible and can be committed with the work.
