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
        'select id, cwd, substr(first_user_message, 1, 400) as opened, rollout_path,'
        + ' coalesce(updated_at_ms, updated_at * 1000) as updated_ms from threads'
        + ` where cwd = '${quoted}' or cwd like '${quoted}/%'`,
      ], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 8 * 1024 * 1024 });
      const rows = JSON.parse(out || '[]');
      return rows.filter((row) => within(areaRoot, row.cwd)).map((row) => ({
        tool: 'codex',
        id: row.id,
        cwd: row.cwd,
        // The index holds the first message, which is usually what the user
        // typed and sometimes what a tool put in front of it. When it is the
        // latter the transcript is read for one that is not.
        label: label(row.opened) || readHead(row.rollout_path).label,
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
      const head = readHead(path);
      if (!within(areaRoot, head.cwd)) continue;
      found.push({
        tool: 'codex',
        id: match[1],
        cwd: head.cwd,
        label: head.label,
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
      const head = readHead(path);
      if (!within(areaRoot, head.cwd)) continue;
      found.push({
        tool: 'claude-code',
        id: file.replace(/\.jsonl$/u, ''),
        cwd: head.cwd,
        label: head.label,
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

/**
 * The two facts that identify a conversation, taken from the head of its own
 * transcript: where it was launched, and how it opened.
 *
 * Both tools write JSON per line, and both put the working directory and the
 * first turn near the top, so this reads a bounded head rather than a file
 * that can be megabytes. Two shapes, one pass — Claude records `cwd` at the
 * top level and turns as `{"type":"user"}`; Codex records both inside a
 * `payload`.
 */
function readHead(path) {
  if (!path) return { cwd: null, label: null };
  let fd = null;
  let text = '';
  try {
    fd = openSync(path, 'r');
    const buffer = Buffer.alloc(HEAD_BYTES);
    const read = readSync(fd, buffer, 0, HEAD_BYTES, 0);
    text = buffer.subarray(0, read).toString('utf8');
  } catch { return { cwd: null, label: null }; } finally {
    if (fd !== null) { try { closeSync(fd); } catch { /* closed */ } }
  }

  let cwd = null;
  let opening = null;
  for (const line of text.split('\n')) {
    if (cwd && opening) break;
    if (!line.startsWith('{')) continue;
    let entry = null;
    try { entry = JSON.parse(line); } catch { continue; }
    const payload = entry.payload || entry;
    if (!cwd && typeof payload.cwd === 'string') cwd = payload.cwd;
    if (!cwd && typeof entry.cwd === 'string') cwd = entry.cwd;
    if (opening) continue;
    const isUser = entry.type === 'user' || payload.role === 'user';
    if (!isUser) continue;
    opening = label(textOf(entry.message?.content ?? payload.content));
  }
  return { cwd, label: opening };
}

function textOf(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .filter((part) => part && typeof part === 'object' && typeof part.text === 'string')
    .map((part) => part.text)
    .join(' ');
}

const TAIL_BYTES = 256 * 1024;
const WIDE_TAIL_BYTES = 4 * 1024 * 1024;

/**
 * The model a conversation last ran on, from the tail of its own transcript.
 *
 * Both tools record it as they go — Claude on every assistant turn
 * (`message.model`), Codex in each `turn_context` — so "which model is this
 * conversation on?" is asked of the transcript, never remembered by mc, for
 * the same reason the conversations themselves are not: a stored copy can
 * disagree with the thing it copied. Resuming hands the answer back to the
 * tool, which is what makes the model a property of the conversation rather
 * than of whoever happens to restart it.
 *
 * One huge entry — a pasted file, a giant tool result — can push every
 * model-naming line out of the near tail, and a resume that silently fell
 * back to the tool's default would be the exact drift this exists to prevent.
 * So a miss looks again, wider, before giving up. Once, bounded: reading
 * whole transcripts on every open is what the near tail is there to avoid.
 */
export function conversationModel(item) {
  if (!item?.path) return null;
  const near = lastModel(item.tool, readTailEntries(item.path));
  if (near || sizeOf(item.path) <= TAIL_BYTES) return near;
  return lastModel(item.tool, readTailEntries(item.path, WIDE_TAIL_BYTES));
}

/**
 * How full a Claude conversation's context is, read from its transcript.
 *
 * Nobody sees a session's context fill but the session itself: PM found
 * msr-track-1 at 99 % by looking into its pane mid-repair, which is luck,
 * not a mechanism (2026-08-24). The pane prints "NN% context used", but a
 * pane is the one thing a session run outside tmux does not have — and
 * the transcript carries the same number for every session, pane or not:
 * each assistant message records `usage`, and the context in play is the
 * whole input side of the latest one (fresh + cache written + cache read).
 *
 * The window is not in the transcript, so it is assumed from the model —
 * calibrated once, measured: msr-track-1's pane said 100 % at 977 k
 * tokens on claude-opus-5, so the 5-family is a 1M window; haiku 4.5 and
 * anything unknown are taken as 200k. The answer says `window_assumed` so
 * nobody reads the percentage as more than it is.
 */
export const CONTEXT_LEVELS = Object.freeze({
  /** Shown on the board from here: the rule is regular compaction, and this is when it is worth a glance. */
  show: 70,
  /** The guard knocks PM from here: the next turns are the ones that stall. */
  knock: 90,
});

export function contextWindowFor(model) {
  const name = String(model || '').toLowerCase();
  if (/-5(?:-|$)/u.test(name) && !name.includes('haiku')) return 1_000_000;
  return 200_000;
}

export function contextUsage(tool, entries) {
  if (tool === 'codex') return null;
  for (let i = entries.length - 1; i >= 0; i -= 1) {
    const entry = entries[i];
    if (entry.type !== 'assistant') continue;
    const usage = entry.message?.usage;
    if (!usage || typeof usage !== 'object') continue;
    const used = (Number(usage.input_tokens) || 0)
      + (Number(usage.cache_creation_input_tokens) || 0)
      + (Number(usage.cache_read_input_tokens) || 0);
    if (!used) continue;
    const model = typeof entry.message?.model === 'string' ? entry.message.model : null;
    const window = contextWindowFor(model);
    return { used, window, percent: Math.round((used / window) * 100), model, window_assumed: true };
  }
  return null;
}

/** The same question, asked of transcript entries someone already read. */
export function lastModel(tool, entries) {
  for (let i = entries.length - 1; i >= 0; i -= 1) {
    const entry = entries[i];
    const model = tool === 'codex'
      ? (entry.type === 'turn_context' ? entry.payload?.model : null)
      : (entry.type === 'assistant' ? entry.message?.model : null);
    // Claude stamps `<synthetic>` on messages the model never produced.
    if (typeof model === 'string' && model && !model.startsWith('<')) return model;
  }
  return null;
}

/**
 * The end of a transcript, read from the end and parsed. Bounded like
 * `readHead` because a conversation can be megabytes and callers ask this for
 * every one of them; the first line is dropped when the seek lands mid-line,
 * which it almost always does, and a truncated final write is skipped rather
 * than fatal. Shared with the status board so the two can never disagree
 * about what the tail of a transcript says.
 */
export function readTailEntries(path, bytes = TAIL_BYTES) {
  if (!path) return [];
  let fd = null;
  try {
    const size = statSync(path).size;
    const from = Math.max(0, size - bytes);
    fd = openSync(path, 'r');
    const buffer = Buffer.alloc(Math.min(bytes, size));
    const read = readSync(fd, buffer, 0, buffer.length, from);
    const lines = buffer.subarray(0, read).toString('utf8').split('\n');
    if (from > 0) lines.shift();
    const entries = [];
    for (const line of lines) {
      if (!line.startsWith('{')) continue;
      try { entries.push(JSON.parse(line)); } catch { /* truncated write */ }
    }
    return entries;
  } catch { return []; } finally {
    if (fd !== null) { try { closeSync(fd); } catch { /* closed */ } }
  }
}

/**
 * What the user actually said, if they said it.
 *
 * The first message in a transcript is not always the user's: tools put
 * repository instructions, session grounding and compaction summaries in front
 * of it, and a review thread has no user turn at all. Of 1393 conversations on
 * this machine, 1010 open with something a tool wrote — nearly all of them
 * machinery from mc's own past. Naming a conversation after that would be
 * worse than leaving it unnamed, so this returns nothing rather than
 * something, and the caller looks further or shows the id alone.
 */
const NOT_THE_USER = [
  /^the following is the codex agent history/iu,
  /^#\s*session grounding/iu,
  /^#\s*agents\.md instructions/iu,
  /^caveat: the messages below were generated/iu,
  /^this session is being continued from/iu,
  /^</u,
];

function label(raw) {
  if (typeof raw !== 'string') return null;
  const text = raw.replace(/\s+/gu, ' ').trim();
  if (!text) return null;
  if (NOT_THE_USER.some((pattern) => pattern.test(text))) return null;
  return text.length > 64 ? `${text.slice(0, 63)}…` : text;
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
