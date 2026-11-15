/**
 * Every folder mc opens agy in is trusted before agy starts, so no session
 * waits on its trust prompt.
 *
 * agy keeps the folders it trusts in `~/.gemini/antigravity-cli/settings.json`
 * as the `trustedWorkspaces` array. mc adds the folder's real path there and
 * nothing else: every other key is written back as read, the write is atomic,
 * an exact entry already present means no write, and a file mc cannot read as a
 * JSON object is left untouched (the launch goes on; agy asks the person).
 * `--settings` is not used: it would replace the person's own file.
 */
import * as fs from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

export function agySettingsPath(env = process.env, home = homedir()) {
  return join(env.HOME || home, '.gemini', 'antigravity-cli', 'settings.json');
}

function realFolder(path, io) {
  try { return io.realpathSync(path); } catch { return resolve(path); }
}

/** Returns { ok, folder, changed } or { ok: false, reason }; never throws. */
export function trustAgyFolder(cwd, { env = process.env, io = fs } = {}) {
  const folder = realFolder(cwd, io);
  const path = agySettingsPath(env);
  try {
    let settings = {};
    let mode = 0o600;
    try {
      const text = io.readFileSync(path, 'utf8');
      try { mode = io.statSync(path).mode & 0o777; } catch { /* keep the private default */ }
      settings = JSON.parse(text);
    } catch (error) {
      if (error instanceof SyntaxError) return { ok: false, folder, reason: `${path} is not JSON; left untouched` };
      if (error.code !== 'ENOENT') return { ok: false, folder, reason: `could not read ${path}: ${error.code || 'unreadable'}` };
    }
    if (!settings || typeof settings !== 'object' || Array.isArray(settings)) return { ok: false, folder, reason: `${path} is not a JSON object; left untouched` };
    const have = settings.trustedWorkspaces;
    if (have !== undefined && !Array.isArray(have)) return { ok: false, folder, reason: `trustedWorkspaces in ${path} is not a list; left untouched` };
    if ((have || []).includes(folder)) return { ok: true, folder, changed: false };
    const next = { ...settings, trustedWorkspaces: [...(have || []), folder] };
    io.mkdirSync(join(path, '..'), { recursive: true });
    const temporary = `${path}.mc-${process.pid}.tmp`;
    io.writeFileSync(temporary, `${JSON.stringify(next, null, 2)}\n`, { mode, flag: 'w' });
    io.renameSync(temporary, path);
    return { ok: true, folder, changed: true };
  } catch (error) {
    return { ok: false, folder, reason: `could not record agy trust in ${path}: ${error.message || error.code}` };
  }
}
