/**
 * Codex CLI adapter.
 *
 * Codex reads workspace-local `AGENTS.md` files. mc keeps that file as
 * static project instructions managed by `mc adapter sync`; per-session
 * grounding is delivered as the initial CLI prompt so the tracked wrapper
 * is not dirtied by runtime state and Codex does not open its resume picker
 * on an empty launch.
 */

import { findCodexSessionById, findLatestCodexSession } from '../lib/codex.js';
import {
  chmod, lstat, mkdir, open, readFile, rename, rm, unlink, writeFile,
} from 'node:fs/promises';
import { constants, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { basename, dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { upsertManagedBlock, removeManagedBlock } from '../lib/managed-block.js';
import {
  resolveWorkspaceRoot,
  ensureCodexAgentsIgnored,
  resolveRealCodexBinary,
} from '../lib/codex.js';
import { stripAnsi } from '../lib/prompt.js';
import { writeProtectedFile, shredFile } from './_materialise.js';

const DEFAULT_LAUNCHER = join(homedir(), '.local', 'bin', 'codex-memoro');
const DEFAULT_SHIM = join(homedir(), '.local', 'bin', 'codex');
const MEMORO_HOOK_ID = 'memoro-cli';
const CODEX_SESSION_START_MATCHER = 'startup|resume';

export const ID = 'codex';
export const LABEL = 'Codex CLI';
export const CONFIG_PATH = 'AGENTS.md';
export const POLICY_SUPPORT = Object.freeze({
  permissions: Object.freeze({
    profile: 'unsupported',
    workspace: 'supported',
    network: 'unsupported',
    approval: 'supported',
    secrets: 'unsupported',
  }),
});

export async function writeLens(markdown, { cwd = process.cwd() } = {}) {
  const root = resolveWorkspaceRoot(cwd);
  const target = join(root, 'AGENTS.md');
  const existing = existsSync(target) ? await readFile(target, 'utf8') : '';
  const next = upsertManagedBlock(existing, markdown);
  await writeFile(target, next);
  await ensureCodexAgentsIgnored(root);
  return target;
}

export async function removeLens({ cwd = process.cwd() } = {}) {
  const target = join(resolveWorkspaceRoot(cwd), 'AGENTS.md');
  if (!existsSync(target)) return;
  const existing = await readFile(target, 'utf8');
  const next = removeManagedBlock(existing);
  await writeFile(target, next);
}

// Grounding block markers — codex's OWN markers, distinct from both the
// lens block (default portrait-coding marker) AND the claude-code
// grounding markers, so a session that switches between tools never has
// one tool's block collide with another's in a shared AGENTS.md. Same
// managed-block round-trip as claude-code; only the target file
// (AGENTS.md) and the marker text differ.
export const GROUNDING_BEGIN = '<!-- memoro:managed:grounding:codex:begin -->';
export const GROUNDING_END   = '<!-- memoro:managed:grounding:codex:end -->';

const projectAgentsMd = (cwd) => join(resolveWorkspaceRoot(cwd), 'AGENTS.md');

/**
 * Deliver the grounding bundle without mutating AGENTS.md. AGENTS.md is
 * now the static adapter-sync wrapper and is usually tracked project state;
 * putting per-session runtime state there leaves a dirty worktree after
 * every Codex launch. The shared `groundSession` seam understands this
 * structured return value and passes `message` as Codex's initial prompt
 * before the user's real work begins.
 */
export async function writeGrounding(markdown, { cwd = process.cwd() } = {}) {
  return {
    path: projectAgentsMd(cwd),
    delivery: 'startup-message',
    message: markdown,
  };
}

/**
 * Remove a legacy codex grounding managed block from the workspace
 * AGENTS.md. New launches do not write this block, but cleanup remains so
 * old sessions and interrupted pre-0.7.5 runs can be repaired safely.
 */
export async function removeGrounding({ cwd = process.cwd() } = {}) {
  const target = projectAgentsMd(cwd);
  if (!existsSync(target)) return;
  const existing = await readFile(target, 'utf8');
  const next = removeManagedBlock(existing, {
    beginMarker: GROUNDING_BEGIN,
    endMarker: GROUNDING_END,
  });
  await writeFile(target, next);
}

export async function installHooks({
  memoroCliBin = 'memoro-cli',
  codexHome = CODEX_HOME_DIR(),
  configPath = codexHooksPath(codexHome),
} = {}) {
  const config = await readHooksConfig(configPath);
  const hooks = config.hooks || (config.hooks = {});
  if (!plainObject(hooks)) throw new Error('Codex hooks.json hooks must be an object');
  const sessionStart = Array.isArray(hooks.SessionStart)
    ? hooks.SessionStart
    : hooks.SessionStart == null
      ? []
      : null;
  if (!sessionStart) throw new Error('Codex hooks.json hooks.SessionStart must be an array');

  hooks.SessionStart = sessionStart.filter((entry) => !isMemoroCodexHook(entry));
  hooks.SessionStart.push({
    _memoro: MEMORO_HOOK_ID,
    matcher: CODEX_SESSION_START_MATCHER,
    hooks: [{ type: 'command', command: `${memoroCliBin} provider-artifact capture --tool ${ID}` }],
  });
  await writeHooksConfig(configPath, config);
  return {
    configPath,
  };
}

export async function uninstallHooks({
  launcherPath = DEFAULT_LAUNCHER,
  shimPath = DEFAULT_SHIM,
  codexHome = CODEX_HOME_DIR(),
  configPath = codexHooksPath(codexHome),
} = {}) {
  const removed = [];
  const config = await readHooksConfig(configPath, { missing: null });
  if (config) {
    const hooks = config.hooks;
    if (!plainObject(hooks)) throw new Error('Codex hooks.json hooks must be an object');
    if (Array.isArray(hooks.SessionStart)) {
      const next = hooks.SessionStart.filter((entry) => !isMemoroCodexHook(entry));
      if (next.length !== hooks.SessionStart.length) {
        if (next.length) hooks.SessionStart = next;
        else delete hooks.SessionStart;
        await writeHooksConfig(configPath, config);
        removed.push(configPath);
      }
    } else if (hooks.SessionStart != null) {
      throw new Error('Codex hooks.json hooks.SessionStart must be an array');
    }
  }
  if (await removeManagedCodexScript(launcherPath, isManagedCodexLauncher)) {
    removed.push(launcherPath);
  }
  if (await removeManagedCodexScript(shimPath, (body) => isManagedCodexShim(body, launcherPath))) {
    removed.push(shimPath);
  }
  return { path: shimPath, removed };
}

function codexHooksPath(codexHome = CODEX_HOME_DIR()) {
  return join(codexHome, 'hooks.json');
}

async function readHooksConfig(path, { missing = {} } = {}) {
  try {
    const parsed = JSON.parse(await readFile(path, 'utf8'));
    if (!plainObject(parsed)) throw new Error('Codex hooks.json must contain an object');
    return parsed;
  } catch (error) {
    if (error?.code === 'ENOENT') return missing;
    if (error instanceof SyntaxError) throw new Error(`Codex hooks.json is invalid JSON: ${error.message}`);
    throw error;
  }
}

async function writeHooksConfig(path, config) {
  const directory = dirname(path);
  let directoryStat;
  try {
    directoryStat = await lstat(directory);
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
    await mkdir(directory, { recursive: true, mode: 0o700 });
    directoryStat = await lstat(directory);
  }
  if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink()) {
    throw new Error('Codex hook directory is unsafe');
  }
  await chmod(directory, 0o700);
  try {
    const targetStat = await lstat(path);
    if (!targetStat.isFile() || targetStat.isSymbolicLink()) {
      throw new Error('Codex hooks.json is unsafe');
    }
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }

  const temporary = join(
    directory,
    `.${basename(path)}.${randomBytes(12).toString('hex')}.tmp`,
  );
  let handle = null;
  try {
    handle = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
    await handle.writeFile(`${JSON.stringify(config, null, 2)}\n`, 'utf8');
    await handle.sync();
    await handle.chmod(0o600);
    await handle.close();
    handle = null;
    await rename(temporary, path);
    const directoryHandle = await open(directory, constants.O_RDONLY);
    try { await directoryHandle.sync(); } finally { await directoryHandle.close(); }
  } finally {
    if (handle) await handle.close().catch(() => {});
    await unlink(temporary).catch(() => {});
  }
}

function isMemoroCodexHook(entry) {
  if (!plainObject(entry)) return false;
  if (entry._memoro === MEMORO_HOOK_ID) return true;
  return Array.isArray(entry.hooks) && entry.hooks.some((hook) => (
    typeof hook?.command === 'string'
      && /\bprovider-artifact\s+capture\s+--tool\s+codex\b/.test(hook.command)
  ));
}

function plainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}

/**
 * Codex doesn't currently expose a bang-style slash-command surface
 * equivalent to Claude Code's `~/.claude/commands/`. Return an empty list
 * so the hook-install orchestrator can treat command install as best-effort
 * per adapter without special-casing.
 */
export async function installCommands() { return []; }
export async function uninstallCommands() { return []; }

export function detect() {
  return existsSync(join(homedir(), '.codex'));
}

/**
 * Per §13a — Codex reads project-level `AGENTS.md` (per agents.md
 * convention). `mc adapter sync` materialises a thin wrapper here
 * pointing at the canonical `docs/coding-agent-protocol.md`.
 */
export function instructionsFile() {
  return { path: 'AGENTS.md', renderer: 'markdown-wrapper' };
}

// ─────────────────────────────────────────────────────────────
// Interactive launch contract (§5 / Grounding Phase 3)
//
// Parity with claude-code's `launchSpec()`. The wrap-mode launcher spawns
// `bin` in the PTY; for codex we resolve the REAL codex binary (skipping
// the `~/.local/bin/codex` shim + `codex-memoro` launcher) so we don't
// recurse through mc's own wrapper. When the real binary can't be found,
// `bin` is null — the launcher fails high with the install hint rather
// than spawning nothing (soft-degrade is NOT silent here, per §5).
//
// Grounding is delivered later through the owned PTY, not as argv, so Codex
// Apps/MCP startup can finish before the first prompt is submitted. Native
// resume is represented by the `codex resume <session-id>` subcommand and is
// built by `resumeArgs()` below.
// ─────────────────────────────────────────────────────────────
export function launchSpec({ resolveBinary = resolveRealCodexBinary } = {}) {
  let bin = null;
  try { bin = resolveBinary(); } catch { bin = null; }
  const buildArgs = (argv = [], { startupMessage = null, effectivePolicy = null } = {}) => {
    const base = [...argv];
    const policyArgs = renderPolicy(effectivePolicy).launchArgs;
    void startupMessage;
    return [...base, ...policyArgs];
  };
  return {
    bin,
    args: buildArgs,
    spawn: (argv = [], options = {}) => {
      const args = buildArgs(argv, options);
      if (!options?.codexDeviceAuthBeforeLaunch) {
        return { bin, args };
      }
      return {
        bin: '/bin/sh',
        args: [
          '-c',
          CODEX_DEVICE_AUTH_BOOTSTRAP,
          'mc-codex-device-auth',
          bin,
          ...args,
        ],
      };
    },
    heartbeatSource: 'codex',
    label: LABEL,
    installHint: 'Install Codex CLI from openai/codex (could not locate the codex binary)',
    startupMessageDelivery: 'deferred-pty',
    isUserMessagePromptReady: isCodexUserMessagePromptReady,
    submitEnterCount: 2,
    submitEnterDelayMs: 150,
  };
}

/**
 * Codex can show native policy dialogs before its composer. Broker-delivered
 * grounding and handoff messages must wait for the real composer instead of
 * becoming accidental answers to those dialogs. Managed Codex is pinned, so
 * its main-screen banner is a stable readiness marker for this boundary.
 * Comparing the latest relevant markers also pauses an already scheduled
 * delivery if hook review is redrawn before the idle timer fires.
 */
export function isCodexUserMessagePromptReady({ recentOutput = '' } = {}) {
  const output = stripAnsi(recentOutput);
  const composerIndex = output.lastIndexOf('OpenAI Codex');
  const hookReviewIndex = output.lastIndexOf('Hooks need review');
  return composerIndex >= 0 && composerIndex > hookReviewIndex;
}

const CODEX_DEVICE_AUTH_BOOTSTRAP = [
  'set -eu',
  'codex_bin=$1',
  'shift',
  'printf "%s\\n" "mc cloud: Codex needs ChatGPT authorization. Starting Codex device login."',
  'printf "%s\\n" "Complete the device login shown below; Codex will start automatically after approval."',
  '"$codex_bin" login --device-auth',
  'exec "$codex_bin" "$@"',
].join('\n');

export function resumeArgs({ sessionId } = {}) {
  if (!sessionId || typeof sessionId !== 'string') return null;
  return ['resume', sessionId];
}

export function renderPolicy(policy = null) {
  const permissions = policy?.permissions && typeof policy.permissions === 'object'
    ? policy.permissions
    : {};
  const explicit = Array.isArray(policy?.explicit_permissions)
    ? new Set(policy.explicit_permissions)
    : new Set();
  const launchArgs = [];
  const warnings = [];

  if (explicit.has('workspace')) {
    const rendered = codexSandboxForWorkspace(permissions.workspace);
    const sandbox = rendered?.sandbox || null;
    if (rendered?.warning) warnings.push(rendered.warning);
    if (sandbox) launchArgs.push('--sandbox', sandbox);
  }
  if (explicit.has('approval')) {
    const approval = codexApprovalForPolicy(permissions.approval);
    if (approval) launchArgs.push('--ask-for-approval', approval);
  }

  return {
    launchArgs,
    env: {},
    artefacts: [],
    support: POLICY_SUPPORT,
    warnings,
  };
}

function codexSandboxForWorkspace(workspace) {
  if (workspace === 'read-only') return { sandbox: 'read-only' };
  if (workspace === 'worktree') return { sandbox: 'workspace-write' };
  if (workspace === 'full') {
    return {
      sandbox: 'workspace-write',
      warning: 'workspace=full is not rendered; capped to workspace-write because mc never grants full tool access',
    };
  }
  return null;
}

function codexApprovalForPolicy(approval) {
  if (approval === 'untrusted') return 'untrusted';
  if (approval === 'on-request') return 'on-request';
  if (approval === 'never') return 'never';
  return null;
}

// ─────────────────────────────────────────────────────────────
// `mc auth status` adapter contract (§11a)
//
// Codex ships a `--version` flag but no documented headless auth probe;
// `codex /status` is interactive. So this is the shallow form of the
// contract — installed + version only, with a user-friendly hint
// pointing at the right next action. Deep auth probe is tracked in
// §11f for v2.
// ─────────────────────────────────────────────────────────────

export const TOOL_NAME = 'codex';
export const STATUS_TIMEOUT_MS = 500;

const CODEX_BIN = 'codex';

function defaultWhich(bin) {
  const r = spawnSync('which', [bin], { encoding: 'utf8' });
  if (r.status !== 0) return null;
  return (r.stdout || '').trim() || null;
}

function defaultVersionProbe(binPath, timeoutMs) {
  const r = spawnSync(binPath, ['--version'], { encoding: 'utf8', timeout: timeoutMs });
  if (r.status !== 0) return null;
  const out = (r.stdout || '').trim();
  const m = out.match(/\b(\d+\.\d+\.\d+)/);
  return m ? m[1] : (out || null);
}

export async function getStatus({
  binPath,
  timeoutMs = STATUS_TIMEOUT_MS,
  which = defaultWhich,
  versionProbe = defaultVersionProbe,
} = {}) {
  const resolvedPath = binPath || which(CODEX_BIN);
  if (!resolvedPath) {
    return {
      installed: false,
      version: null,
      authenticated: null,
      hint: 'Install Codex CLI from openai/codex, then run `codex /status` to verify auth',
      detailLines: [],
    };
  }
  const version = await Promise.resolve(versionProbe(resolvedPath, timeoutMs));
  return {
    installed: true,
    version,
    authenticated: null,
    hint: 'Run `codex /status` to verify auth, or open codex',
    detailLines: [`bin: ${resolvedPath}`],
  };
}

async function removeManagedCodexScript(path, predicate) {
  if (!existsSync(path)) return false;
  let body = '';
  try {
    body = await readFile(path, 'utf8');
  } catch {
    return false;
  }
  if (!predicate(body)) return false;
  await rm(path, { force: true });
  return true;
}

function isManagedCodexLauncher(body) {
  return /\bmemoro-cli\b/.test(body) && /\bcodex\s+run\b/.test(body) && /--real-codex\b/.test(body);
}

function isManagedCodexShim(body, launcherPath) {
  return body.includes('codex-memoro') || body.includes(launcherPath);
}

// ─────────────────────────────────────────────────────────────
// Legacy vault materialisation surface.
//
// Native Codex auth remains owned by Codex. mc never converts a vault secret
// into ~/.codex/auth.json or an environment variable.
// ─────────────────────────────────────────────────────────────

const CODEX_HOME_DIR = () => process.env.CODEX_HOME || join(homedir(), '.codex');

export function tokenLocations() {
  return [];
}

export async function materializeToken({ token, location, sessionId, deps = {} } = {}) {
  return { ok: false, reason: 'plaintext-materialisation-disabled' };
}

export async function shredToken({ location, sessionId, deps = {} } = {}) {
  if (!location || typeof location !== 'object') {
    return { ok: false, reason: 'location required' };
  }
  if (location.type !== 'file') {
    return { ok: true, removed: false, reason: location.type };
  }
  return shredFile(location.path, { deps });
}

/**
 * Transcript dialect: Codex rollout JSONL. Metadata arrives in dedicated
 * session_meta / turn_context records; messages and tool calls are
 * response_item payloads. Redaction stays central in src/lib/distill.js.
 */
export const TRANSCRIPT_DIALECT = Object.freeze({
  provider: 'openai',
  meta(entry) {
    if (entry.type === 'session_meta' && entry.payload) {
      const payload = entry.payload;
      return {
        sessionId: payload.id || null,
        cwd: payload.cwd || null,
        toolVersion: payload.cli_version || null,
        modelProvider: payload.model_provider || null,
        originator: payload.originator || null,
        clientSource: payload.source || null,
      };
    }
    if (entry.type === 'turn_context' && entry.payload) {
      return { modelName: entry.payload.model || null };
    }
    return null;
  },
  message(entry) {
    if (entry.type === 'response_item' && entry.payload?.type === 'message') {
      return { role: entry.payload.role || null, content: entry.payload.content };
    }
    return null;
  },
  toolCalls(entry) {
    if (entry.type === 'response_item' && entry.payload?.type === 'function_call') {
      return [{
        name: entry.payload.name || 'unknown',
        input: parseArgumentsJson(entry.payload.arguments),
      }];
    }
    return [];
  },
});

function parseArgumentsJson(raw) {
  if (!raw || typeof raw !== 'string') return {};
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

/** Transcript discovery: where Codex keeps native rollout transcripts. */
export const TRANSCRIPT_DISCOVERY = Object.freeze({
  findLatest: (options) => findLatestCodexSession(options),
  findById: (options) => findCodexSessionById(options),
});

/**
 * Declarative artifact-ownership profile: where THIS tool keeps
 * session-owned artifacts on disk and how its transcript paths encode
 * the session id. All inspection, scanning, and deletion machinery stays
 * central in src/mc/tool-artifact-ownership.js — the profile only names
 * exact locations and shapes.
 */
export const ARTIFACT_OWNERSHIP = Object.freeze({
  homeEnv: 'CODEX_HOME',
  homeDir: '.codex',
  layout(providerRoot, { join }) {
    return {
      transcript_roots: [
        join(providerRoot, 'sessions'),
        join(providerRoot, 'archived_sessions'),
      ],
      generated_images_root: join(providerRoot, 'generated_images'),
      shell_snapshots_root: join(providerRoot, 'shell_snapshots'),
      negative_roots: [
        providerRoot,
        join(providerRoot, 'history.jsonl'),
        join(providerRoot, 'session_index.jsonl'),
        join(providerRoot, 'state_5.sqlite'),
        join(providerRoot, 'logs_2.sqlite'),
        join(providerRoot, 'goals_1.sqlite'),
        join(providerRoot, 'memories_1.sqlite'),
        join(providerRoot, 'memories'),
        join(providerRoot, 'config.toml'),
        join(providerRoot, 'auth.json'),
      ],
    };
  },
  sessionDirectories({ sessionId, roots, join }) {
    return [{
      kind: 'codex-generated-images',
      path: join(roots.generated_images_root, sessionId),
      root: roots.generated_images_root,
      providerRoot: roots.provider_root,
      expected: 'directory',
    }];
  },
  sessionFilePatterns({ sessionId, roots, escapeRegExp }) {
    return [{
      kind: 'codex-shell-snapshot',
      root: roots.shell_snapshots_root,
      pattern: new RegExp(`^${escapeRegExp(sessionId)}\\.[0-9]+\\.sh$`),
    }];
  },
  transcriptLayoutMatches({ sessionId, parts, transcriptRootName }) {
    const file = parts.at(-1);
    if (!file?.startsWith('rollout-') || !file.endsWith(`-${sessionId}.jsonl`)) return false;
    if (transcriptRootName === 'archived_sessions') return parts.length === 1;
    return parts.length === 4
      && /^\d{4}$/.test(parts[0])
      && /^\d{2}$/.test(parts[1])
      && /^\d{2}$/.test(parts[2]);
  },
  transcriptHeadSessionId(entry) {
    return entry?.type === 'session_meta' ? entry?.payload?.id || null : null;
  },
});

/**
 * Native-custody launch lifecycle — see the claude-code adapter for the
 * contract shape. Flags declare which launcher-owned machinery applies.
 */
export const NATIVE_LAUNCH_HOOKS = Object.freeze({
  hookFailureReason: 'codex-provider-artifact-hook-unavailable',
  hookFailureLabel: 'Codex',
  // Cloud launches must prepare Codex auth (device flow) pre-spawn.
  cloudAuthPrepare: true,
  // Codex egress goes through the Cloudflare guard in native custody.
  cloudflareGuard: true,
  // Codex occasionally loses the sqlite startup race; the launcher owns
  // the bounded retry.
  sqliteStartupRetry: true,
  // Right before spawn, once the spawn env (CODEX_HOME) is final.
  async prepareSpawn({ spawnEnv, deps = {} } = {}) {
    await (deps.installCodexArtifactHooks || installHooks)({
      ...(spawnEnv?.CODEX_HOME ? { codexHome: spawnEnv.CODEX_HOME } : {}),
    });
  },
});
