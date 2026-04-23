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
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';
import { upsertManagedBlock, removeManagedBlock } from '../lib/managed-block.js';
import {
  resolveWorkspaceRoot,
  ensureCodexAgentsIgnored,
  resolveRealCodexBinary,
} from '../lib/codex.js';

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

export function detect() {
  return existsSync(join(homedir(), '.codex'));
}

function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'\"'\"'`)}'`;
}
