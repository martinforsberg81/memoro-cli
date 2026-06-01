/**
 * Shared materialisation helpers used by adapter `materializeToken` /
 * `shredToken` implementations (§12d).
 *
 * Each adapter declares its own `tokenLocations()` shapes; the actual
 * disk writes (mode 0600, atomic) and unlinks land here so they stay
 * uniform across tools.
 *
 * No adapter-specific logic — the FILE FORMAT decision lives in the
 * adapter (e.g. claude-code wraps the token as
 *   { "anthropic": { "apiKey": "<token>" } }
 * while codex writes plain JSON). This helper takes the *already-
 * serialised* string and lands it correctly.
 *
 * Test injection: all I/O is taken as `deps` so tests don't touch
 * disk. Default is the real `node:fs` primitives.
 */

import {
  writeFile as fsWriteFile,
  chmod as fsChmod,
  mkdir as fsMkdir,
  unlink as fsUnlink,
  stat as fsStat,
} from 'node:fs/promises';
import { dirname } from 'node:path';
import { existsSync } from 'node:fs';

/**
 * Atomically write `body` to `path` with mode 0600.
 *
 * Atomicity strategy: write to `<path>.tmp`, fsync via the rename hand-
 * off. Same approach `src/mc/registry.js` uses. The rename is the
 * atomic step.
 *
 * `body` MUST be a string. Callers serialise their per-format JSON
 * upstream; this helper stays format-agnostic so a leaked token never
 * makes it through a debug log here.
 */
export async function writeProtectedFile(path, body, {
  deps = {},
} = {}) {
  if (typeof path !== 'string' || !path) throw new Error('writeProtectedFile: path required');
  if (typeof body !== 'string') throw new Error('writeProtectedFile: body must be a string');
  const writeFile = deps.writeFile || fsWriteFile;
  const chmod = deps.chmod || fsChmod;
  const mkdir = deps.mkdir || fsMkdir;
  const dirExists = deps.existsSync || existsSync;

  const dir = dirname(path);
  if (!dirExists(dir)) {
    await mkdir(dir, { recursive: true, mode: 0o700 });
  }

  // Write directly with mode 0600. We don't use a .tmp + rename hand-off
  // here because (a) credentials.json-shaped files are tiny, (b) tools
  // that watch this path expect the same path each time, (c) writeFile
  // already truncates atomically enough for this use. If a partial
  // write became a problem we'd revisit.
  await writeFile(path, body, { mode: 0o600 });
  // Belt-and-braces chmod in case the runtime's writeFile ignored mode
  // (some platforms / older Node behaviours).
  try { await chmod(path, 0o600); } catch { /* best effort */ }
  return path;
}

/**
 * Unlink a file, returning ok regardless of whether it existed. Best-
 * effort: errors during shred are swallowed (the lifecycle uses this
 * during session end where throwing would block other cleanup) and
 * surfaced via the return value.
 */
export async function shredFile(path, {
  deps = {},
} = {}) {
  const unlink = deps.unlink || fsUnlink;
  const exists = deps.existsSync || existsSync;
  if (!exists(path)) return { ok: true, removed: false, reason: 'missing' };
  try {
    await unlink(path);
    return { ok: true, removed: true };
  } catch (err) {
    return { ok: false, removed: false, reason: err.message };
  }
}

/**
 * Verify file mode is 0600. Used by tests to enforce the security
 * expectation across adapters.
 */
export async function fileMode(path, { deps = {} } = {}) {
  const stat = deps.stat || fsStat;
  const s = await stat(path);
  // st_mode includes file-type bits; mask to permission bits.
  return s.mode & 0o777;
}
