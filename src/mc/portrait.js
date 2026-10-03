/**
 * A body of instructions, handed to a tool as a new conversation begins.
 *
 * What is handed over is a role's instructions, assembled by
 * `instructionsFor` in `roles.js`. It used to be the user's Coding Profile as
 * well, fetched from Memoro and joined in front; ruling 24 removed that, and
 * what is left here is only the channel.
 *
 * mc has been wrong about the "where" three times, each time by writing to a
 * file it did not own — the repository's `CLAUDE.md` and `AGENTS.md`, a
 * startup message, then the tools' own `~/.claude/CLAUDE.md` and
 * `~/.codex/AGENTS.md`. There is a channel that needs no file at all. Both
 * tools take instructions as a launch argument:
 *
 *   claude  --append-system-prompt <markdown>
 *   codex   -c instructions=<markdown>
 *
 * Verified rather than assumed: `codex exec -c instructions="…begin every
 * reply with QX7"` answered `QX7 Hej på dig.`, and a second run with a shell
 * task still listed the directory, so the base instructions are layered
 * rather than replaced.
 *
 * Only a new conversation gets it. A resumed one already has it in its own
 * history, and handing it over again would say the same thing twice.
 */

/**
 * How each tool takes it. A tool mc has no channel for simply gets nothing —
 * silently, because its absence is not a fault the user can act on at the
 * moment they are trying to start work.
 */
export function profileArgs(toolId, markdown) {
  if (!markdown) return [];
  if (toolId === 'claude-code') return ['--append-system-prompt', markdown];
  if (toolId === 'codex') return ['-c', `instructions=${JSON.stringify(markdown)}`];
  return [];
}
