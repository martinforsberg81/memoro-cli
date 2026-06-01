/**
 * Codex CLI adapter.
 *
 * Codex reads workspace-local `AGENTS.md` files, but does not currently
 * expose Claude-style SessionStart / SessionEnd hook registration. So the
 * integration model is:
 *   - managed lens block in `<workspace>/AGENTS.md`
 *   - launcher script `codex-memoro` that runs `memoro-cli codex run`
 *   - a `~/.local/bin/codex` shim so normal `codex ...` usage becomes
 *     automatic when `~/.local/bin` is ahead of the real Codex binary
 */

import { readFile, writeFile, mkdir, chmod, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join, dirname } from 'node:path';
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

export async function installHooks({
  memoroCliBin = 'memoro-cli',
  launcherPath = DEFAULT_LAUNCHER,
  shimPath = DEFAULT_SHIM,
} = {}) {
  const realCodex = resolveRealCodexBinary({ wrapperPaths: [shimPath, launcherPath] });
  if (!realCodex) throw new Error('Could not locate the real Codex binary to wrap');

  await mkdir(dirname(launcherPath), { recursive: true, mode: 0o755 });
  const launcherScript = [
    '#!/bin/sh',
    `exec ${memoroCliBin} codex run --real-codex ${shellQuote(realCodex)} -- "$@"`,
    '',
  ].join('\n');
  await writeFile(launcherPath, launcherScript, { mode: 0o755 });
  try { await chmod(launcherPath, 0o755); } catch { /* best effort */ }

  const shimScript = [
    '#!/bin/sh',
    `exec ${shellQuote(launcherPath)} "$@"`,
    '',
  ].join('\n');
  await writeFile(shimPath, shimScript, { mode: 0o755 });
  try { await chmod(shimPath, 0o755); } catch { /* best effort */ }

  return shimPath;
}

export async function uninstallHooks({
  launcherPath = DEFAULT_LAUNCHER,
  shimPath = DEFAULT_SHIM,
} = {}) {
  if (existsSync(launcherPath)) await rm(launcherPath, { force: true });
  if (existsSync(shimPath)) await rm(shimPath, { force: true });
  return shimPath;
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

function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'\"'\"'`)}'`;
}

// ─────────────────────────────────────────────────────────────
// Token vault — JIT materialisation contract (§12d)
//
// Codex CLI reads `~/.codex/auth.json` for auth (verified by probing
// the keys on disk in drev 4 setup). Shape observed:
//   { auth_mode, OPENAI_API_KEY, tokens, last_refresh }
//
// mc materialises the api-key path only: writes `OPENAI_API_KEY` +
// `auth_mode: "ApiKey"` into the file at mode 0600. The OAuth
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
    auth_mode: 'ApiKey',
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
