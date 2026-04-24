/**
 * Detached worker that refreshes the cached "latest memoro-cli version"
 * from the npm registry. Invoked by update-check.js via spawn(detached).
 *
 * Never throws, never writes to stdout/stderr (parent's stdio is ignored
 * anyway). Runs its own staleness check so the parent can fire it
 * unconditionally.
 */

import { readConfig, updateConfig } from './config.js';

const REGISTRY_URL = 'https://registry.npmjs.org/memoro-cli/latest';
const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000; // 24h
const FETCH_TIMEOUT_MS = 5000;

async function main() {
  let config;
  try {
    config = await readConfig();
  } catch {
    return;
  }

  const last = config.latestCheckedAt ? Date.parse(config.latestCheckedAt) : 0;
  if (Number.isFinite(last) && Date.now() - last < CHECK_INTERVAL_MS) return;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

  let latest = null;
  try {
    const res = await fetch(REGISTRY_URL, {
      signal: controller.signal,
      headers: { 'Accept': 'application/json' },
    });
    if (res.ok) {
      const data = await res.json();
      if (data && typeof data.version === 'string') latest = data.version;
    }
  } catch {
    // Silent — offline, DNS failure, registry down, timeout, etc.
  } finally {
    clearTimeout(timer);
  }

  try {
    const patch = { latestCheckedAt: new Date().toISOString() };
    if (latest) patch.latestVersion = latest;
    await updateConfig(patch);
  } catch {
    // Silent.
  }
}

main().catch(() => { /* silent */ });
