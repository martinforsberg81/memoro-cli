# MEMORO.md — memoro-cli

The intent-map for this repo: **what** we're building, **where** we're headed,
and **where everything stands.** Sparse by rule — a node is never more than a
name, 2–3 sentences, a `status · scope · timeframe` line, and an optional pointer
to its detailed plan. Detail lives in `docs/plans/`, never here. The orchestrator
grounds in this file at session start and keeps it current as work lands.

## North star

Make **one human able to run a grounded coordinator session** — across any tool,
model, repo, and machine — that sees the whole, writes strong briefs, sends work
to the agent tools already available, and returns to the project map without
becoming a PM system.

## Long-term goals

- **G1 — Roadmap and end-goal awareness.** The session always sees the
  project's north star, active roadmap, and why the current work matters before
  it starts touching details.
- **G2 — Orchestrator-role discipline.** The LLM stays in the high-altitude
  coordinator role: plan, brief, delegate, review, and only drop into
  implementation when the user explicitly asks or the task is trivial.
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
  [<task>]` / `mc resume` ground via the same seam), the read-only MEMORO.md
  lifecycle (offer-to-seed/update, never silent), and the adapter-sync drift-fix
  (grounding block stripped before the wrapper byte-compare). Phase 3 shipped
  tool-switching: the launcher is adapter-routed (no longer claude-hardcoded),
  codex has writeGrounding/removeGrounding parity into AGENTS.md, `mc new
  --codex`/`--claude` sugar over `--tool`, and existing sessions switch tool
  only on relaunch via `mc resume <name> --codex/--claude`. `mc tool-switch`
  sets the default for future bare `mc` / `mc new`; it does not mutate a live
  TUI session. Drift-strip now covers BOTH adapters' markers. Phase 4 made lens auto-injection first-class
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
mc should not become an agent-runner or PM system. The LLM session itself writes
the prompt, sends work through the available agent tools, and asks review agents
when useful; mc's job is to make that session wake with the map, role, repo, and
tool state intact.

- **Session Fabric: tracked project sessions** — `active · M · now`
  The endgame is one coordinator session plus several durable project sessions
  (`i18n`, `automations`, `courses`, etc.), all created and tracked by mc. Tool
  agents remain disposable inside a project session; mc owns the top-level
  topology: parent/child, worktree, branch, focus, policy, transcript/status,
  and MEMORO.md reconciliation. → `docs/plans/session-fabric.md`
- **Continuity: resume work in a new session** — `active · S · now`
  mc is a **continuity layer**, not an agent-runner: the engine (agents, spawn,
  parallelism) comes free from the underlying model/tool; mc adds grounding +
  MEMORO.md as living project state. Payoff: resume a piece of work in a new
  session (other day/machine/tool) because it grounds in the map. The orchestrator
  operates a loop with *borrowed* agents — brief → tool-agent → separate review
  agent (2nd opinion) → merge — proven by hand. A fanout/verify/gather spine,
  map subcommands, and resume-by-intent machinery are all rejected for now as
  LLM-cruft: keep the start state excellent and let the coordinator session do
  the orchestration. → `docs/plans/fanout-spine.md`
- **Coordinator wake-up quality** — `active · M · now`
  The next quality bar is not more CLI verbs; it is a sharper first minute. A
  resumed coordinator should immediately see the north star, active project
  nodes, role boundary, current worktree/tool, and the rule that non-trivial
  implementation gets delegated via a brief rather than done heads-down here.
  → `docs/plans/fanout-spine.md`
- **Map reconciliation guard** — `next · S · after 0.7.5`
  Reading MEMORO.md at startup is not enough; the session must reconcile the map
  when work lands or drifts. mc should provide deterministic tripwires (status/end
  hints, stale active nodes, branches without map nodes) while keeping writes
  user-approved and avoiding a `mc map` command family. → `docs/plans/map-reconciliation.md`

### Policy & safety — same freedom across tools   · serves G2, G3
- **Unified permissions and secrets policy** — `active · M · now`
  Users should configure their desired freedom and secret handling once, not
  separately for Claude, Codex, Gemini, and future tools. P1-P3 are landed:
  status now explains effective policy, explicit vault targets prevent
  provider-name guessing, and permission profile precedence is visible as
  `session > repo > global > default` with unsupported adapter fields labelled
  honestly. Phase 4a has started with Codex launch-arg rendering for explicit
  `workspace`/`approval` only; default policy renders no flags, Claude remains
  visibility-only until its mapping is defensible. → `docs/plans/unified-policy.md`
- **Vault import from local secret files** — `active · M · now`
  The user path must be migration, not manual copy-paste: scan `.env` /
  `.dev.vars`, import selected secret values into mc vault, commit only
  value-free bindings, and materialise session/worktree runtime files when
  needed. Scan, import dry-run, and first real import are shipped: mc parses
  dotenv-shaped files, emits key metadata only, creates new vault entries after
  explicit confirmation, and skips existing labels by default. Binding writes
  and source-file rewrites are still future slices.
  → `docs/plans/vault-import.md`

### Memory loop — Memoro ↔ session   · serves G1, G3
- **Wire the bidirectional loop** — `shipped · M · —`
  Both directions live. Emit: session-end observations → `/api/sessions/external`
  was already wired to the claude-code `SessionEnd` hook (`src/commands/session.js`,
  with deterministic annotations + a first-upload trust moment). Pull: the
  `portrait-coding` lens auto-injects into standing context — delivered by
  grounding Phase 4. The loop closed when Phase 4 landed. Remaining enhancement is
  the server-side language field (cross-repo), which sharpens the lens but is not
  required for the loop. → `docs/plans/worktree-lifecycle.md` §16

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
- **Tool-switch in ordinary repos** — `active · S · now`
  Live testing in `memoro` found `mc tool-switch codex --dry-run` still expected
  repo-local `docs/coding-agent-protocol.md`. That violates package-canon
  portability: ordinary repos should ground/switch from the installed mc canon
  unless the repo has intentionally materialised its own copy. → `docs/plans/mc-hardening.md`

### Knowledge access — memoro-agent   · serves G1, G3
- **`mc auth agent` enrollment** — `gated (memoro server) · S · —`
  MCP endpoint + agent scope don't exist server-side yet (code-verified). Park
  until memoro ships them. → §15
