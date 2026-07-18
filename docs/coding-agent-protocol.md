# Coding-agent protocol for memoro-cli

Canonical, tool-agnostic project instructions for any coding agent
working on this repo. Claude Code reads `CLAUDE.md`, Codex / GPT
agents read `AGENTS.md`; both are thin wrappers materialised from
this file by `mc adapter sync` (plan §13).

`memoro-cli` — the terminal coordinator for Memoro. Ships the `mc`,
`memoro-cli`, and `memoro` binaries. Node 22+, ESM, `node --test`.

Current product boundary: `mc` is a **minimal grounded coordinator
runtime**, not a project-management system and not an agent runner. It
keeps server-owned profile context, repo/session metadata, coordinator
role, and cross-session work projects visible; the launched LLM session
writes briefs and uses the agent tools already available in its host.

## Stack + commands

- Two binaries from one package (`package.json` `bin` field):
  - `memoro-cli` / `memoro` → `src/bin.js` (low-level: login, legacy lens
    compatibility, hook installation, heartbeat daemon)
  - `mc` → `src/bin-mc.js` (high-level: lifecycle, coordinator,
    fanout, vault, adapter sync)
- Test: `npm test` (runs `node --test 'tests/**/*.test.js'`,
  `node:assert/strict`).
- Plan: `docs/plans/worktree-lifecycle.md` is the long-running plan
  for the whole mc design. Read it (or at least the §-sections in
  scope) before starting any drev.

## Working on this codebase as a coding agent

For multi-PR work, multi-agent coordination, or any task delegated from a
coordinator session through the host tool's agent surface, **load
`.claude/skills/agent-coordination.md` first**. The file lives under
`.claude/` because Claude Code auto-discovers it there, but the
content is tool-agnostic — Codex / GPT agents read the same file
directly.

It codifies the coordinator ↔ agent loop and the engineering
patterns established across drev 1–5. Patterns include:

- Authority lives in the verbs (no logic duplication in docs/hints)
- Injectable dep-portals with soft-degrade
- Exit-before-side-effect
- Pure-helper export for in-process tests
- Defensive `--apply` parsing
- Subprocess test hygiene: env-scrub + `close` event
- Ask-vs-guess discipline (zero guesses on design)
- Negative requirements in delegation prompts
- Honest uncertainty disclosure (drev 4)
- Architectural self-upgrades, bounded (drev 4)
- Parallel agents safe when briefs are disjoint (drev 5)
- Which-layer-fired verification (drev 5)
- Tests cover non-JSON error paths too (PR #48)

**Priming as coordinator** depends on your tool:

- **Claude Code:** run `/be-coordinator` (slash command at
  `.claude/commands/be-coordinator.md`)
- **Codex / GPT / any other:** prompt the agent with: *"Read
  `.claude/skills/agent-coordination.md` and
  `.claude/commands/be-coordinator.md`, then follow the priming
  instructions in be-coordinator to enter coordinator mode."*

The instructions and the state probe are identical across tools;
only the invocation differs.

## Work Method Updates

When the user wants durable changes to how coding agents should work with
them, use `mc coding-profile read`, `mc coding-profile diff`, and `mc
coding-profile write` in dialogue with the user. Do not edit generated
adapter files, `AGENTS.md`, `CLAUDE.md`, or old repo roadmap files as a
substitute for the server-owned Coding Profile.

## Code conventions

- `src/mc/commands/<name>.js` for new `mc` subcommands (NOT
  `src/commands/`, which belongs to `memoro-cli` / `memoro`).
- `src/mc/` for mc-only subsystems (`registry.js`, `vault/`,
  `orchestration/`, `paths.js`, `git.js`, `adapter-sync.js`, …).
- Lazy import in `bin-mc.js` `LIFECYCLE` table — cold start matters
  because `mc` is called frequently from fanout flows.
- Tests mirror `src/` structure under `tests/`.
- Adapter contract: every `src/adapters/<tool>.js` exports
  - `ID` and `LABEL` — identity for sync + registry
  - `detect()` — soft signal that the user has the tool installed
  - `instructionsFile()` — `{ path, renderer }` or `null`; consumed
    by `mc adapter sync` (§13)
  - `TOOL_NAME`, `STATUS_TIMEOUT_MS`, `getStatus()` — `mc auth
    status` probe (§11a)

  The shape is gated by two contract tests:
  `tests/adapters/get-status-contract.test.js` (status surface) and
  `tests/adapters/materialise.test.js` (file-write helper).

## Critical paths — extra care

- `src/commands/auth.js` — Memoro keychain accounts, browser OAuth
  flow
- `src/commands/heartbeat-loop.js` — daemon with WebSocket reconnect
  policy (4003 'Replaced' is terminal — don't reconnect)
- `src/lib/device-flow.js` + `src/lib/keychain.js` — token issuance
  and macOS keychain access (§14)
- `src/mc/vault/` — provider-independent secret store (§12);
  client-side crypto + PreToolUse hook
- `src/mc/commands/end.js` + `src/mc/squash-phantom.js` — destructive
  worktree + branch operations
- `src/mc/commands/new.js` + `src/mc/commands/resume.js` — re-exec
  the same mc binary in wrap mode (PR #30); changes here affect
  every "open a tool in a session" path
- `src/mc/commands/adapter.js` + `src/mc/adapter-sync.js` —
  materialises CLAUDE.md / AGENTS.md from this file; bugs propagate
  to every repo using mc-managed wrappers
- `src/bin-mc.js` — dispatcher strips wrapper-injected flags before
  routing; commands rely on the env-var default (PR #29)
- The shell wrapper template literal in
  `src/mc/commands/install-shell.js` — wrapper bugs land in every
  user's `~/.zshrc`; ship with an importing smoke test

## What not to do

- Don't add a wrapper / dispatcher without an importing smoke test
  (PR #28 lesson)
- Don't duplicate install-hint strings (they belong in adapter
  `getStatus()` only)
- Don't make `mc list` / `mc auth status` print to stdout in a way
  that breaks `--json` consumers
- Don't guess on design with 2+ reasonable options — ask the
  coordinator (see the skill)
- Don't add `--non-interactive` flags to commands that are already
  non-interactive by default
- Don't hand-edit `CLAUDE.md` / `AGENTS.md` (or any other file
  declared by an adapter's `instructionsFile()`). They're managed
  by `mc adapter sync`; hand-edits are flagged as drift on the
  next sync. Edit this file instead.

## Plan + skill cross-reference

| Plan section | Skill section | Status |
|---|---|---|
| §2 lifecycle commands | step 4 implement | shipped (drev 1) |
| §9 cleanup tooling | patterns 1, 2, 7 | shipped (drev 2) |
| §10 orchestration | the whole skill | fanout MVP shipped; verifier + ensemble + hierarchy pending |
| §11 onboarding | patterns 5, 8 | shipped (drev 2) |
| §12 token vault | patterns 2, 7, 12 | phases 1–3 shipped (drev 3, 4, 5a) |
| §13 tool-portability | this file | phases 1–3 shipped; canon materialised into repos (§13c) |
| §14 device flow | pattern 12 | shipped |
| §15 memoro-agent MCP | pattern 14 | proposed |

## Per-tool surface (what each tool reads natively)

| Tool | Reads | Notes |
|---|---|---|
| Claude Code | `CLAUDE.md` (root) + `.claude/skills/`, `.claude/commands/`, `.claude/hooks/`, `.claude/settings.json` | Full native support today |
| Codex / GPT | `AGENTS.md` (root) | Markdown only; skills and slash commands are read manually via the prompt above |
| Gemini CLI | none yet | `instructionsFile()` returns null pending verification of Gemini's project-instruction convention |

`mc adapter sync` materialises the wrappers from this file. `mc
tool-switch <tool>` swaps the default tool for future bare `mc` / `mc new`
starts (plan §13d). Existing sessions change tool only when relaunched with
`mc resume <name> --codex` / `--claude`; a running TUI cannot switch tool
in place.
