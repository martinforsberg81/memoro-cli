# CLAUDE.md

Project instructions for Claude Code. The full, tool-agnostic
content lives at [`docs/coding-agent-protocol.md`](docs/coding-agent-protocol.md)
— **read that first**.

## Claude-Code-specific surface

Native Claude Code integrations alongside the canonical instructions:

- **Slash command:** `/be-coordinator` primes a fresh session as
  coordinator (reads the protocol, runs a state probe, announces
  ready). Defined at `.claude/commands/be-coordinator.md`.
- **Skills:** `.claude/skills/agent-coordination.md` is the
  coordinator ↔ agent protocol. Auto-discovered by Claude Code's
  skill mechanism; loadable via the Skill tool when relevant.
- **Hooks:** Project hooks live under `.claude/hooks/` (none
  currently in memoro-cli; memoro has them — see its CLAUDE.md).
- **Settings:** `.claude/settings.json` is the project-scoped Claude
  Code config (currently absent in memoro-cli; add when needed).

For everything else (stack, commands, conventions, critical paths,
what-not-to-do, plan cross-reference), see
[`docs/coding-agent-protocol.md`](docs/coding-agent-protocol.md).
