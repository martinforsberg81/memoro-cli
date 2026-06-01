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

import { readFile, writeFile, mkdir, chmod, readdir, unlink } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';
import { upsertManagedBlock, removeManagedBlock } from '../lib/managed-block.js';
import { getPackageVersion } from '../lib/version.js';
import { writeProtectedFile, shredFile } from './_materialise.js';

// Paths are resolved lazily via homedir() so tests (and any future env
// override) can redirect HOME without having to bust the module cache.
const claudeDir = () => join(homedir(), '.claude');
const claudeMd = () => join(claudeDir(), 'CLAUDE.md');
const settingsJson = () => join(claudeDir(), 'settings.json');
const commandsDir = () => join(claudeDir(), 'commands');

const COMMAND_PREFIX = 'memoro-';

export const ID = 'claude-code';
export const LABEL = 'Claude Code';
// Kept for back-compat with callers that read the path before any operation.
// Prefer reading the return value of writeLens / installHooks for the
// effective path after a call.
export const CONFIG_PATH = claudeMd();

/**
 * Write the lens markdown into the user's Claude Code config, replacing
 * any existing managed block.
 */
export async function writeLens(markdown) {
  await ensureDir(claudeDir());
  const existing = existsSync(claudeMd()) ? await readFile(claudeMd(), 'utf8') : '';
  const next = upsertManagedBlock(existing, markdown);
  await writeFile(claudeMd(), next);
  return claudeMd();
}

/**
 * Remove the managed block (undoes writeLens). Leaves any hand-edited
 * content in CLAUDE.md untouched.
 */
export async function removeLens() {
  if (!existsSync(claudeMd())) return;
  const existing = await readFile(claudeMd(), 'utf8');
  const next = removeManagedBlock(existing);
  await writeFile(claudeMd(), next);
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
  await ensureDir(claudeDir());
  const settings = await readSettings();
  // Stamp the installing version on each managed block so we can detect when
  // the binary has been updated but the hooks haven't been re-installed.
  const version = await getPackageVersion();

  settings.hooks = settings.hooks || {};
  settings.hooks.SessionStart = dedupeHooks(settings.hooks.SessionStart, MEMORO_HOOK_ID);
  settings.hooks.SessionEnd   = dedupeHooks(settings.hooks.SessionEnd,   MEMORO_HOOK_ID);

  settings.hooks.SessionStart.push({
    _memoro: MEMORO_HOOK_ID,
    _memoro_version: version,
    hooks: [
      { type: 'command', command: `${memoroCliBin} lens pull --tool ${ID}` },
      // Spawn the heartbeat daemon detached — Claude Code reaps its hook
      // process tree on exit, so the daemon needs to survive that.
      { type: 'command', command: `${memoroCliBin} heartbeat-loop --tool ${ID} --background` },
    ],
  });
  settings.hooks.SessionEnd.push({
    _memoro: MEMORO_HOOK_ID,
    _memoro_version: version,
    hooks: [
      // Stop the heartbeat daemon first (reads session_id from stdin),
      // then upload the session. Both consume the same stdin payload, but
      // SessionEnd hooks run sequentially and each receives a fresh stdin
      // copy from Claude Code.
      { type: 'command', command: `${memoroCliBin} heartbeat-stop` },
      // Claude Code pipes the hook event as JSON on stdin; session upload
      // extracts transcript_path from it when no positional arg is given.
      // --background detaches the actual upload into a grandchild so the
      // hook returns before Claude reaps its process tree on exit.
      { type: 'command', command: `${memoroCliBin} session upload --tool ${ID} --yes --background` },
    ],
  });

  await writeSettings(settings);
  return settingsJson();
}

/**
 * Read the version stamped on the installed hook entry. Returns null when
 * no memoro block is present, or when an older install (pre-stamp) wrote
 * the block without a version. Either way the caller treats null as
 * "unknown — can't compare".
 */
export async function readInstalledHookVersion() {
  if (!existsSync(settingsJson())) return null;
  const settings = await readSettings();
  const candidates = [
    ...(Array.isArray(settings?.hooks?.SessionStart) ? settings.hooks.SessionStart : []),
    ...(Array.isArray(settings?.hooks?.SessionEnd) ? settings.hooks.SessionEnd : []),
  ];
  for (const entry of candidates) {
    if (entry?._memoro === MEMORO_HOOK_ID && typeof entry._memoro_version === 'string') {
      return entry._memoro_version;
    }
  }
  return null;
}

export async function uninstallHooks() {
  if (!existsSync(settingsJson())) return null;
  const settings = await readSettings();
  if (!settings.hooks) return settingsJson();

  settings.hooks.SessionStart = dedupeHooks(settings.hooks.SessionStart, MEMORO_HOOK_ID);
  settings.hooks.SessionEnd   = dedupeHooks(settings.hooks.SessionEnd,   MEMORO_HOOK_ID);
  if (settings.hooks.SessionStart?.length === 0) delete settings.hooks.SessionStart;
  if (settings.hooks.SessionEnd?.length === 0)   delete settings.hooks.SessionEnd;
  if (Object.keys(settings.hooks).length === 0)  delete settings.hooks;

  await writeSettings(settings);
  return settingsJson();
}

/**
 * Drop one Claude Code slash-command file per lens section into
 * `~/.claude/commands/`. Each file runs `memoro-cli show <section>` so the
 * user can type `/memoro-loose-ends` (etc.) mid-session to inject that
 * section as context without an LLM roundtrip.
 *
 * Files are identified by the `memoro-` name prefix + a managed-block
 * marker in the body so `uninstallCommands` can remove them cleanly without
 * touching hand-authored slash commands that happen to live in the same
 * directory.
 */
export async function installCommands({
  memoroCliBin = 'memoro-cli',
  sections,
} = {}) {
  if (!Array.isArray(sections) || sections.length === 0) return [];
  await ensureDir(commandsDir());

  const written = [];
  for (const section of sections) {
    const file = join(commandsDir(), `${COMMAND_PREFIX}${section}.md`);
    const body = renderCommandFile({ section, memoroCliBin });
    await writeFile(file, body, { mode: 0o644 });
    written.push(file);
  }
  return written;
}

/**
 * Drop a `/memoro-update` slash command that surfaces the two-step update
 * recipe (npm install -g + hook re-install) inside Claude Code.
 *
 * Returns the absolute path to the written file. Idempotent — re-running
 * overwrites the existing file.
 *
 * Why not execute the commands directly? `npm install -g` typically needs
 * permissions Claude Code shouldn't run unattended (sudo on some setups).
 * Printing the recipe lets the LLM decide whether to run it and lets the
 * user copy-paste safely. The body is rendered into the conversation as a
 * user message, so the model sees the recipe and can offer to run it.
 */
export async function installUpdateCommand({ memoroCliBin = 'memoro-cli' } = {}) {
  await ensureDir(commandsDir());
  const file = join(commandsDir(), `${COMMAND_PREFIX}update.md`);
  const body = renderUpdateCommandFile({ memoroCliBin });
  await writeFile(file, body, { mode: 0o644 });
  return file;
}

export async function uninstallCommands() {
  if (!existsSync(commandsDir())) return [];
  let entries;
  try {
    entries = await readdir(commandsDir());
  } catch {
    return [];
  }

  const removed = [];
  for (const name of entries) {
    if (!name.startsWith(COMMAND_PREFIX) || !name.endsWith('.md')) continue;
    const file = join(commandsDir(), name);
    // Defense in depth: only delete files that carry our managed marker,
    // so a hand-authored `memoro-notes.md` the user dropped here isn't
    // swept up by uninstall.
    try {
      const content = await readFile(file, 'utf8');
      if (!content.includes(COMMAND_MARKER)) continue;
      await unlink(file);
      removed.push(file);
    } catch { /* best effort */ }
  }
  return removed;
}

/**
 * Detect whether Claude Code is installed / used on this machine. Good
 * signal: ~/.claude exists or CLAUDE.md exists at the usual path.
 */
export function detect() {
  return existsSync(claudeDir());
}

/**
 * Per §13a — the project-level instruction file Claude Code reads
 * natively. `mc adapter sync` (§13c) materialises a thin wrapper here
 * pointing at the canonical `docs/coding-agent-protocol.md`.
 *
 * Returning a path means "sync me"; null means "no instruction file for
 * this tool" (used by the gemini stub today). The `renderer` selects
 * the format converter — only `markdown-wrapper` exists in phase 2.
 */
export function instructionsFile() {
  return { path: 'CLAUDE.md', renderer: 'markdown-wrapper' };
}

// ─────────────────────────────────────────────────────────────
// `mc auth status` adapter contract (§11a)
//
// Every adapter that wants to appear in `mc auth status` exports:
//   - TOOL_NAME       — short label for the row
//   - STATUS_TIMEOUT_MS — bound on the probe wall-clock
//   - getStatus(opts?) → { installed, version, authenticated, hint,
//                          detailLines }
//
// `authenticated: null` means "can't verify without launching the TUI".
// In that case `hint` must be non-null and user-facing — "Run `claude
// /status` to verify" beats "auth probe not implemented".
// ─────────────────────────────────────────────────────────────

export const TOOL_NAME = 'claude';
export const STATUS_TIMEOUT_MS = 500;

const CLAUDE_BIN = 'claude';
const CREDENTIALS_FILE = () => join(claudeDir(), '.credentials.json');

function defaultWhich(bin) {
  const r = spawnSync('which', [bin], { encoding: 'utf8' });
  if (r.status !== 0) return null;
  return (r.stdout || '').trim() || null;
}

function defaultVersionProbe(binPath, timeoutMs) {
  const r = spawnSync(binPath, ['--version'], {
    encoding: 'utf8',
    timeout: timeoutMs,
  });
  if (r.status !== 0) return null;
  const out = (r.stdout || '').trim();
  // claude --version emits "2.1.152 (Claude Code)"
  const m = out.match(/\b(\d+\.\d+\.\d+)/);
  return m ? m[1] : (out || null);
}

function defaultCredentialsExist() {
  // Existence-only probe — never reads the credentials body.
  return existsSync(CREDENTIALS_FILE());
}

/**
 * Deep probe: PATH lookup + --version + credentials-file existence.
 * Existence of `~/.claude/.credentials.json` is the most reliable signal
 * we can read without launching the TUI; reading its body is both
 * unnecessary and blocked by the user's security hook.
 */
export async function getStatus({
  binPath,
  timeoutMs = STATUS_TIMEOUT_MS,
  which = defaultWhich,
  versionProbe = defaultVersionProbe,
  credentialsExist = defaultCredentialsExist,
} = {}) {
  const resolvedPath = binPath || which(CLAUDE_BIN);
  if (!resolvedPath) {
    return {
      installed: false,
      version: null,
      authenticated: null,
      hint: 'Install with: npm install -g @anthropic-ai/claude-code',
      detailLines: [],
    };
  }
  const version = await Promise.resolve(versionProbe(resolvedPath, timeoutMs));
  const authed = credentialsExist();
  return {
    installed: true,
    version,
    authenticated: authed,
    hint: authed ? null : 'Run `claude` and complete the sign-in flow',
    detailLines: [`bin: ${resolvedPath}`],
  };
}

// ─────────────────────────────────────────────────────────────
// Token vault — JIT materialisation contract (§12d)
//
// Phase 2 of the vault plan: mc materialises tokens to per-tool paths
// at session start (`mc new`/`mc resume`) and shreds them at session
// end (`mc end`). Adapter declares WHERE tokens live and HOW they're
// shaped on disk; the lifecycle owns WHEN.
//
// Claude Code reads `~/.claude/.credentials.json` for auth. The on-
// disk shape (confirmed in drev 3) is
//   { "anthropic": { "apiKey": "<token>" } }
// We materialise that exactly, mode 0600. The model running inside
// Claude Code never needs to *read* this file — only the tool process
// does. Phase 3 of the plan will install a PreToolUse hook that denies
// model reads of this path; phase 2 just gets the materialisation +
// shred lifecycle right.
//
// `env` location is declared but not directly writable by the mc
// parent — child processes get their env from `spawn` calls, and
// `mc new` doesn't currently spawn the tool with custom env (it re-
// execs into wrap mode, which spawns claude with parent env). We
// return `{ ok: false, reason: 'env-only' }` for env locations so the
// caller can surface a "set this env var manually" hint without
// failing the whole flow.
// ─────────────────────────────────────────────────────────────

/**
 * Where claude-code looks for credentials. Empty → "no materialisable
 * location known".
 */
export function tokenLocations() {
  return [
    {
      type: 'file',
      path: join(claudeDir(), '.credentials.json'),
      format: 'json',
      shape: 'anthropic-credentials-v1',
    },
  ];
}

/**
 * Materialise a token to the given location. Idempotent — overwriting
 * a previously-materialised file is fine; the shape doesn't carry any
 * mc-specific state, so re-running with the same token is a no-op
 * from the tool's perspective.
 *
 * @param {object} arg
 * @param {string} arg.token       - the token string
 * @param {object} arg.location    - one of the entries from tokenLocations()
 * @param {string} [arg.sessionId] - session-name (informational; the
 *   adapter doesn't fan files out per session — Claude Code reads
 *   a single, fixed path)
 * @param {object} [arg.deps]      - test injection for writeProtectedFile
 */
export async function materializeToken({ token, location, sessionId, deps = {} } = {}) {
  if (!token || typeof token !== 'string') {
    return { ok: false, reason: 'token required' };
  }
  if (!location || typeof location !== 'object') {
    return { ok: false, reason: 'location required' };
  }
  if (location.type === 'env') {
    return { ok: false, reason: 'env-only', envName: location.name || null };
  }
  if (location.type !== 'file') {
    return { ok: false, reason: `unsupported location type: ${location.type}` };
  }
  // Shape decision lives here — keep it tight. The body must NEVER be
  // logged or echoed by writeProtectedFile (verified by the
  // no-token-leak tests in tests/mc/vault/vault-cli.test.js).
  const body = JSON.stringify({ anthropic: { apiKey: token } });
  const path = await writeProtectedFile(location.path, body, { deps });
  return { ok: true, materializedPath: path };
}

/**
 * Shred a previously-materialised file. Best-effort + idempotent —
 * missing files are not an error. Errors during shred are reported
 * via the return value but never thrown, so `mc end` can shred all
 * adapters' files in a row without one failure blocking the rest.
 */
export async function shredToken({ location, sessionId, deps = {} } = {}) {
  if (!location || typeof location !== 'object') {
    return { ok: false, reason: 'location required' };
  }
  if (location.type !== 'file') {
    // env-only locations have nothing to shred from disk.
    return { ok: true, removed: false, reason: location.type };
  }
  return shredFile(location.path, { deps });
}

// ─────────────────────────────────────────────────────────────
// Internal
// ─────────────────────────────────────────────────────────────

const MEMORO_HOOK_ID = 'memoro-cli';
const COMMAND_MARKER = '<!-- memoro:managed:command -->';

const COMMAND_TITLES = {
  'loose-ends': 'Show loose ends from recent coding sessions',
  'decisions':  'Show recent decisions from coding sessions',
  'rules':      'Show learned coding rules',
  'stack':      'Show detected stack (languages, frameworks, preferences)',
  'repos':      'Show recent repos worked on',
  'practices':  'Show learned coding practices',
  'tool-use':   'Show learned tool-use preferences',
};

function renderCommandFile({ section, memoroCliBin }) {
  const title = COMMAND_TITLES[section] || `Show ${section}`;
  return `---
description: ${title}
---

${COMMAND_MARKER}

!${memoroCliBin} show ${section}
`;
}

function renderUpdateCommandFile({ memoroCliBin }) {
  // Body is rendered into the conversation as a user message. The LLM
  // should DISPLAY this recipe to the user — not try to run it, since
  // `npm install -g` is sanctioned global persistence and auto-mode
  // (correctly) blocks Claude Code from doing it unattended.
  return `---
description: Show the recipe for updating memoro-cli + hooks
---

${COMMAND_MARKER}

The user invoked \`/memoro-update\`. **Display** the two-step recipe
below — do not try to run it yourself. \`npm install -g\` is sanctioned
global persistence; auto-mode will block it, and even if it didn't, the
user should opt in to global package changes themselves.

\`\`\`sh
npm install -g ${memoroCliBin === 'memoro-cli' ? 'memoro-cli' : memoroCliBin}
${memoroCliBin} hook install --tool claude-code
\`\`\`

After the user runs both, the next \`mc\` (or restart of this session)
picks up the new version + refreshed hooks automatically. Reply with
just the recipe block and a brief one-line confirmation — no further
commentary, no offers to run it.
`;
}

async function readSettings() {
  if (!existsSync(settingsJson())) return {};
  try {
    const raw = await readFile(settingsJson(), 'utf8');
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

async function writeSettings(settings) {
  await ensureDir(claudeDir());
  await writeFile(settingsJson(), JSON.stringify(settings, null, 2), { mode: 0o600 });
  try { await chmod(settingsJson(), 0o600); } catch { /* best effort */ }
}

async function ensureDir(d) {
  if (!existsSync(d)) await mkdir(d, { recursive: true, mode: 0o700 });
}

function dedupeHooks(list, id) {
  if (!Array.isArray(list)) return [];
  return list.filter(h => h?._memoro !== id);
}
