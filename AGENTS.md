# AGENTS.md

Project instructions for Codex CLI, GPT-based coding agents, and any
other tool that follows the [agents.md](https://agents.md) convention.

The full, tool-agnostic content lives at
[`docs/coding-agent-protocol.md`](docs/coding-agent-protocol.md) —
**read that first**.

## Codex / GPT-specific surface

Codex and similar markdown-instruction-only tools don't have native
skill or slash-command machinery, so the project's coordinator
protocol is invoked manually:

- **To prime this session as coordinator**, prompt:

  > Read `.claude/skills/agent-coordination.md` and
  > `.claude/commands/be-coordinator.md`, then follow the priming
  > instructions in be-coordinator to enter coordinator mode.

  The files live under `.claude/` for historical reasons (Claude
  Code auto-discovers them there), but they're plain markdown —
  Codex reads them just as well as Claude does.

- **Skill content** at `.claude/skills/agent-coordination.md`
  documents the coordinator ↔ agent loop (7 steps), why it
  mitigates LLM failure modes, the 8 engineering patterns + 3
  meta-patterns established across drev 1–2, and observed
  anti-patterns. It's tool-agnostic; only the *invocation* is
  Claude-specific.

- **Hooks:** Codex hook conventions differ from Claude Code's.
  Project-level hooks today are Claude-only (under
  `.claude/hooks/`). mc plan §13 specifies adapter-level
  generation that materialises Codex-native hook files from a
  canonical source — not yet implemented.

For everything else (stack, commands, conventions, critical paths,
what-not-to-do, plan cross-reference), see
[`docs/coding-agent-protocol.md`](docs/coding-agent-protocol.md).
