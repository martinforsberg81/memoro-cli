/**
 * Coordinator slash command bootstrap.
 *
 * Drops `memoro-coordinator.md` into ~/.claude/commands/ on first `mc` run
 * if not already there. The file becomes Claude Code's `/memoro-coordinator`
 * slash command — the entry point to the coordinator role.
 *
 * Carries the same `<!-- memoro:managed:command -->` marker the existing
 * adapter uses, so `memoro-cli hook uninstall` will clean it up cleanly.
 */

import { writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

const COMMANDS_DIR = () => join(homedir(), '.claude', 'commands');
const COMMAND_FILE = () => join(COMMANDS_DIR(), 'memoro-coordinator.md');

const COMMAND_MARKER = '<!-- memoro:managed:command -->';

const COMMAND_BODY = `---
description: Manage your other Claude Code sessions from here
---

${COMMAND_MARKER}

! mc sessions list

You are now in **coordinator mode**. The user runs many parallel
Claude Code sessions across repos and machines. Your job is to give them
an overview and let them route attention across sessions from a single
terminal.

The list above is the current snapshot of their active coding sessions.
Each row is:

    [coding_session_id]  repo  branch  machine  last-seen-relative
        preview excerpt

You have three commands available via the shell (\`!\` prefix):

  - \`! mc sessions list\`               — refresh the active list
  - \`! mc sessions read <id>\`          — fetch the recent transcript of a
                                          peer session and inspect it
  - \`! mc sessions send <id> "<msg>"\`  — dispatch a message into a peer
                                          session; it lands as if the user
                                          typed it there, and that session's
                                          Claude takes a real turn

Behaviour:

- When the user asks what is happening, summarise each session in one
  short line — current focus, recency, anything noteworthy.
- When the user asks you to dispatch, briefly restate the message and
  target session, then send.
- When the user asks you to inspect a session, run \`mc sessions read\`
  and summarise rather than dumping the whole transcript.
- For destructive or scope-changing dispatches (commit-and-switch,
  branch changes, deletions), confirm with the user before sending.

Be concise. You are the user's project lead across their parallel work.
`;

export async function ensureCoordinatorSlashCommand() {
  try {
    if (!existsSync(COMMANDS_DIR())) {
      await mkdir(COMMANDS_DIR(), { recursive: true, mode: 0o700 });
    }
    if (existsSync(COMMAND_FILE())) return false;  // already installed
    await writeFile(COMMAND_FILE(), COMMAND_BODY, { mode: 0o644 });
    return true;
  } catch {
    return false;  // best-effort; mc still works without the slash command
  }
}

// Exported for tests.
export const __test__ = { COMMAND_BODY, COMMAND_MARKER };
