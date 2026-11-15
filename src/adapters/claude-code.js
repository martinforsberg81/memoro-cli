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
// Control runs through durable callbacks, not additional conversation turns.
export const SESSION_TRANSPORT = Object.freeze({ events: 'jsonl', prompt: 'stdin-jsonl', live_control: false, current_context: 'request-estimate' });
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
// identifies itself in heartbeats. Nothing about instruction files: a role's
// instructions reach a new conversation as a launch argument, which the
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
    // Claude already executes on the host; do not bypass its approval policy.
    executionAccess: 'host',
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

// How long the prompt cache keeps a session's prefix: the TTL the session was
// launched with, which is its role's (`cache:` in the role's frontmatter,
// ruling 40) and reaches claude through `sessionArgs`. Inside it a resumed
// session's first request reads its conversation from the cache
// (`recoveryFor`, run-plan.js).
export function cacheTtlMs(cache) {
  return cache === '5m' ? 5 * 60_000 : 60 * 60_000;
}

/**
 * What every session mc launches is handed beside its role text: no
 * CLAUDE.md, no auto-memory, and the role's prompt-cache TTL for the session
 * and its subagents. Through `--settings` rather than the spawned process's
 * environment, so a foreground or tmux launch carries them exactly as a
 * headless one does (verified on claude 2.1.296: the request then carries no
 * CLAUDE.md, no MEMORY.md and no memory section, and writes
 * `ephemeral_5m_input_tokens` for `5m`).
 */
export function sessionArgs({ cache = '1h' } = {}) {
  return ['--settings', JSON.stringify({
    env: {
      CLAUDE_CODE_DISABLE_CLAUDE_MDS: '1',
      CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1',
      CLAUDE_CODE_PROMPT_CACHE_TTL: cache,
      CLAUDE_CODE_SUBAGENT_PROMPT_CACHE_TTL: cache,
    },
  })];
}

/**
 * The nine tools every session mc launches has, including native delegation
 * and web search and fetch, so research cites its sources without a browser.
 */
export const CLAUDE_TOOLS = 'Bash,Read,Edit,Write,Grep,Glob,Agent,WebSearch,WebFetch';

/**
 * The tools of every session mc launches, whatever its role: the allowlist and
 * no user-level MCP server. Agent is the tool's own general-purpose agent;
 * mc supplies no agent definitions. Tool definitions ride in every request,
 * so the allowlist stays narrow. `--tools` takes several values, so
 * `--strict-mcp-config` stays behind it: a prompt after the allowlist would
 * be read as a tool.
 */
export function toolArgs() {
  return ['--tools', CLAUDE_TOOLS, '--strict-mcp-config'];
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
// Token vault — refusal-only compatibility API
//
// `tokenLocations()` advertises no destinations and `materializeToken()`
// refuses plaintext materialisation. Claude Code owns native authentication;
// this adapter does not create its credentials file or inject a provider key.
// `shredToken()` remains legacy best-effort cleanup for files created by older
// mc versions, not part of an active materialisation lifecycle.
//
// API-billed sessions use billing-gateway-session.js: the gateway retains its
// fixed vault credential and Claude receives a bounded loopback grant. This
// boundary is unchanged; the audit does not certify provider/runtime custody.
// ─────────────────────────────────────────────────────────────

/**
 * Refusal-only compatibility API: Claude Code's native auth is tool-owned;
 * mc advertises no plaintext credential locations.
 */
export function tokenLocations() {
  return [];
}

/**
 * Refuse plaintext materialisation. This compatibility entrypoint is disabled;
 * callers must not infer an idempotent write or active session lifecycle.
 *
 * @param {object} arg
 * @param {string} [arg.token] - ignored by the refusal-only implementation
 * @param {object} [arg.location] - ignored by the refusal-only implementation
 * @param {string} [arg.sessionId] - ignored by the refusal-only implementation
 * @param {object} [arg.deps] - ignored by the refusal-only implementation
 */
export async function materializeToken({ token, location, sessionId, deps = {} } = {}) {
  return { ok: false, reason: 'plaintext-materialisation-disabled' };
}

/**
 * Legacy cleanup of a previously-materialised file. Best-effort and
 * idempotent: missing files are not an error. Errors are returned, not
 * thrown, so cleanup of an old artifact does not block other cleanup.
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

/* ------------------------------------------------------------------
 * Seam declarations. `src/mc/` asks the registry (`index.js`) for these and
 * never compares this tool's name. A declaration is a named export; a tool
 * that lacks one is refused by a seam that launches, bills, routes or acts.
 * ------------------------------------------------------------------ */

/** The command name this tool's process runs under. */
export const PROCESS_NAME = 'claude';

/**
 * The headless argument list: `pieces` are what the runner computed from this
 * adapter's own switches (`modelArgs`, `effortArgs`, `advisorArgs`,
 * `sessionArgs`), the role's instruction arguments, the prompt, and the
 * resumed session id.
 */
export function headlessArgs({ modelArgs: model, effortArgs: effort, advisorArgs: advisor, session, instr, prompt, resume = null, stream = true, autocompact = null }) {
  const tuning = [...effort, ...advisor];
  const compact = autocompact ? ['--autocompact', String(autocompact)] : [];
  const io = stream
    ? ['--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose']
    : ['--output-format', 'json'];
  // `--resume` keeps the session's id and its whole history; the message on
  // stdin is the next turn of that conversation.
  const resumed = resume ? ['--resume', resume] : [];
  const tools = ['--tools', CLAUDE_TOOLS];
  return ['-p', ...resumed, ...(stream ? [] : [prompt]), ...model, ...tuning, '--permission-mode', 'acceptEdits', ...compact, ...tools, '--strict-mcp-config', ...session, ...instr, ...io];
}

/** The mechanism `src/mc/run-plan.js` reads this tool's headless output with. */
export const OUTPUT_READER = 'claude-stream';

/** A running session is asked whether its step can be finished and is killed when silent too long. */
export const WATCH = Object.freeze({ checkIn: true, stallGuard: true });

/**
 * What a session runs on when neither its step nor its plan says otherwise,
 * per kind. A step is `opus` at `medium` effort with no advisor (2026-09-25,
 * ruling 18's second addendum). These are claude's aliases and nobody else's.
 */
export const SESSION_DEFAULTS = Object.freeze({
  step: Object.freeze({ model: 'opus', effort: 'medium', advisor: null }),
  review: Object.freeze({ model: 'opus', effort: 'high', advisor: null }),
});

/** A named advisor model is kept (`--advisor`). */
export const ADVISOR_SUPPORT = true;

/** The name billing state, plan windows and the API gateway know this tool by. */
export const BILLING_PROVIDER = 'claude';

/** Where this tool ranks when a provider priority is not `auto`: a lower rank is listed first. */
export const PROVIDER_PRIORITY_RANK = 1;

/** Intake and other catalog-routed turns may run on this tool's role model: no catalog candidate is required. */
export const INTAKE_FROM_CATALOG = null;

/** A plan review passes the checkout as an allowed directory, before the permission mode. */
export const ALLOWED_DIR = Object.freeze({ flag: '--add-dir', before: '--permission-mode' });

/** The mechanism that reads this tool's plan usage; `src/mc/run.js` holds the code for it. */
export const CAPACITY_READER = 'claude-usage';

/** The plan windows a usage snapshot carries for this tool, in order. */
export const PLAN_WINDOWS = Object.freeze(['five_hour', 'seven_day']);

/** A login interruption means the plan refused the session. */
export const LOGIN_REFUSES_PLAN = true;

/**
 * The plan's refusal is recorded in billing state (`plan.refused_until`) and
 * its windows are read from the session's stream: the mechanism `src/mc/run.js`
 * reads them with.
 */
export const PLAN_STATE = 'claude-stream';

/**
 * The standing rule for choosing a model of this tool (`model-choice.js`): an
 * unknown capacity reading may bootstrap a choice, and candidates are not
 * judged per model.
 */
export const MODEL_CHOICE = Object.freeze({ bootstrapsOnUnknown: true, perModel: false });

/**
 * The API-credit route: where the gateway forwards, how it authenticates, which
 * model names a grant's aliases cover, and the settings the tool is started
 * with so it talks to the gateway. No key or grant is held here: the gateway
 * attaches the key, and `toolConfig` receives the session's grant.
 */
export const API_ROUTE = Object.freeze({
  upstream: 'https://api.anthropic.com',
  auth: Object.freeze({ header: 'x-api-key', scheme: null }),
  routes: Object.freeze([
    Object.freeze({ path: '/v1/messages', methods: Object.freeze(['POST']) }),
    Object.freeze({ path: '/v1/messages/count_tokens', methods: Object.freeze(['POST']) }),
  ]),
  websocket: null,
  modelAliases: Object.freeze({ names: Object.freeze(['opus', 'fable', 'sonnet', 'haiku']), prefix: 'claude-' }),
  // An explicit `credits` billing mode moves this tool's sessions to the API.
  creditsByMode: true,
  toolConfig({ base, grant, args, env }) {
    return { args, env: { ...env, ANTHROPIC_BASE_URL: `${base}/claude`, ANTHROPIC_AUTH_TOKEN: grant } };
  },
});
