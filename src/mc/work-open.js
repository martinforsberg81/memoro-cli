/**
 * Open a tool inside a work area and remember the conversation.
 *
 * This is the whole of what mc adds to running `codex` by hand: it knows which
 * directory the work lives in, and it remembers which conversation belongs to
 * it. There is no runtime host, no journal, no generation — the tool inherits
 * this terminal and mc waits.
 *
 * Learning the conversation id differs by tool and neither needs a registry:
 * Claude accepts an id mc mints, so mc knows it before launch; Codex mints its
 * own, so mc reads back the rollout it wrote. Both end in the same place —
 * `.mc.json`, next to the worktrees.
 */
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { resolveLaunch } from '../adapters/index.js';
import { readToolSession, writeToolSession } from './work-area.js';

export function openInWorkArea({
  name,
  session = 'main',
  worktree,
  tool = null,
  env = process.env,
  spawn = spawnSync,
} = {}) {
  // A named session remembers its own tool, so reopening it needs no flag.
  // Naming a different tool for an existing session starts a new conversation
  // under that name rather than pretending the old one can continue.
  const existing = readToolSession(name, session, env);
  const launch = resolveLaunch(tool || existing?.tool || 'codex');
  if (!launch?.ok) return { ok: false, reason: launch?.reason || 'tool-unavailable', hint: launch?.hint };
  const toolId = launch.id;
  const known = existing && existing.tool === toolId && typeof existing.conversation === 'string'
    ? existing.conversation
    : null;

  // A remembered id is only worth resuming if the tool actually wrote that
  // conversation. mc records the id before launch so a kill cannot lose it,
  // which means it can also record one for a conversation that never began —
  // and resuming that made the tool refuse. Asking the disk costs nothing and
  // turns a refusal into a fresh start.
  const resumable = known ? conversationExists(toolId, known, env) : false;

  let handle = resumable ? known : null;
  let args;
  if (resumable && typeof launch.adapter?.resumeArgs === 'function') {
    args = launch.adapter.resumeArgs({ sessionId: known });
  } else if (typeof launch.adapter?.newSessionArgs === 'function') {
    handle = randomUUID();
    args = launch.adapter.newSessionArgs({ sessionId: handle });
  } else {
    handle = null;
    args = [];
  }
  if (!Array.isArray(args)) return { ok: false, reason: 'tool-arguments-unavailable' };

  // An id mc minted is known before the tool starts, so it is written before
  // the tool starts. Waiting until exit meant a closed terminal or a kill lost
  // the conversation entirely — the one fact mc exists to keep.
  if (handle && handle !== known) writeToolSession(name, session, { tool: toolId, conversation: handle }, env);

  const startedAt = Date.now();
  const result = spawn(launch.spec.bin, args, { cwd: worktree.path, stdio: 'inherit', env });
  if (result?.error) return { ok: false, reason: result.error.message };

  // Codex names its own conversation, so the id is read from what it wrote.
  const learned = handle || discoverCodexConversation(startedAt, env);
  if (learned && learned !== known) {
    writeToolSession(name, session, { tool: toolId, conversation: learned }, env);
  }

  return {
    ok: true,
    session,
    tool: toolId,
    conversation: learned || null,
    resumed: resumable,
    code: result?.status ?? 0,
  };
}

/** Does the tool actually hold this conversation? Ask its own home. */
function conversationExists(toolId, id, env) {
  const roots = toolId === 'claude-code'
    ? [join(env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude'), 'projects')]
    : [join(env.CODEX_HOME || join(homedir(), '.codex'), 'sessions')];
  const wanted = new RegExp(`${id.replace(/[^A-Za-z0-9-]/gu, '')}\\.jsonl$`, 'u');
  const walk = (directory, depth = 0) => {
    if (depth > 6) return false;
    let entries = [];
    try { entries = readdirSync(directory, { withFileTypes: true }); } catch { return false; }
    for (const entry of entries) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) { if (walk(path, depth + 1)) return true; continue; }
      if (wanted.test(entry.name)) return true;
    }
    return false;
  };
  return roots.some((root) => walk(root));
}

function discoverCodexConversation(startedAt, env) {
  const root = join(env.CODEX_HOME || join(homedir(), '.codex'), 'sessions');
  let newest = null;
  const walk = (directory, depth = 0) => {
    if (depth > 6) return;
    let entries = [];
    try { entries = readdirSync(directory, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) { walk(path, depth + 1); continue; }
      const match = /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/u
        .exec(entry.name);
      if (!match) continue;
      let modified = 0;
      try { modified = statSync(path).mtimeMs; } catch { continue; }
      if (modified < startedAt) continue;
      if (!newest || modified > newest.modified) newest = { id: match[1], modified };
    }
  };
  walk(root);
  return newest?.id || null;
}
