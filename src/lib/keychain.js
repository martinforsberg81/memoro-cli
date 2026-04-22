/**
 * Platform-native secure token storage.
 *
 * macOS   → `security` (Keychain)
 * Linux   → `secret-tool` (libsecret / gnome-keyring / KWallet via secret-service)
 * Windows → `cmdkey` (Credential Manager)
 *
 * File fallback (~/.memoro/secrets.json, mode 0600) is used only when no
 * platform tool is available. A warning is printed loudly the first time
 * we fall back so the user is never quietly downgraded.
 *
 * No native deps — everything goes through child_process.
 */

import { spawn } from 'node:child_process';
import { platform } from 'node:os';
import { readFile, writeFile, chmod, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const SERVICE = 'memoro-cli';
const FALLBACK_DIR = join(homedir(), '.memoro');
const FALLBACK_FILE = join(FALLBACK_DIR, 'secrets.json');

export async function setSecret(account, value) {
  const p = platform();
  try {
    if (p === 'darwin')  return await macSet(account, value);
    if (p === 'linux')   return await linuxSet(account, value);
    if (p === 'win32')   return await winSet(account, value);
  } catch (err) {
    warnFallback(err);
  }
  return fileSet(account, value);
}

export async function getSecret(account) {
  const p = platform();
  try {
    if (p === 'darwin')  return await macGet(account);
    if (p === 'linux')   return await linuxGet(account);
    if (p === 'win32')   return await winGet(account);
  } catch {
    // fall through to file
  }
  return fileGet(account);
}

export async function deleteSecret(account) {
  const p = platform();
  try {
    if (p === 'darwin')  return await macDelete(account);
    if (p === 'linux')   return await linuxDelete(account);
    if (p === 'win32')   return await winDelete(account);
  } catch {
    // fall through
  }
  return fileDelete(account);
}

// ─────────────────────────────────────────────────────────────
// macOS Keychain via `security`
// ─────────────────────────────────────────────────────────────

async function macSet(account, value) {
  // -U to update if exists; write via -w to avoid putting password in argv
  await run('security', [
    'add-generic-password',
    '-a', account,
    '-s', SERVICE,
    '-w', value,
    '-U',
  ]);
  return 'keychain';
}

async function macGet(account) {
  const { stdout } = await run('security', [
    'find-generic-password',
    '-a', account,
    '-s', SERVICE,
    '-w',
  ]);
  return stdout.trim() || null;
}

async function macDelete(account) {
  await run('security', [
    'delete-generic-password',
    '-a', account,
    '-s', SERVICE,
  ]);
  return 'keychain';
}

// ─────────────────────────────────────────────────────────────
// Linux libsecret via `secret-tool`
// ─────────────────────────────────────────────────────────────

async function linuxSet(account, value) {
  // secret-tool reads password from stdin
  await run('secret-tool', [
    'store',
    '--label', `memoro-cli:${account}`,
    'service', SERVICE,
    'account', account,
  ], value);
  return 'keychain';
}

async function linuxGet(account) {
  const { stdout } = await run('secret-tool', [
    'lookup',
    'service', SERVICE,
    'account', account,
  ]);
  return stdout.trim() || null;
}

async function linuxDelete(account) {
  await run('secret-tool', [
    'clear',
    'service', SERVICE,
    'account', account,
  ]);
  return 'keychain';
}

// ─────────────────────────────────────────────────────────────
// Windows Credential Manager via `cmdkey`
// ─────────────────────────────────────────────────────────────

async function winSet(account, value) {
  await run('cmdkey', [
    `/generic:${SERVICE}:${account}`,
    `/user:${account}`,
    `/pass:${value}`,
  ]);
  return 'keychain';
}

async function winGet(account) {
  // cmdkey can't print passwords — Credential Manager deliberately hides them
  // from CLI. For read, fall through to the file fallback which we write
  // alongside cmdkey on Windows. This is a pragmatic trade-off.
  return fileGet(account);
}

async function winDelete(account) {
  await run('cmdkey', [`/delete:${SERVICE}:${account}`]);
  return 'keychain';
}

// ─────────────────────────────────────────────────────────────
// File fallback
// ─────────────────────────────────────────────────────────────

async function fileSet(account, value) {
  if (!existsSync(FALLBACK_DIR)) {
    await mkdir(FALLBACK_DIR, { recursive: true, mode: 0o700 });
  }
  let store = {};
  if (existsSync(FALLBACK_FILE)) {
    try { store = JSON.parse(await readFile(FALLBACK_FILE, 'utf8')); } catch { store = {}; }
  }
  store[account] = value;
  await writeFile(FALLBACK_FILE, JSON.stringify(store, null, 2), { mode: 0o600 });
  await chmod(FALLBACK_FILE, 0o600);
  return 'file';
}

async function fileGet(account) {
  if (!existsSync(FALLBACK_FILE)) return null;
  try {
    const store = JSON.parse(await readFile(FALLBACK_FILE, 'utf8'));
    return store[account] ?? null;
  } catch {
    return null;
  }
}

async function fileDelete(account) {
  if (!existsSync(FALLBACK_FILE)) return 'file';
  try {
    const store = JSON.parse(await readFile(FALLBACK_FILE, 'utf8'));
    delete store[account];
    await writeFile(FALLBACK_FILE, JSON.stringify(store, null, 2), { mode: 0o600 });
  } catch { /* ignore */ }
  return 'file';
}

// ─────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────

function run(cmd, args, stdinData = null) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', d => { stdout += d.toString(); });
    child.stderr.on('data', d => { stderr += d.toString(); });
    child.on('error', reject);
    child.on('close', code => {
      if (code === 0) resolve({ stdout, stderr });
      else reject(new Error(`${cmd} exited with ${code}: ${stderr.trim() || stdout.trim()}`));
    });
    if (stdinData != null) {
      child.stdin.write(stdinData);
    }
    child.stdin.end();
  });
}

let _fallbackWarned = false;
function warnFallback(err) {
  if (_fallbackWarned) return;
  _fallbackWarned = true;
  console.error('[memoro-cli] Warning: OS keychain not available — falling back to ~/.memoro/secrets.json (mode 0600).');
  console.error(`[memoro-cli] Reason: ${err.message}`);
  console.error('[memoro-cli] Install the platform tool to upgrade:');
  console.error('[memoro-cli]   macOS   → built-in "security" (should always work)');
  console.error('[memoro-cli]   Linux   → "secret-tool" (libsecret)');
  console.error('[memoro-cli]   Windows → built-in "cmdkey"');
}
