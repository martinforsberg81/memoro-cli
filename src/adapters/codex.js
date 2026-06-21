/**
 * Codex CLI adapter.
 *
 * Codex reads workspace-local `AGENTS.md` files. mc keeps that file as
 * static project instructions managed by `mc adapter sync`; per-session
 * grounding is delivered as the initial CLI prompt so the tracked wrapper
 * is not dirtied by runtime state and Codex does not open its resume picker
 * on an empty launch.
 */

import { readFile, writeFile, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { upsertManagedBlock, removeManagedBlock } from '../lib/managed-block.js';
import {
  resolveWorkspaceRoot,
  ensureCodexAgentsIgnored,
  resolveRealCodexBinary,
} from '../lib/codex.js';
import { writeProtectedFile, shredFile } from './_materialise.js';

const DEFAULT_LAUNCHER = join(homedir(), '.local', 'bin', 'codex-memoro');
const DEFAULT_SHIM = join(homedir(), '.local', 'bin', 'codex');

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
  launcherPath = DEFAULT_LAUNCHER,
  shimPath = DEFAULT_SHIM,
} = {}) {
  return {
    skipped: true,
    configPath: shimPath,
    reason: 'Codex is no longer wrapped at the raw `codex` command. Use `mc new --codex` or `mc resume <name> --codex` for Memoro sessions.',
    legacyCleanupHint: `Run \`memoro-cli hook uninstall --tool codex\` to remove an old ${launcherPath} shim.`,
  };
}

export async function uninstallHooks({
  launcherPath = DEFAULT_LAUNCHER,
  shimPath = DEFAULT_SHIM,
} = {}) {
  const removed = [];
  if (await removeManagedCodexScript(launcherPath, isManagedCodexLauncher)) {
    removed.push(launcherPath);
  }
  if (await removeManagedCodexScript(shimPath, (body) => isManagedCodexShim(body, launcherPath))) {
    removed.push(shimPath);
  }
  return { path: shimPath, removed };
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
  return {
    bin,
    args: (argv = [], { startupMessage = null, effectivePolicy = null } = {}) => {
      const base = [...argv];
      const policyArgs = renderPolicy(effectivePolicy).launchArgs;
      void startupMessage;
      return [...base, ...policyArgs];
    },
    heartbeatSource: 'codex',
    label: LABEL,
    installHint: 'Install Codex CLI from openai/codex (could not locate the codex binary)',
    startupMessageDelivery: 'deferred-pty',
    submitEnterCount: 2,
    submitEnterDelayMs: 150,
  };
}

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
// Token vault — JIT materialisation contract (§12d)
//
// Codex CLI reads `~/.codex/auth.json` for auth (verified by probing
// the keys on disk in drev 4 setup). Shape observed:
//   { auth_mode, OPENAI_API_KEY, tokens, last_refresh }
//
// mc materialises the api-key path only: writes `OPENAI_API_KEY` +
// `auth_mode: "apikey"` into the file at mode 0600. The OAuth
// `tokens` path (browser sign-in) is NOT materialised by mc — those
// tokens come from a different flow and live under a different vault
// kind once we add OAuth materialisation.
//
// `env` form is declared too (OPENAI_API_KEY) for completeness, but
// not directly writable by the mc parent; see the comment on the
// claude-code adapter.
// ─────────────────────────────────────────────────────────────

const CODEX_HOME_DIR = () => join(homedir(), '.codex');

export function tokenLocations() {
  return [
    {
      type: 'file',
      path: join(CODEX_HOME_DIR(), 'auth.json'),
      format: 'json',
      shape: 'codex-api-key-v1',
    },
  ];
}

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
  const body = JSON.stringify({
    auth_mode: 'apikey',
    OPENAI_API_KEY: token,
    tokens: null,
    last_refresh: new Date().toISOString(),
  });
  const path = await writeProtectedFile(location.path, body, { deps });
  return { ok: true, materializedPath: path };
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
