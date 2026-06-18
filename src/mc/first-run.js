/**
 * First-run friendliness (§11d).
 *
 * Trigger: `${MC_HOME}/.setup-done-v1` is missing AND no Memoro token
 * is stored in the keychain. Both signals must miss — migrants who
 * already ran `memoro-cli login` before mc setup existed get a quiet
 * sentinel-write on first successful `mc new`, never the hint.
 *
 * The hint is a friendly wrapper over the otherwise-cryptic
 * "token missing" failure path that hits new users in `mc new` /
 * `mc list`. It is NEVER an auto-trigger: we print and exit (or
 * print and continue, depending on the caller), we don't spawn
 * `mc setup` for the user.
 *
 * Token check is keychain-existence-only — no network validation in
 * the hot path. A token that exists but is revoked still counts as
 * "user has been through onboarding once".
 */
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { mcHome } from './paths.js';
import { getSecret } from '../lib/keychain.js';
import { ACCOUNTS } from '../commands/auth.js';

const SENTINEL_NAME = '.setup-done-v1';
const HINT_TEXT = 'New to mc? Run `mc` to sign in, then `mc setup` to finish local setup.';

export function sentinelPath() {
  return join(mcHome(), SENTINEL_NAME);
}

export function sentinelExists() {
  return existsSync(sentinelPath());
}

/**
 * Idempotent. Writes the sentinel only when missing; never throws
 * (filesystem permission failures degrade silently — the sentinel is
 * a hint, not a gate).
 */
export function ensureSentinel() {
  try {
    const path = sentinelPath();
    if (existsSync(path)) return false;
    mkdirSync(mcHome(), { recursive: true, mode: 0o700 });
    writeFileSync(path, new Date().toISOString() + '\n', { mode: 0o600 });
    return true;
  } catch { return false; }
}

/**
 * True when both signals miss: no sentinel AND no token. The
 * token-existence check goes through the same keychain layer the
 * rest of the CLI uses; on macOS that means the OS keychain, on
 * Linux secret-tool / libsecret, on Windows the file fallback.
 */
export async function isFreshInstall() {
  if (sentinelExists()) return false;
  try {
    const token = await getSecret(ACCOUNTS.TOKEN);
    return !token;
  } catch {
    // Probe failure → treat as token-absent. Best the user gets is
    // an unnecessary hint; never a missed friendly message.
    return true;
  }
}

export function freshInstallHintText() {
  return HINT_TEXT;
}

/**
 * Convenience for callers that want to short-circuit on fresh install:
 *   const fresh = await checkAndPrintFreshInstall();
 *   if (fresh) return 1;
 *
 * Prints the exact `freshInstallHintText()` to stderr (one line) and
 * returns true. The caller decides whether to bail or continue.
 */
export async function checkAndPrintFreshInstall() {
  if (!(await isFreshInstall())) return false;
  process.stderr.write(`mc: ${HINT_TEXT}\n`);
  return true;
}
