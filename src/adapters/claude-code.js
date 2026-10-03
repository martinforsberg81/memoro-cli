/**
 * Claude Code adapter.
 *
 * Nothing here writes `CLAUDE.md` — not the project's and not the user's.
 * mc used to: a managed block in the repository's file left a dirty worktree
 * after every launch, and a managed block in `~/.claude/CLAUDE.md` was tidier
 * and still mc leaving state in a file it does not own. A role's
 * instructions reach a new conversation through `--append-system-prompt` at launch,
 * which needs no file at all. See `../mc/portrait.js`.
 *
 * What remains here: launch, resume and transcripts.
 */

import { readFile, readdir, unlink } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';
import { findClaudeSessionById, findLatestClaudeSession } from '../lib/claude.js';
import { writeProtectedFile, shredFile } from './_materialise.js';

// Paths are resolved lazily via homedir() so tests (and any future env
// override) can redirect HOME without having to bust the module cache.
const claudeDir = () => join(homedir(), '.claude');
const commandsDir = () => join(claudeDir(), 'commands');

const COMMAND_PREFIX = 'memoro-';

export const ID = 'claude-code';
export const LABEL = 'Claude Code';
// This adapter owns no instruction file. The constant remains so callers that
// ask every adapter the same question get a truthful answer rather than an
// exception.
export const CONFIG_PATH = null;
export const POLICY_SUPPORT = Object.freeze({
  permissions: Object.freeze({
    profile: 'unsupported',
    workspace: 'unsupported',
    network: 'unsupported',
    approval: 'unsupported',
    secrets: 'unsupported',
  }),
});

/**
 * mc writes no slash commands into `~/.claude/commands/` any more.
 *
 * Seven of them ran `memoro-cli show <section>` to pull one slice of the
 * portrait into a session; the server stopped serving that lens, and the
 * Coding Profile that replaced it at launch went too (ruling 24). Two more,
 * `/memoro-coordinator` and `/memoro-coordinator-suggest`, opened a
 * coordinator role that `mc` itself is now. The last, `/memoro-update`,
 * displayed the recipe for updating memoro-cli, and was rewritten on every
 * launch — so it came back however often it was deleted (Martin,
 * 2026-09-12: "vi behöver rensa bort några gamla mc kommandon i claude som
 * inte längre används").
 *
 * `uninstallCommands` stays, and runs at every launch and on
 * `mc hook uninstall`, so a file any earlier version wrote is removed the
 * next time mc starts. It deletes only files that carry `COMMAND_MARKER`.
 */
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
    const isManagedName = name === 'mc.md' || (name.startsWith(COMMAND_PREFIX) && name.endsWith('.md'));
    if (!isManagedName) continue;
    const file = join(commandsDir(), name);
    // Defense in depth: only delete files that carry our managed marker,
    // so a hand-authored `memoro-notes.md` or `mc.md` isn't
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

// ─────────────────────────────────────────────────────────────
// Interactive launch contract
//
// `launchSpec()` declares WHICH binary to spawn and HOW the session
// identifies itself in heartbeats. Nothing about instruction files: the
// Coding Profile reaches a new conversation as a launch argument, which the
// caller assembles.
//
// `bin`            — the executable to spawn in the PTY.
// `args(argv)`     — map the user-supplied argv into the binary's args.
// `heartbeatSource`— the `source` field stamped on heartbeats so peer
//                    coordinators can tell which tool a session runs.
// `label`          — human label for the launch banner / errors.
// ─────────────────────────────────────────────────────────────
export function launchSpec() {
  return {
    bin: CLAUDE_BIN,
    args: (argv = [], { startupMessage = null } = {}) => {
      const base = [...argv];
      if (!startupMessage) return base;
      return [...base, '--append-system-prompt', startupMessage];
    },
    heartbeatSource: 'claude-code',
    label: LABEL,
    startupMessageDelivery: 'launch-args',
    installHint: 'Install with: npm install -g @anthropic-ai/claude-code',
  };
}

export function resumeArgs({ sessionId, model = null } = {}) {
  if (!sessionId || typeof sessionId !== 'string') return null;
  return ['--resume', sessionId, ...modelArgs(model)];
}

/**
 * The model to run on, passed through as given. mc does not validate model
 * names — the tool is the authority on what exists, and its own error names
 * the mistake better than a stale list here could.
 */
export function modelArgs(model) {
  if (!model || typeof model !== 'string') return [];
  return ['--model', model];
}

/**
 * The effort to run at (`low` … `max`). Without it claude takes the machine's
 * `effortLevel` from `~/.claude/settings.json` — `high` on this one, which is
 * what every runner session ran at until step-cost (ruling 18).
 */
export function effortArgs(effort) {
  if (!effort || typeof effort !== 'string') return [];
  return ['--effort', effort];
}

/**
 * The advisor: a second model the session consults at its decision points.
 * `--help` does not list the flag; code.claude.com/docs/en/advisor.md names
 * it, and claude 2.1.268 accepted it on 2026-09-11. Off unless asked for, so
 * nothing — or `off` — is no flag.
 */
export function advisorArgs(advisor) {
  if (!advisor || typeof advisor !== 'string' || advisor === 'off') return [];
  return ['--advisor', advisor];
}

/**
 * mc mints the session id for a NEW session and hands it to Claude via
 * `--session-id`, so the registry owns the native id from launch instead
 * of rediscovering it from transcript files afterwards. Claude requires
 * a well-formed UUID and refuses ids that are already in use, so the
 * caller must mint a fresh UUID per launch.
 */
export function newSessionArgs({ sessionId } = {}) {
  if (typeof sessionId !== 'string'
    || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(sessionId)) {
    return null;
  }
  return ['--session-id', sessionId];
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
// macOS stores Claude Code credentials in the login Keychain, not in
// `~/.claude/.credentials.json`. The service name is the stable lookup key.
const KEYCHAIN_SERVICE = 'Claude Code-credentials';

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

/**
 * Existence-only Keychain probe (macOS). `security find-generic-password`
 * without `-g` reports whether an item exists WITHOUT decrypting the secret,
 * so it never triggers a Keychain unlock prompt and never reads the body.
 * Returns false on any non-macOS platform or probe error.
 */
function defaultKeychainHasCredentials(platform = process.platform) {
  if (platform !== 'darwin') return false;
  try {
    const r = spawnSync('security', ['find-generic-password', '-s', KEYCHAIN_SERVICE], {
      encoding: 'utf8',
      timeout: 1000,
    });
    return r.status === 0;
  } catch {
    return false;
  }
}

/**
 * Pure resolver: credentials are present if the on-disk file exists OR (on
 * macOS) the Keychain item exists. Kept pure + exported so the Keychain
 * branch is unit-testable without spawning `security`.
 */
export function resolveCredentialsPresence({
  fileExists = false,
  platform = process.platform,
  keychainProbe = defaultKeychainHasCredentials,
} = {}) {
  if (fileExists) return true;
  // Keychain fallback is macOS-only; other platforms rely on the file.
  if (platform !== 'darwin') return false;
  return keychainProbe(platform) === true;
}

function defaultCredentialsExist() {
  // Existence-only probe — never reads the credentials body. Checks the
  // legacy JSON file first, then falls back to the macOS Keychain (where
  // modern Claude Code installs actually store auth).
  return resolveCredentialsPresence({ fileExists: existsSync(CREDENTIALS_FILE()) });
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
// Native Claude auth remains owned by Claude. mc never converts a vault secret
// into ~/.claude/.credentials.json or an environment variable. The shred
// function remains only for cleanup of artifacts created by older mc versions.
// ─────────────────────────────────────────────────────────────

/**
 * Where claude-code looks for credentials. Empty → "no materialisable
 * location known".
 */
export function tokenLocations() {
  return [];
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
  return { ok: false, reason: 'plaintext-materialisation-disabled' };
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

const COMMAND_MARKER = '<!-- memoro:managed:command -->';

/**
 * Transcript dialect: how THIS tool's JSONL transcript maps onto the
 * provider-neutral distill pipeline. Content redaction and safe-metadata
 * shaping stay central in src/lib/distill.js — the dialect only locates
 * roles, content, metadata, and raw tool calls in the entry shapes.
 */
export const TRANSCRIPT_DIALECT = Object.freeze({
  provider: 'anthropic',
  meta() {
    return null;
  },
  message(entry) {
    const role = entry.role || entry.message?.role || entry.type || null;
    const content = entry.content || entry.message?.content || entry.text || null;
    return role || content ? { role, content } : null;
  },
  toolCalls(entry) {
    const content = entry.content || entry.message?.content;
    if (!Array.isArray(content)) return [];
    return content
      .filter((block) => block && block.type === 'tool_use')
      .map((block) => ({ name: block.name || 'unknown', input: block.input || {} }));
  },
});

/** Transcript discovery: where THIS tool keeps native session transcripts. */
export const TRANSCRIPT_DISCOVERY = Object.freeze({
  findLatest: (options) => findLatestClaudeSession(options),
  findById: (options) => findClaudeSessionById(options),
});

/**
 * Declarative artifact-ownership profile — see the codex adapter for the
 * contract shape. Inspection and deletion machinery stays central.
 */
export const ARTIFACT_OWNERSHIP = Object.freeze({
  homeEnv: 'CLAUDE_HOME',
  homeDir: '.claude',
  layout(providerRoot, { join }) {
    return {
      transcript_roots: [join(providerRoot, 'projects')],
      file_history_root: join(providerRoot, 'file-history'),
      session_env_root: join(providerRoot, 'session-env'),
      tasks_root: join(providerRoot, 'tasks'),
      negative_roots: [
        providerRoot,
        join(providerRoot, 'history.jsonl'),
        join(providerRoot, 'settings.json'),
        join(providerRoot, 'shell-snapshots'),
        join(providerRoot, 'memory'),
        join(providerRoot, 'plugins'),
      ],
    };
  },
  sessionDirectories({ sessionId, transcriptPath, roots, join, dirname }) {
    const projectDir = dirname(transcriptPath);
    return [
      {
        kind: 'claude-project-session-data',
        path: join(projectDir, sessionId),
        root: projectDir,
        providerRoot: roots.provider_root,
        expected: 'directory',
      },
      ...[
        ['claude-file-history', roots.file_history_root],
        ['claude-session-env', roots.session_env_root],
        ['claude-tasks', roots.tasks_root],
      ].map(([kind, root]) => ({
        kind,
        path: join(root, sessionId),
        root,
        providerRoot: roots.provider_root,
        expected: 'directory',
      })),
    ];
  },
  sessionFilePatterns() {
    return [];
  },
  transcriptLayoutMatches({ sessionId, parts }) {
    return parts.length === 2
      && parts[0].startsWith('-')
      && parts[1] === `${sessionId}.jsonl`;
  },
  transcriptHeadSessionId(entry) {
    return entry?.sessionId || entry?.session_id || null;
  },
});
