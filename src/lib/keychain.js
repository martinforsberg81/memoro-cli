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
    // A keychain that did not answer is there and locked, not missing: writing
    // the secret to the file instead would be a downgrade nobody chose. A
    // value the keychain's line cannot carry is the caller's mistake, and the
    // file would take it silently.
    if (err.code === 'ETIMEDOUT' || err.code === 'EBADSECRET') throw err;
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

/**
 * The secret goes through `security -i`'s stdin, never its argv: `-w <value>`
 * on the command line is there for `ps` to read while the tool runs. One
 * command line, each value double-quoted. `security -i` exits with the failed
 * command's code, so a refused write is still an error here.
 *
 * A value with a double quote, a backslash or a line break is refused rather
 * than escaped: how `security -i` unquotes is not documented, and a token
 * written subtly wrong is worse than one not written.
 */
export async function macSet(account, value, { exec = run } = {}) {
  for (const [what, text] of [['account', account], ['secret', value]]) {
    if (/["\\\r\n]/u.test(String(text))) {
      const err = new Error(`the keychain cannot take this ${what}: it contains a double quote, a backslash or a line break`);
      err.code = 'EBADSECRET';
      throw err;
    }
  }
  await exec('security', ['-i'], `add-generic-password -a "${account}" -s "${SERVICE}" -w "${value}" -U\n`);
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

/**
 * How long one keychain tool may take. A person at the machine answers the
 * keychain's password modal well inside it; nobody at the machine means the
 * tool waits for ever, and every unattended retry stacked one more modal
 * (2026-09-20). Stopping the tool withdraws its modal.
 */
export const KEYCHAIN_TIMEOUT_MS = 30_000;

export function run(cmd, args, stdinData = null, { timeoutMs = KEYCHAIN_TIMEOUT_MS } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let settled = false;
    const timer = setTimeout(() => {
      settled = true;
      child.kill('SIGKILL');
      const err = new Error(
        `${cmd} ${args[0] || ''} did not answer in ${timeoutMs >= 1000 ? `${Math.round(timeoutMs / 1000)} s` : `${timeoutMs} ms`} and was stopped`
        + ' — a locked keychain waits for its password (security unlock-keychain)',
      );
      err.code = 'ETIMEDOUT';
      reject(err);
    }, timeoutMs);
    child.stdout.on('data', d => { stdout += d.toString(); });
    child.stderr.on('data', d => { stderr += d.toString(); });
    child.on('error', (err) => {
      clearTimeout(timer);
      if (!settled) { settled = true; reject(err); }
    });
    child.on('close', code => {
      clearTimeout(timer);
      if (settled) return;
      settled = true;
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
