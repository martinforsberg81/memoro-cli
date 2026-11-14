/**
 * Every folder mc opens Claude in is trusted before Claude starts (Martin,
 * 2026-11-14): no session waits on, or is refused for, a trust prompt.
 *
 * Claude keeps the answer to its trust dialog in its global config as
 * `projects[<folder>].hasTrustDialogAccepted`, and names that key as the
 * alternative to the dialog in its own refusal. It looks the folder up and
 * then walks towards the git root, so recording the launch folder itself is
 * enough. Claude writes that file under a `<file>.lock` directory lock
 * (proper-lockfile, 10 s stale); mc takes the same lock, merges one key and
 * replaces the file atomically. An existing record is never rewritten.
 */
import * as fs from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

const STALE_MS = 10_000;
const WAIT_MS = [5, 10, 20, 40, 80, 160, 320, 640, 1000, 1000, 1000, 1000];

export function claudeConfigPath(env = process.env, home = homedir()) {
  return env.CLAUDE_CONFIG_DIR ? join(env.CLAUDE_CONFIG_DIR, '.claude.json') : join(env.HOME || home, '.claude.json');
}

function realFolder(path, io) {
  try { return io.realpathSync(path); } catch { return resolve(path); }
}

function readConfig(path, io) {
  let text;
  try { text = io.readFileSync(path, 'utf8'); }
  catch (error) { if (error.code === 'ENOENT') return {}; throw error; }
  const config = JSON.parse(text);
  if (!config || typeof config !== 'object' || Array.isArray(config)) throw new Error('not a JSON object');
  return config;
}

const trusted = (config, folder) => config.projects?.[folder]?.hasTrustDialogAccepted === true;

function acquire(lock, { io, now, sleep }) {
  for (const wait of [...WAIT_MS, null]) {
    try { io.mkdirSync(lock); return true; }
    catch (error) {
      if (error.code !== 'EEXIST') throw error;
      let stale = false;
      try { stale = now() - io.statSync(lock).mtimeMs > STALE_MS; }
      catch (statError) { if (statError.code === 'ENOENT') continue; throw statError; }
      if (stale) { try { io.rmdirSync(lock); } catch {} continue; }
      if (wait === null) return false;
      sleep(wait);
    }
  }
  return false;
}

const blockingSleep = ms => { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); };

/** Returns { ok, folder, changed } or { ok: false, reason }; never throws. */
export function trustClaudeFolder(cwd, { env = process.env, io = fs, now = Date.now, sleep = blockingSleep } = {}) {
  const folder = realFolder(cwd, io);
  const path = claudeConfigPath(env);
  try {
    if (trusted(readConfig(path, io), folder)) return { ok: true, folder, changed: false };
    const lock = `${path}.lock`;
    if (!acquire(lock, { io, now, sleep })) return { ok: false, folder, reason: `Claude's config lock ${lock} stayed held` };
    try {
      const config = readConfig(path, io);
      if (trusted(config, folder)) return { ok: true, folder, changed: false };
      const projects = config.projects && typeof config.projects === 'object' ? config.projects : {};
      config.projects = { ...projects, [folder]: { ...projects[folder], hasTrustDialogAccepted: true } };
      let mode = 0o600;
      try { mode = io.statSync(path).mode & 0o777; } catch {}
      const temporary = `${path}.mc-${process.pid}.tmp`;
      io.writeFileSync(temporary, `${JSON.stringify(config, null, 2)}\n`, { mode, flag: 'w' });
      io.renameSync(temporary, path);
      return { ok: true, folder, changed: true };
    } finally { try { io.rmdirSync(lock); } catch {} }
  } catch (error) {
    return { ok: false, folder, reason: `could not record Claude trust in ${path}: ${error.message || error.code}` };
  }
}
