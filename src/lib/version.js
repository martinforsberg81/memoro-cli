/**
 * Read the installed memoro-cli version from package.json.
 *
 * Cached in-process so repeated callers within one invocation share the
 * same I/O. Returns null if package.json can't be read (e.g. unusual install
 * layouts) — callers must tolerate that.
 */

import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

let cached = null;

export async function getPackageVersion() {
  if (cached) return cached;
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    const pkg = JSON.parse(await readFile(join(here, '../../package.json'), 'utf8'));
    cached = typeof pkg.version === 'string' ? pkg.version : null;
  } catch {
    cached = null;
  }
  return cached;
}

// Test-only — let unit tests reset the cache between sandboxed runs.
export function _resetVersionCache() {
  cached = null;
}
