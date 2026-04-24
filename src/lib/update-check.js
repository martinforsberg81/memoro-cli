/**
 * Update-availability check.
 *
 * Every invocation does two cheap things:
 *   1. Prints a one-line notice to stderr if the cached `latestVersion` in
 *      ~/.memoro/config.json is newer than the installed version AND stderr
 *      is a TTY (so slash commands / hooks / piped usage stay clean).
 *   2. Spawns a detached child that refreshes the cache from
 *      registry.npmjs.org if the cache is > 24h old. The main process does
 *      not wait for the child — startup cost is near zero.
 *
 * Disable entirely with MEMORO_NO_UPDATE_CHECK=1 (for CI, tight loops).
 */

import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { readConfig } from './config.js';

const PKG_NAME = 'memoro-cli';
const DISABLE_ENV = 'MEMORO_NO_UPDATE_CHECK';
const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000; // 24h

/**
 * Print a notice to stderr if the cached latest version is ahead of the
 * running version. Never throws, never blocks on the network.
 */
export async function showUpdateNoticeIfAvailable(currentVersion) {
  if (process.env[DISABLE_ENV]) return;
  if (!process.stderr.isTTY) return;

  let config;
  try {
    config = await readConfig();
  } catch {
    return;
  }

  const latest = config.latestVersion;
  if (typeof latest !== 'string' || !latest) return;
  if (!isSemverGreaterThan(latest, currentVersion)) return;

  process.stderr.write(
    `\n  ${PKG_NAME}: new version ${latest} available (you have ${currentVersion})\n` +
    `  run: npm update -g ${PKG_NAME}\n\n`,
  );
}

/**
 * Fire-and-forget a detached child that refreshes the cached latest
 * version from the npm registry — but only if the cache is stale.
 *
 * Spawning another Node process costs ~300ms on macOS, so the parent
 * checks staleness first to avoid paying that cost on every invocation.
 * The child re-checks staleness too, so it's still safe if the parent's
 * view races with another invocation.
 */
export async function spawnBackgroundUpdateCheck() {
  if (process.env[DISABLE_ENV]) return;

  let config;
  try {
    config = await readConfig();
  } catch {
    return;
  }

  const last = config.latestCheckedAt ? Date.parse(config.latestCheckedAt) : 0;
  if (Number.isFinite(last) && last > 0 && Date.now() - last < CHECK_INTERVAL_MS) return;

  try {
    const here = dirname(fileURLToPath(import.meta.url));
    const worker = join(here, 'update-check-worker.js');
    const child = spawn(process.execPath, [worker], {
      detached: true,
      stdio: 'ignore',
    });
    child.unref();
  } catch {
    // Silent — spawning the refresh is best-effort. Missing updates is a
    // cosmetic problem at worst.
  }
}

/**
 * Strict semver-major/minor/patch comparison. Pre-release tags are
 * ignored, which is fine for a notice whose only purpose is nudging the
 * user to update to a stable release.
 */
export function isSemverGreaterThan(a, b) {
  const av = parseVersion(a);
  const bv = parseVersion(b);
  if (!av || !bv) return false;
  if (av[0] !== bv[0]) return av[0] > bv[0];
  if (av[1] !== bv[1]) return av[1] > bv[1];
  return av[2] > bv[2];
}

function parseVersion(v) {
  if (typeof v !== 'string') return null;
  const base = v.split('-')[0].split('+')[0];
  const parts = base.split('.').map(x => Number(x));
  if (parts.length !== 3 || parts.some(n => !Number.isFinite(n) || n < 0)) return null;
  return parts;
}
