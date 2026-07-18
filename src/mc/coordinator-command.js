/**
 * Coordinator slash command bootstrap.
 *
 * Drops managed files into ~/.claude/commands/ on first `mc` run. Managed
 * files are refreshed on subsequent runs so updates land automatically; an
 * existing hand-authored file without our marker is left untouched.
 *
 *   memoro-coordinator.md          /memoro-coordinator   — overview + route
 *   memoro-coordinator-suggest.md  /memoro-coordinator-suggest
 *                                                       — analyse + suggest
 *                                                         next step per
 *                                                         session
 * All files carry the same `<!-- memoro:managed:command -->` marker the
 * existing adapter uses, so `memoro-cli hook uninstall` cleans them up.
 */

import { writeFile, mkdir, readFile, unlink } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

const COMMANDS_DIR = () => join(homedir(), '.claude', 'commands');

const COMMAND_MARKER = '<!-- memoro:managed:command -->';

// ─────────────────────────────────────────────────────────────────────────────
// /memoro-coordinator — overview + route attention
// ─────────────────────────────────────────────────────────────────────────────

const COMMAND_BODY = `---
description: Manage your other Claude Code sessions from here
---

${COMMAND_MARKER}

! mc sessions list

You are in **coordinator mode**. The user runs many parallel Claude Code
sessions across repos and machines. Show them what's happening and help
them route attention.

## How to present the snapshot

ALWAYS present active sessions as a **numbered list** (1., 2., 3., …) so
the user can refer to them by number in follow-ups ("send to 3", "read
session 2", etc.).

For each session, give:

\`\`\`
[N]. <label or sess_xxx>  ·  <repo>/<branch>  ·  <status>
     <one-line summary of what it's doing>
\`\`\`

Where:

- **label** appears if set; otherwise the \`sess_xxx\` id
- **status** is one of: ACTIVE (output in last few seconds), \`idle Nm\`
  (no output for N minutes, likely awaiting input), or \`unknown\`
- **one-line summary** is plain English from the excerpt — what the
  session looks like it's working on. If the excerpt shows an obvious
  paused prompt (menu, question, choice), call it out explicitly with
  **"PAUSED — awaiting answer"**. If recently active, paraphrase the
  topic. If idle 5+ minutes with no clear prompt, just note the idle
  time and don't speculate.

Skip your own session in the list (or mark it as "(this session)").

## Tools available (shell, \`!\` prefix)

  - \`! mc sessions list\`                 — refresh the snapshot
  - \`! mc sessions read <label|id>\`      — fetch a peer's recent transcript
  - \`! mc sessions send <label|id> "msg"\`— dispatch a message into a peer;
                                            lands as a real user turn there

## Behaviour

- After listing, ask: **"What would you like to do?"**
- When the user names a session by number, label, or id, resolve it
  before acting. Confirm targets before dispatch.
- For destructive or scope-changing dispatches (commit-and-switch,
  branch changes, deletions), restate the message + target and ask for
  confirmation.
- Use \`mc sessions read\` and *summarise*; don't paste full transcripts
  back unless asked.
- If the user wants per-session **suggestions for next step**, recommend
  they run \`/memoro-coordinator-suggest\` — that command is built for it.
- If the user wants to change their durable coding-agent work method, recommend
  \`mc coding-profile read\`, then \`mc coding-profile diff\`, then
  \`mc coding-profile write\`.

You are the user's project lead across their parallel work. Be concise
and decisive.
`;

// ─────────────────────────────────────────────────────────────────────────────
// /memoro-coordinator-suggest — analyse + suggest next step per session
// ─────────────────────────────────────────────────────────────────────────────

const COMMAND_BODY_SUGGEST = `---
description: Suggest a concrete next step for every active session
---

${COMMAND_MARKER}

! mc sessions list

You are in **coordinator-suggest mode**. For every active coding session
the user has, analyse what it's doing and recommend a concrete next
step. The user wants a triage view: "where should I spend the next 30
minutes?"

## Procedure

1. The output above is the current snapshot. Note the session
   identifiers (labels where set, else \`sess_xxx\`).
2. For **each** session, run \`! mc sessions read <label|id>\` to fetch
   its recent transcript. Pull only what you need to characterise it.
3. Synthesise one entry per session in a numbered list:

\`\`\`
[N]. <label or sess_xxx>  ·  <repo>/<branch>  ·  <status>
     **Doing:** <one-line characterisation of the work>
     **Next:**  <concrete recommended action — what should happen there?>
\`\`\`

## Guidance

- **Paused sessions** (PAUSED — awaiting answer): if the user can clearly
  answer from context, recommend the dispatch verbatim:
  \`mc sessions send <id> "1"\` (etc.). If the answer needs human
  judgement, say so.
- **Active sessions**: brief summary of current focus; "next" is usually
  "let it finish" or "verify when it lands".
- **Idle but not paused**: suggest whether to resume, drop, or wait.
- Skip your own session.
- After the list, give a one-sentence **prioritisation**: which two
  sessions should the user attend to first, and why.
- **Do not dispatch anything.** Recommend; the user decides.

Be concise. The user has many sessions and limited attention.
`;

// ─────────────────────────────────────────────────────────────────────────────
// Installer
// ─────────────────────────────────────────────────────────────────────────────

async function ensureFile(name, body) {
  const dir = COMMANDS_DIR();
  const path = join(dir, name);
  try {
    if (!existsSync(dir)) {
      await mkdir(dir, { recursive: true, mode: 0o700 });
    }
    // Overwrite only managed files. This is especially important for mc.md:
    // `/mc` is generic enough that a user may already own it.
    if (existsSync(path)) {
      try {
        const existing = await readFile(path, 'utf8');
        if (existing === body) return false;
        if (!existing.includes(COMMAND_MARKER)) return false;
      } catch { /* fall through and overwrite */ }
    }
    await writeFile(path, body, { mode: 0o644 });
    return true;
  } catch {
    return false;
  }
}

async function removeManagedFile(name) {
  const path = join(COMMANDS_DIR(), name);
  try {
    if (!existsSync(path)) return false;
    const existing = await readFile(path, 'utf8');
    if (!existing.includes(COMMAND_MARKER)) return false;
    await unlink(path);
    return true;
  } catch {
    return false;
  }
}

export async function ensureCoordinatorSlashCommand() {
  await ensureFile('memoro-coordinator.md', COMMAND_BODY);
  await ensureFile('memoro-coordinator-suggest.md', COMMAND_BODY_SUGGEST);
  await removeManagedFile('mc.md');
  await removeManagedFile('memoro-map.md');
}

// Exported for tests.
export const __test__ = {
  COMMAND_BODY,
  COMMAND_BODY_SUGGEST,
  COMMAND_MARKER,
};
