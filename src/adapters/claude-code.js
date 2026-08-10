/**
 * Claude Code adapter.
 *
 * Nothing here writes `CLAUDE.md` — not the project's and not the user's.
 * mc used to: a managed block in the repository's file left a dirty worktree
 * after every launch, and a managed block in `~/.claude/CLAUDE.md` was tidier
 * and still mc leaving state in a file it does not own. The Coding Profile
 * now reaches a new conversation through `--append-system-prompt` at launch,
 * which needs no file at all. See `../mc/portrait.js`.
 *
 * What remains here: launch, resume, transcripts, and the SessionStart /
 * SessionEnd hooks in `~/.claude/settings.json`.
 */

import { readFile, writeFile, mkdir, chmod, readdir, unlink } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';
import { findClaudeSessionById, findLatestClaudeSession } from '../lib/claude.js';
import { getPackageVersion } from '../lib/version.js';
import { writeProtectedFile, shredFile } from './_materialise.js';

// Paths are resolved lazily via homedir() so tests (and any future env
// override) can redirect HOME without having to bust the module cache.
const claudeDir = () => join(homedir(), '.claude');
const settingsJson = () => join(claudeDir(), 'settings.json');
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
      // The broker binds this event to its exact runtime generation. It is a
      // no-op for raw Claude sessions and carries metadata only.
      { type: 'command', command: `${memoroCliBin} provider-artifact capture --tool ${ID}` },
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
 * The seven slash-commands mc used to write here are gone.
 *
 * Each dropped a file into `~/.claude/commands/` that ran
 * `memoro-cli show <section>` to pull one slice of the portrait into a
 * session on demand. The server stopped serving that lens externally — all
 * seven answered `404` — and the need went with it: the Coding Profile now
 * reaches every new conversation at launch, which is what they were fetching
 * by hand.
 *
 * `uninstallCommands` below stays, so `memoro-cli hook uninstall` still
 * clears the ones already written.
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

const MEMORO_HOOK_ID = 'memoro-cli';
const COMMAND_MARKER = '<!-- memoro:managed:command -->';
const LEGACY_MEMORO_HOOK_RE = /\bmemoro-cli\b\s+(lens\s+pull|heartbeat-loop|heartbeat-stop|session\s+upload)\b/;

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
  // updating is the user's decision and (in registry mode) `npm install -g`
  // is sanctioned global persistence that auto-mode correctly blocks.
  //
  // Two installation modes exist and the wrong recipe is destructive in one
  // of them: a source-linked install (`npm link`) that runs `npm install -g`
  // gets silently replaced by a registry copy and stops tracking the source.
  // So the recipe leads with detection.
  const pkg = memoroCliBin === 'memoro-cli' ? 'memoro-cli' : memoroCliBin;
  return `---
description: Show the recipe for updating memoro-cli
---

${COMMAND_MARKER}

The user invoked \`/memoro-update\`. **Display** the recipe below —
do not try to run it yourself. Updating is the user's own decision, and
in registry mode \`npm install -g\` is sanctioned global persistence
that auto-mode will block anyway.

memoro-cli is installed in one of two modes. Detect first:

\`\`\`sh
npm ls -g ${pkg}
\`\`\`

**Source-linked** — the output shows an arrow into a local directory
(\`${pkg}@x.y.z -> …/memoro-cli\`, from \`npm link\`). Update by pulling
the source the arrow points at:

\`\`\`sh
cd ~/memoro-cli && git pull
\`\`\`

Never run \`npm install -g\` in this mode: it silently replaces the link
with a registry copy, and the installation stops tracking the source.

**npm registry** — no arrow in the output. Update the package:

\`\`\`sh
npm install -g ${pkg}
\`\`\`

Either way, the next \`mc\` picks up the new version automatically.
Reply with the detection step and the matching recipe block, plus a
brief one-line confirmation — no further commentary, no offers to run
anything.
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
  return list.filter(h => h?._memoro !== id && !isLegacyMemoroHookEntry(h));
}

function isLegacyMemoroHookEntry(entry) {
  if (!entry || typeof entry !== 'object') return false;
  if (entry._memoro) return false;
  const hooks = Array.isArray(entry.hooks) ? entry.hooks : [];
  return hooks.some((hook) => {
    const command = typeof hook?.command === 'string' ? hook.command : '';
    return LEGACY_MEMORO_HOOK_RE.test(command);
  });
}

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

/**
 * Native-custody launch lifecycle. The launcher invokes these at fixed
 * points in its flow; the dep-override keys match the launcher's
 * long-standing test harness names on purpose.
 */
export const NATIVE_LAUNCH_HOOKS = Object.freeze({
  hookFailureReason: 'claude-provider-artifact-hook-unavailable',
  hookFailureLabel: 'Claude',
  // Before identity/config resolution: coordinator surface + artifact
  // hooks. A hook-install failure must refuse the launch.
  async prepareEarly({ deps = {} } = {}) {
    await (deps.installUpdateCommand || installUpdateCommand)().catch(() => {});
    await (deps.installClaudeArtifactHooks || installHooks)();
  },
});
