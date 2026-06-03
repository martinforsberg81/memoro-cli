# MEMORO.md — memoro-cli

The intent-map for this repo: **what** we're building, **where** we're headed,
and **where everything stands.** Sparse by rule — a node is never more than a
name, 2–3 sentences, a `status · scope · timeframe` line, and an optional pointer
to its detailed plan. Detail lives in `docs/plans/`, never here. The orchestrator
grounds in this file at session start and keeps it current as work lands.

## North star

Make **one human able to orchestrate a fleet of AI coding agents** — across any
tool, model, repo, and machine — from a single **high-altitude session grounded
in the whole**; and give that power to **small developers** who can't buy
enterprise systems.

## Long-term goals

- **G1 — The grounded fleet.** A session wakes already holding the whole (this
  map + role + who the user is) and ships work as verified parallel agents while
  the human stays high-altitude.
- **G2 — Project structure for the rest of us.** The intent-map + AI maintenance
  that replaces a heavyweight PM system — free, in any repo, git or not.

## Delmål & projects   (`status · scope · timeframe`)

### Grounding — the core mechanic   · serves G1, G2
A session must be handed the right context *before the user types*. Today
`mc new` gives almost none — this is the first thing to get right.

- **Session grounding at entry** — `active · L · now`
  Every entry (`mc`, `mc new`, `mc resume`) injects the bundle `{ map + role +
  lens + focus }` into standing context before the user types, so the LLM wakes
  grounded. Phase 1 shipped bare `mc`; Phase 2 shipped entry-parity (`mc new
  [<task>]` / `mc resume` ground via the same seam), the read-only MEMORO.md
  lifecycle (offer-to-seed/update, never silent), and the adapter-sync drift-fix
  (grounding block stripped before the wrapper byte-compare). Phase 3 shipped
  tool-switching: the launcher is adapter-routed (no longer claude-hardcoded),
  codex has writeGrounding/removeGrounding parity into AGENTS.md, `mc new
  --codex`/`--claude` sugar over `--tool`, and a mid-session switch unified into
  `mc tool-switch <tool> --here` (re-renders the same bundle via the target
  adapter + persists the per-session tool, user relaunches). Drift-strip now
  covers BOTH adapters' markers. Phase 4 made lens auto-injection first-class
  (the whole `portrait-coding` response is pulled in one call, no manual `lens
  pull`) and derives the session's render language from the lens/user_state →
  a "respond in <language>" directive, English default. Language is SERVER-
  GATED: the lens endpoints expose no language/locale field today (verified
  live), so it resolves to English for every real response — the seam is wired
  to light up the instant the server adds the field. Package-canon (P5)
  remains. → `docs/plans/mc-new-grounding.md`

### Orchestration — the fleet   · serves G1
Ship a plan as verified parallel agents; the coordinator never blocks.

- **Fanout spine: execute → verify → gather** — `next · L · after grounding`
  fanout stages today but doesn't run agents. Add headless background execution,
  `mc verify` as the trust gate, and make `mc gather` refuse rejected phases.
  → `docs/plans/worktree-lifecycle.md` §10s
- **Ensemble & hierarchy** — `later · M · —`
  Multi-model ensembles and recursive mid-agents, layered on the spine. → §10b/§10c

### Memory loop — Memoro ↔ session   · serves G1, G2
- **Wire the bidirectional loop** — `unblocked · M · after grounding`
  Emit observations on session end → `/api/sessions/external`; pull the
  `portrait-coding` lens into standing context. Both endpoints verified LIVE on
  the memoro side. → `docs/plans/worktree-lifecycle.md` §16

### Tool-portability — any tool, any repo   · serves G1
- **Canonical skills/commands in the mc package + Cursor/Aider** — `planned · M · —`
  Ship the orchestrator role as package-canon materialised into any repo
  (§13b.1); add Cursor/Aider adapters. → §13 Ph4–5

### Knowledge access — memoro-agent   · serves G1
- **`mc auth agent` enrollment** — `gated (memoro server) · S · —`
  MCP endpoint + agent scope don't exist server-side yet (code-verified). Park
  until memoro ships them. → §15
