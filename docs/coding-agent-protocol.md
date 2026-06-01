# Coding-agent protocol for memoro-cli

Canonical, tool-agnostic project instructions for any coding agent
working on this repo. Claude Code reads `CLAUDE.md`, Codex / GPT
agents read `AGENTS.md`; both are thin wrappers pointing here.

`memoro-cli` — the terminal coordinator for Memoro. Ships the `mc`
and `memoro-cli` binaries. Node 22+, ESM, `node --test`.

## Stack + commands

- Two binaries from one package:
  - `memoro-cli` / `memoro` → `src/bin.js` (low-level: login, lens
    injection, hook installation)
  - `mc` → `src/bin-mc.js` (high-level: lifecycle + coordinator)
- Test: `npm test` (uses `node --test 'tests/**/*.test.js'`,
  `node:assert/strict`)
- Plan: `docs/plans/worktree-lifecycle.md` is the long-running plan
  for the whole mc design. Read it before starting any drev.

## Working on this codebase as a coding agent

For multi-PR work, multi-agent coordination, or any task delegated
from a coordinator session, **load
`.claude/skills/agent-coordination.md` first**. The file lives under
`.claude/` because Claude Code auto-discovers it there, but the
content is tool-agnostic — Codex / GPT agents read the same file
directly.

It codifies the coordinator ↔ agent loop and the engineering patterns
established across drev 1 (foundation) + drev 2 (polish + onboarding)
— 8 PRs, +89 tests, zero regressions. Patterns include:

- Authority lives in the verbs (no logic duplication in docs/hints)
- Injectable dep-portals with soft-degrade
- Exit-before-side-effect
- Pure-helper export for in-process tests
- Defensive `--apply` parsing
- Env-scrub in test helpers
- Ask-vs-guess discipline (zero guesses on design)
- Negative requirements in delegation prompts
- **Honest uncertainty disclosure** (added drev 4): when verification
  of an acceptance criterion is blocked, surface it in judgment
  calls — never silently ship "verified"
- **Architectural self-upgrades, bounded** (added drev 4): ship the
  DRY helper / extensibility seam when one-line PR-body explanation
  is enough; refuse if it crosses into gold-plating
- Judgment calls in PR body (TDD-style)
- **Tests cover non-JSON error paths too** (added PR #48): never
  test-only the `--json` branch; errors on stderr must be asserted
  in the human-readable mode the user actually sees

**Priming as coordinator** depends on your tool:

- **Claude Code:** run `/be-coordinator` (slash command at
  `.claude/commands/be-coordinator.md`)
- **Codex / GPT / any other:** prompt the agent with: *"Read
  `.claude/skills/agent-coordination.md` and
  `.claude/commands/be-coordinator.md`, then follow the priming
  instructions in be-coordinator to enter coordinator mode."*

The instructions and the state probe are identical across tools;
only the invocation differs.

## Code conventions

- `src/mc/commands/<name>.js` for new `mc` subcommands (NOT
  `src/commands/`, which belongs to `memoro-cli`)
- Lazy import in `bin-mc.js` LIFECYCLE table — cold start matters
  because `mc` is called frequently from fanout flows
- Tests mirror `src/` structure under `tests/`
- Adapter contract: every `src/adapters/<tool>.js` exports
  `TOOL_NAME`, `detect()`, `getStatus()`, `STATUS_TIMEOUT_MS`.
  Contract test at `tests/adapters/get-status-contract.test.js`
  gates new tool adders.

## Critical paths — extra care

- `src/commands/auth.js` — Memoro keychain, browser OAuth flow
- `src/commands/heartbeat-loop.js` — daemon with WebSocket reconnect
  policy (4003 'Replaced' is terminal — don't reconnect)
- `src/mc/commands/end.js` + `src/mc/squash-phantom.js` — destructive
  worktree + branch operations
- `src/mc/commands/new.js` + `src/mc/commands/resume.js` — re-exec
  the same mc binary in wrap mode (PR #30); changes here affect
  every "open a tool in a session" path
- `src/bin-mc.js` — dispatcher strips wrapper-injected flags before
  routing; commands rely on the env-var default (PR #29)
- The shell wrapper template literal in
  `src/mc/commands/install-shell.js` — wrapper bugs land in every
  user's `~/.zshrc`; ship with smoke tests

## What not to do

- Don't add a wrapper / dispatcher without an importing smoke test
- Don't duplicate install-hint strings (they belong in adapter
  `getStatus()` only)
- Don't make `mc list` / `mc auth status` print to stdout in a way
  that breaks `--json` consumers
- Don't guess on design with 2+ reasonable options — ask the
  coordinator (see the skill)
- Don't add `--non-interactive` flags to commands that are already
  non-interactive by default

## Plan + skill cross-reference

| Plan section | Skill section | Cross-ref |
|---|---|---|
| §2 lifecycle commands | step 4 implement | shipped foundation drev |
| §9 cleanup tooling | pattern 1, 2, 7 | shipped drev 2 |
| §10 orchestration | the whole skill | future runtime |
| §11 onboarding | pattern 5, 8 | shipped drev 2 |
| §12 token vault | pattern 2, 7 | proposed |
| §13 tool-portability | this file | proposed |

## Per-tool surface (what each tool reads natively)

| Tool | Reads | Notes |
|---|---|---|
| Claude Code | `CLAUDE.md` (root) + `.claude/skills/`, `.claude/commands/`, `.claude/hooks/`, `.claude/settings.json` | Full native support today |
| Codex / GPT | `AGENTS.md` (root) | Markdown only; skills and slash commands are read manually |
| Cursor | `.cursor/rules/` (planned, §13) | Not yet generated |
| Aider | `CONVENTIONS.md` (planned, §13) | Not yet generated |

mc plan §13 specifies the adapter-level mechanism that materialises
all of these from this canonical source so tool switches stay
seamless.
