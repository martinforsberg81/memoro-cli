/**
 * The conversations belonging to a piece of work.
 *
 * mc does not store them. It cannot: a stored id is a copy, and every failure
 * this project has had was a copy disagreeing with the thing it copied. The
 * previous attempt guessed the id by taking the newest transcript modified
 * after launch — which is wrong whenever a second tool is running elsewhere,
 * because `codex resume` appends to the original file and bumps its mtime. One
 * piece of work would quietly adopt another's conversation.
 *
 * There is no need to guess. Both tools index their own conversations by the
 * working directory, and the working directory is the one thing mc genuinely
 * owns — it created it. So the question "which conversations belong to this
 * work?" is asked of the tools, in their own storage, at the moment of asking:
 *
 *   codex   a `threads` table with a `cwd` column (1393 rows, none of them null)
 *   claude  a directory per launch cwd, holding one file per conversation
 *
 * Matching is on the work area's root, not on a particular worktree, because a
 * conversation keeps the directory it was launched in even after it moves. One
 * live transcript here was launched in `…/critical-chat-error/memoro-cli`,
 * visited the home directory, and settled in `…/critical-chat-error/memoro` —
 * one file, still under the first name. Matching the current worktree would
 * have missed it, and `discard` would have left it behind.
 *
 * The same lookup answers all three questions — what exists, what to resume,
 * and what to delete — so they cannot disagree with each other.
 */
import { execFileSync } from 'node:child_process';
import { openSync, readSync, closeSync, readdirSync, rmSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

import { log } from './logger.js';

const HEAD_BYTES = 65536;

export function codexHome(env = process.env) {
  return env.CODEX_HOME || join(homedir(), '.codex');
}

export function claudeHome(env = process.env) {
  return env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude');
}

/**
 * Every conversation launched anywhere inside this piece of work, newest first.
 */
export function listConversations(areaRoot, env = process.env) {
  if (!areaRoot) return [];
  const found = [...codexConversations(areaRoot, env), ...claudeConversations(areaRoot, env)];
  return found.sort((a, b) => (b.updated_ms || 0) - (a.updated_ms || 0));
}

function within(root, cwd) {
  return typeof cwd === 'string' && (cwd === root || cwd.startsWith(`${root}/`));
}

/**
 * Codex keeps its index in `state_<n>.sqlite`. The number goes up when Codex
 * migrates, so the highest one is the live one rather than a name mc pins.
 */
function codexStateDb(env) {
  const home = codexHome(env);
  let names = [];
  try { names = readdirSync(home); } catch { return null; }
  const versioned = names
    .map((name) => /^state_(\d+)\.sqlite$/u.exec(name))
    .filter(Boolean)
    .sort((a, b) => Number(b[1]) - Number(a[1]));
  return versioned.length ? join(home, versioned[0][0]) : null;
}

function codexConversations(areaRoot, env) {
  const db = codexStateDb(env);
  if (db) {
    // Read-only, and narrowed in SQL. Selecting every row first was 35 MB —
    // Codex stores a title up to 113 kB long — and blew the pipe buffer, so mc
    // silently fell back to the slow path on every single call. The `LIKE`
    // needs no escaping beyond the quote: a work-area name is already
    // constrained to letters, digits, dot, dash and underscore, and `_`
    // matching one extra character can only widen the set that `within()` then
    // narrows exactly.
    const quoted = `${areaRoot.replace(/'/gu, "''")}`;
    try {
      const out = execFileSync('sqlite3', [
        '-readonly', '-json', db,
        'select id, cwd, substr(title, 1, 120) as title, rollout_path,'
        + ' coalesce(updated_at_ms, updated_at * 1000) as updated_ms from threads'
        + ` where cwd = '${quoted}' or cwd like '${quoted}/%'`,
      ], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 8 * 1024 * 1024 });
      const rows = JSON.parse(out || '[]');
      return rows.filter((row) => within(areaRoot, row.cwd)).map((row) => ({
        tool: 'codex',
        id: row.id,
        cwd: row.cwd,
        title: row.title || null,
        path: row.rollout_path || null,
        updated_ms: Number(row.updated_ms) || 0,
        bytes: sizeOf(row.rollout_path),
      }));
    } catch (error) {
      log('conversations.codex-index-unreadable', { db, error: String(error?.message || error) });
    }
  }
  return codexRollouts(areaRoot, env);
}

/**
 * If the index cannot be read — a missing `sqlite3`, or a shape Codex has
 * changed again — the rollout files still carry their own cwd. Slower, and it
 * is the answer rather than a refusal.
 */
function codexRollouts(areaRoot, env) {
  const found = [];
  const walk = (directory, depth = 0) => {
    if (depth > 5) return;
    let entries = [];
    try { entries = readdirSync(directory, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) { walk(path, depth + 1); continue; }
      const match = /-([0-9a-f-]{36})\.jsonl$/u.exec(entry.name);
      if (!match) continue;
      const cwd = firstCwd(path);
      if (!within(areaRoot, cwd)) continue;
      found.push({
        tool: 'codex',
        id: match[1],
        cwd,
        title: null,
        path,
        updated_ms: mtimeOf(path),
        bytes: sizeOf(path),
      });
    }
  };
  walk(join(codexHome(env), 'sessions'));
  return found;
}

/**
 * Claude names the directory after the cwd it was launched in, with `/` and `.`
 * both flattened to `-`. That makes the encoding ambiguous going backwards — a
 * work area called `foo` shares a prefix with `foo-bar` — so the name is only
 * used to decide which directories are worth opening. The cwd recorded inside
 * the transcript decides what actually belongs.
 */
function claudeConversations(areaRoot, env) {
  const root = join(claudeHome(env), 'projects');
  const prefix = encodePath(areaRoot);
  let dirs = [];
  try {
    dirs = readdirSync(root, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && entry.name.startsWith(prefix))
      .map((entry) => entry.name);
  } catch { return []; }
  const found = [];
  for (const dir of dirs) {
    let files = [];
    try { files = readdirSync(join(root, dir)).filter((name) => name.endsWith('.jsonl')); } catch { continue; }
    for (const file of files) {
      const path = join(root, dir, file);
      const cwd = firstCwd(path);
      if (!within(areaRoot, cwd)) continue;
      found.push({
        tool: 'claude-code',
        id: file.replace(/\.jsonl$/u, ''),
        cwd,
        title: null,
        path,
        updated_ms: mtimeOf(path),
        bytes: sizeOf(path),
      });
    }
  }
  return found;
}

function encodePath(path) {
  return path.replace(/[/.]/gu, '-');
}

/** The first cwd a transcript records — read from its head, not the whole file. */
function firstCwd(path) {
  let fd = null;
  try {
    fd = openSync(path, 'r');
    const buffer = Buffer.alloc(HEAD_BYTES);
    const read = readSync(fd, buffer, 0, HEAD_BYTES, 0);
    const match = /"cwd"\s*:\s*"((?:[^"\\]|\\.)*)"/u.exec(buffer.subarray(0, read).toString('utf8'));
    return match ? JSON.parse(`"${match[1]}"`) : null;
  } catch { return null; } finally {
    if (fd !== null) { try { closeSync(fd); } catch { /* closed */ } }
  }
}

function sizeOf(path) {
  try { return path ? statSync(path).size : 0; } catch { return 0; }
}

function mtimeOf(path) {
  try { return statSync(path).mtimeMs; } catch { return 0; }
}

/**
 * Remove a conversation from the tool that owns it.
 *
 * Codex is asked with its own verb, because it holds an index that a deleted
 * file alone would leave lying. Claude has no such verb and no such index — the
 * transcript is the conversation, so removing the file removes it. Neither of
 * these touches a copy of mc's, because mc never made one.
 */
export function deleteConversation(entry, env = process.env) {
  if (!entry?.id) return { ok: false, reason: 'no-conversation' };
  if (entry.tool === 'codex') {
    try {
      // `--force` is Codex asking whether the user meant it. They already
      // answered that: mc printed what it was about to destroy and the user
      // ran it again with `--apply`. Asking twice from a place the user cannot
      // answer is how the deletion silently failed the first time.
      execFileSync('codex', ['delete', '--force', entry.id], {
        encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env,
      });
    } catch (error) {
      log('conversations.codex-delete-failed', { id: entry.id, error: String(error?.message || error) });
      return { ok: false, reason: 'codex-delete-failed' };
    }
    return { ok: true };
  }
  try {
    if (entry.path) {
      rmSync(entry.path, { force: true });
      // Claude's directory exists only to hold transcripts. An empty one left
      // behind is the same kind of litter the work areas themselves were.
      const directory = dirname(entry.path);
      try {
        if (readdirSync(directory).length === 0) rmSync(directory, { recursive: true, force: true });
      } catch { /* not empty, or already gone */ }
    }
  } catch (error) {
    log('conversations.transcript-delete-failed', { path: entry.path, error: String(error?.message || error) });
    return { ok: false, reason: 'transcript-delete-failed' };
  }
  return { ok: true };
}

export function deleteConversations(entries = [], env = process.env) {
  const removed = [];
  const failed = [];
  for (const entry of entries) {
    const result = deleteConversation(entry, env);
    (result.ok ? removed : failed).push({ ...entry, reason: result.reason });
  }
  return { removed, failed };
}

/** `1.2 MB`, `14 kB`, `empty` — what is actually at stake, in one word. */
export function describeSize(bytes) {
  if (!bytes) return 'empty';
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} kB`;
  return `${bytes} B`;
}

export function describeAge(updatedMs, now = Date.now()) {
  if (!updatedMs) return 'never';
  const minutes = Math.max(0, Math.round((now - updatedMs) / 60000));
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}
