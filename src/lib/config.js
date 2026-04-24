/**
 * Config file management — non-secret settings only.
 *
 * Secrets (such as the Memoro token) live in the OS keychain; see
 * ./keychain.js. This file holds everything else: API base URL, last
 * activity timestamps, installed hooks.
 *
 * Config path: ~/.memoro/config.json (mode 0600).
 */

import { readFile, writeFile, mkdir, chmod } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const CONFIG_DIR = join(homedir(), '.memoro');
const CONFIG_FILE = join(CONFIG_DIR, 'config.json');

const DEFAULT_CONFIG = {
  apiUrl: 'https://meetmemoro.app',
  lastSessionUploadAt: null,
  lastLensPullAt: null,
  installedHooks: {}, // { [tool]: { installedAt, configPath } }
  latestVersion: null,   // cached npm-registry latest (refreshed daily)
  latestCheckedAt: null, // ISO timestamp of last refresh attempt
};

export async function readConfig() {
  try {
    if (!existsSync(CONFIG_FILE)) return { ...DEFAULT_CONFIG };
    const raw = await readFile(CONFIG_FILE, 'utf8');
    return { ...DEFAULT_CONFIG, ...JSON.parse(raw) };
  } catch {
    return { ...DEFAULT_CONFIG };
  }
}

export async function writeConfig(config) {
  if (!existsSync(CONFIG_DIR)) {
    await mkdir(CONFIG_DIR, { recursive: true, mode: 0o700 });
  }
  await writeFile(CONFIG_FILE, JSON.stringify(config, null, 2), { mode: 0o600 });
  await chmod(CONFIG_FILE, 0o600);
}

export async function updateConfig(patch) {
  const current = await readConfig();
  const next = { ...current, ...patch };
  await writeConfig(next);
  return next;
}

export function getApiUrl(argv = []) {
  // Override via --api <url>
  const apiIdx = argv.indexOf('--api');
  if (apiIdx !== -1 && argv[apiIdx + 1]) return argv[apiIdx + 1];
  if (process.env.MEMORO_API_URL) return process.env.MEMORO_API_URL;
  return null; // caller falls back to config
}

export { CONFIG_DIR, CONFIG_FILE };
