# Session grounding at entry (+ MEMORO.md)

**Status:** proposed · 2026-06-02 · serves G1, G2 (see `MEMORO.md`)

Detailed plan for the MEMORO.md node *"Session grounding at entry"*. The map node
stays terse; depth lives here.

## Problem

Entering an mc session injects **no context** today. `mc new`
(`src/mc/commands/new.js`) creates a worktree + branch, then re-execs mc in wrap
mode to launch the tool — the LLM gets only the static thin `CLAUDE.md` the
worktree inherits. No role, no user context, no focus; no task parameter even
exists. A session wakes un-primed and must be oriented through conversation. (This
plan was designed inside a session that failed exactly this way — the failure is
the proof.)

## Goal

Every way into an mc session hands the LLM the **right context before the user
types**, so it wakes grounded in the whole. The bundle:

```
{ MEMORO.md map  — the repo's intent (what / where / where it stands)
  role           — orchestrator framing + its purpose (onboarding-aware)
  lens           — who the user is, from Memoro (governs language + prefs)
  focus          — a soft, mutable pointer into the map ("currently on X") }
```

Grounding is a **shared behaviour of every entry point**, not a feature of one
verb:

- **`mc`** — ground a session *right where you stand*. No worktree, no git. Lowest
  friction; the universal entry; reaches the no-git developer directly.
- **`mc new [<task>]`** — create a fresh worktree *and* ground there (git). For a
  new isolated chunk of work.
- **`mc resume <x>`** — re-enter an existing worktree + ground.

`<task>` / focus is a **soft opening pointer, never binding** — developers switch
tracks mid-session constantly. The name is not derived from it; identity is
lightweight and renamable. The anchor is grounding in the whole map, not the task.

## The artifact: MEMORO.md

Sparse, forward-only intent-map at the repo root (this repo's `MEMORO.md` is the
reference form): north star → long-term goals → sub-goals → project nodes. A node
is never more than name + 2–3 sentences + `status · scope · timeframe` + optional
pointer. A file — git gives history/sharing/portability; no git → just the local
file. The orchestrator grounds in it and maintains it as work lands.

## Materialisation (reuse existing mechanisms — don't invent)

- **Standing-context injection** = the `adapter.writeLens(markdown, {cwd})`
  managed-block pattern (`src/commands/lens.js`). Generalise from "just the lens"
  to the full bundle as one managed block, rendered per-adapter into that tool's
  instructions file.
- **Pre-launch slot** = `src/mc/commands/new.js:181–210`, where §12d already
  materialises vault tokens *before* the wrap-mode re-exec. The bundle is written
  at the same slot, into the session's cwd, before `pty.spawn` — tool-agnostic.

## Onboarding (cold start: downloaded, run `mc`, no LLM connected)

Without an LLM, `mc` can't be conversational. So onboarding has two layers:

1. **Pre-LLM (mc itself, deterministic) — the one hard gate: connect a tool.**
   `mc` with no tool can't ground; it drops to setup guidance (reuse `mc setup`
   detection): show detected tools, point to install, get out of the way.
2. **Post-LLM (the grounded session, conversational) — everything else.** Once a
   tool exists, `mc` grounds, and the **role is onboarding-aware**: "fresh repo,
   no map, no Memoro → interview the user, seed MEMORO.md, suggest `mc login`."
   Rich onboarding is the orchestrator's first task, not a wizard.

Graceful degradation throughout: no Memoro → no lens (grounding still works); no
git → ground in place; no MEMORO.md → the LLM seeds it.

## Switching the tool

Tool-level (claude / codex / gemini) is enough — no model-within-tool switching.

- **At start:** `mc new "<task>" --codex` (`--claude` etc., sugar over
  `--tool <x>`) — pick the adapter, render the bundle into its file, launch it.
- **Mid-session:** `!mc switch codex` from inside the session (the `!` runs it
  inline) — re-render the *same bundle* via the target adapter + relaunch in the
  same worktree/branch. Worktree, branch, grounding persist; only the LLM and its
  native file change. (Planned §5; switching falls out of grounding because the
  bundle is tool-agnostic.)
- Carries on a switch: bundle ✅, worktree/branch ✅; transcript ⚠️ (tool-specific
  — drop, or fold a summary into the bundle as a handoff).

## Language

Defaults to English; governed by the user's coding profile / user_state from the
Memoro lens. Never a static choice.

## First slice (minimal proof)

**`mc` (bare): ground a session right where you stand.** Assemble
`{ map (if present) + role + lens (if available) + focus }` and materialise it into
standing context at the pre-launch slot, then launch the tool in place. claude-code;
git-optional; no worktree. Purest proof of the killer feature, free of worktree/git
entanglement. **Acceptance:** starting a session in this repo needs zero
re-explanation of mission / role / where things stand.

## Open questions (resolve per phase — don't guess)

- **Task delivery:** standing-context block only, or also as the opening prompt?
- **MEMORO.md on entry:** ground from it, then let coordinator work update it
  explicitly when the roadmap changed; never hidden auto-write.
- **First-run seeding** of MEMORO.md: in the grounding phase, or a follow-up?
- **Maintenance:** how nodes stay current (status ticks) without rot — ordinary
  edits + a stale-flag surfaced at grounding?
- **Onboarding (no tool):** guide to install only, or offer auto-install? (lean: guide)
- **Onboarding (no LLM):** may `mc` borrow Memoro's cloud LLM to make even
  pre-tool onboarding conversational? Then the gate becomes "Memoro *or* a local
  tool"; offline fallback stays the checklist.
- **Switch naming:** live `mc switch <tool>` vs existing `mc tool-switch` (default
  for new) — distinguish or unify?
- **Role/lens source now:** build against existing repo `.claude` files +
  `lens pull`; §13b.1 package-canon + auto-lens are later universal upgrades.

## Phasing (provisional)

1. **Phase 1 — Grounding MVP.** `mc` (bare) grounds in place: bundle assembly +
   materialise at the pre-launch slot; claude-code; git-optional. The minimal
   proof above.
2. **Phase 2 — Entry parity + MEMORO.md lifecycle.** `mc new` / `mc resume` share
   the grounding path; read + maintain nodes; first-run seeding.
3. **Phase 3 — Tool switching.** Adapter-routed launcher (today claude-hardcoded);
   `--codex`/`--claude` at start; `mc switch <tool>` mid-session. (§5)
4. **Phase 4 — Lens auto-injection.** Pull the Memoro lens into the bundle
   automatically (no manual `lens pull`); language from user_state. (§16)
5. **Phase 5 — Universal.** Role/canon ship in the mc package so any repo grounds
   without carrying the files. (§13b.1)
