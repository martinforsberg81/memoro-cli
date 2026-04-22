/**
 * Claude Code adapter.
 *
 * - Managed section lives in `~/.claude/CLAUDE.md`
 * - SessionStart / SessionEnd hooks live in `~/.claude/settings.json`
 *
 * This is the reference adapter — other adapters (Cursor, Codex, Windsurf,
 * Gemini CLI) will implement the same shape with different paths +
 * config formats.
 */

import { readFile, writeFile, mkdir, chmod } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';
import { upsertManagedBlock, removeManagedBlock } from '../lib/managed-block.js';

const CLAUDE_DIR = join(homedir(), '.claude');
const CLAUDE_MD = join(CLAUDE_DIR, 'CLAUDE.md');
const SETTINGS_JSON = join(CLAUDE_DIR, 'settings.json');

export const ID = 'claude-code';
export const LABEL = 'Claude Code';
export const CONFIG_PATH = CLAUDE_MD;

/**
 * Write the lens markdown into the user's Claude Code config, replacing
 * any existing managed block.
 */
export async function writeLens(markdown) {
  await ensureDir(CLAUDE_DIR);
  const existing = existsSync(CLAUDE_MD) ? await readFile(CLAUDE_MD, 'utf8') : '';
  const next = upsertManagedBlock(existing, markdown);
  await writeFile(CLAUDE_MD, next);
  return CLAUDE_MD;
}

/**
 * Remove the managed block (undoes writeLens). Leaves any hand-edited
 * content in CLAUDE.md untouched.
 */
export async function removeLens() {
  if (!existsSync(CLAUDE_MD)) return;
  const existing = await readFile(CLAUDE_MD, 'utf8');
  const next = removeManagedBlock(existing);
  await writeFile(CLAUDE_MD, next);
}

/**
 * Install SessionStart + SessionEnd hooks into ~/.claude/settings.json.
 *
 * Hook format (per Claude Code docs):
 *   "hooks": {
 *     "SessionStart": [ { "hooks": [{ "type": "command", "command": "..." }] } ],
 *     "SessionEnd":   [ { "hooks": [{ "type": "command", "command": "..." }] } ]
 *   }
 *
 * We wrap our commands so repeated installs are idempotent — existing
 * memoro-cli hooks are replaced, not duplicated.
 */
export async function installHooks({ memoroCliBin = 'memoro-cli' } = {}) {
  await ensureDir(CLAUDE_DIR);
  const settings = await readSettings();

  settings.hooks = settings.hooks || {};
  settings.hooks.SessionStart = dedupeHooks(settings.hooks.SessionStart, MEMORO_HOOK_ID);
  settings.hooks.SessionEnd   = dedupeHooks(settings.hooks.SessionEnd,   MEMORO_HOOK_ID);

  settings.hooks.SessionStart.push({
    _memoro: MEMORO_HOOK_ID,
    hooks: [
      { type: 'command', command: `${memoroCliBin} lens pull --tool ${ID}` },
    ],
  });
  settings.hooks.SessionEnd.push({
    _memoro: MEMORO_HOOK_ID,
    hooks: [
      // Claude Code pipes the hook event as JSON on stdin; session upload
      // extracts transcript_path from it when no positional arg is given.
      { type: 'command', command: `${memoroCliBin} session upload --tool ${ID} --yes` },
    ],
  });

  await writeSettings(settings);
  return SETTINGS_JSON;
}

export async function uninstallHooks() {
  if (!existsSync(SETTINGS_JSON)) return null;
  const settings = await readSettings();
  if (!settings.hooks) return SETTINGS_JSON;

  settings.hooks.SessionStart = dedupeHooks(settings.hooks.SessionStart, MEMORO_HOOK_ID);
  settings.hooks.SessionEnd   = dedupeHooks(settings.hooks.SessionEnd,   MEMORO_HOOK_ID);
  if (settings.hooks.SessionStart?.length === 0) delete settings.hooks.SessionStart;
  if (settings.hooks.SessionEnd?.length === 0)   delete settings.hooks.SessionEnd;
  if (Object.keys(settings.hooks).length === 0)  delete settings.hooks;

  await writeSettings(settings);
  return SETTINGS_JSON;
}

/**
 * Detect whether Claude Code is installed / used on this machine. Good
 * signal: ~/.claude exists or CLAUDE.md exists at the usual path.
 */
export function detect() {
  return existsSync(CLAUDE_DIR);
}

// ─────────────────────────────────────────────────────────────
// Internal
// ─────────────────────────────────────────────────────────────

const MEMORO_HOOK_ID = 'memoro-cli';

async function readSettings() {
  if (!existsSync(SETTINGS_JSON)) return {};
  try {
    const raw = await readFile(SETTINGS_JSON, 'utf8');
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

async function writeSettings(settings) {
  await ensureDir(CLAUDE_DIR);
  await writeFile(SETTINGS_JSON, JSON.stringify(settings, null, 2), { mode: 0o600 });
  try { await chmod(SETTINGS_JSON, 0o600); } catch { /* best effort */ }
}

async function ensureDir(d) {
  if (!existsSync(d)) await mkdir(d, { recursive: true, mode: 0o700 });
}

function dedupeHooks(list, id) {
  if (!Array.isArray(list)) return [];
  return list.filter(h => h?._memoro !== id);
}
