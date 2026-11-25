import { open, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { join, dirname, basename, sep } from 'node:path';
import { homedir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { run as runGit } from './git-process.js';

export const CODEX_HOME = process.env.CODEX_HOME || join(homedir(), '.codex');
export const CODEX_SESSIONS_DIR = join(CODEX_HOME, 'sessions');

export function resolveWorkspaceRoot(cwd = process.cwd()) {
  if (!cwd) return process.cwd();
  try {
    const r = runGit(undefined, ['-C', cwd, 'rev-parse', '--show-toplevel'], { stdio: ['ignore', 'pipe', 'ignore'] });
    if (r.error || r.status !== 0) return cwd;
    const out = String(r.stdout || '').trim();
    return out || cwd;
  } catch {
    return cwd;
  }
}

export function guessRepoHint(cwd = process.cwd()) {
  return basename(resolveWorkspaceRoot(cwd));
}

// npm's official Codex CLI: what `npm install -g @openai/codex` links into
// its bin directory, which with a user prefix is `~/.local/bin/codex`.
const OFFICIAL_CODEX_ENTRY = 'node_modules/@openai/codex/bin/codex.js';

export function isManagedCodexLauncher(body) {
  return /\bmemoro-cli\b/.test(body) && /\bcodex\s+run\b/.test(body) && /--real-codex\b/.test(body);
}

export function isManagedCodexShim(body, launcherPath) {
  return body.includes('codex-memoro') || body.includes(launcherPath);
}

function whichAllCodex() {
  return execFileSync('which', ['-a', 'codex'], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  });
}

// A candidate at one of mc's old wrapper paths is chosen only when it is npm's
// official CLI: its real path ends in the package's bin entry and its content
// is not an mc shim or launcher. Anything else there is skipped, so mc never
// recurses through its own wrapper.
function isOfficialCodexAt(path, launcherPath) {
  let real;
  let body;
  try {
    real = realpathSync(path);
    body = readFileSync(real, 'utf8');
  } catch {
    return false;
  }
  if (!real.split(sep).join('/').endsWith(`/${OFFICIAL_CODEX_ENTRY}`)) return false;
  return !isManagedCodexShim(body, launcherPath) && !isManagedCodexLauncher(body);
}

export function resolveRealCodexBinary({
  home = homedir(),
  wrapperPaths = [
    join(home, '.local', 'bin', 'codex'),
    join(home, '.local', 'bin', 'codex-memoro'),
  ],
  launcherPath = join(home, '.local', 'bin', 'codex-memoro'),
  which = whichAllCodex,
} = {}) {
  try {
    const paths = String(which() || '')
      .split('\n')
      .map(s => s.trim())
      .filter(Boolean);
    const chosen = paths.find(p => !wrapperPaths.includes(p) || isOfficialCodexAt(p, launcherPath));
    return chosen || null;
  } catch {
    return null;
  }
}

export async function findLatestCodexSession({ cwd = null, newerThanMs = 0, sessionsDir = CODEX_SESSIONS_DIR } = {}) {
  if (!existsSync(sessionsDir)) return null;
  const files = await listJsonlFiles(sessionsDir);
  const stats = await Promise.all(files.map(async (path) => {
    try {
      const info = await stat(path);
      return { path, mtimeMs: info.mtimeMs };
    } catch {
      return null;
    }
  }));

  const sorted = stats
    .filter(Boolean)
    .filter(entry => entry.mtimeMs >= newerThanMs)
    .sort((a, b) => b.mtimeMs - a.mtimeMs);

  const workspace = cwd ? resolveWorkspaceRoot(cwd) : null;
  for (const entry of sorted) {
    const meta = await readCodexSessionMeta(entry.path);
    if (!meta) continue;
    if (workspace && resolveWorkspaceRoot(meta.cwd || '') !== workspace) continue;
    return {
      path: entry.path,
      mtimeMs: entry.mtimeMs,
      sessionId: meta.sessionId,
      cwd: meta.cwd,
      startedAt: meta.startedAt,
      toolVersion: meta.toolVersion,
    };
  }

  return null;
}

export async function findCodexSessionById({
  sessionId,
  cwd = null,
  sessionsDir = CODEX_SESSIONS_DIR,
} = {}) {
  if (!sessionId || !existsSync(sessionsDir)) return null;
  const workspace = cwd ? resolveWorkspaceRoot(cwd) : null;
  const files = await listJsonlFiles(sessionsDir);
  for (const path of files) {
    const meta = await readCodexSessionMeta(path);
    if (!meta || meta.sessionId !== sessionId) continue;
    if (workspace && resolveWorkspaceRoot(meta.cwd || '') !== workspace) continue;
    let info;
    try {
      info = await stat(path);
    } catch {
      continue;
    }
    return {
      path,
      mtimeMs: info.mtimeMs,
      sessionId: meta.sessionId,
      cwd: meta.cwd,
      startedAt: meta.startedAt,
      toolVersion: meta.toolVersion,
    };
  }
  return null;
}

export async function readCodexSessionMeta(path) {
  try {
    const firstLine = await readFirstNonEmptyLine(path);
    if (!firstLine) return null;
    const entry = JSON.parse(firstLine);
    if (entry?.type !== 'session_meta' || !entry.payload) return null;
    return {
      sessionId: entry.payload.id || null,
      cwd: entry.payload.cwd || null,
      startedAt: entry.payload.timestamp || entry.timestamp || null,
      toolVersion: entry.payload.cli_version || null,
    };
  } catch {
    return null;
  }
}

async function readFirstNonEmptyLine(path, { maxBytes = 64 * 1024 } = {}) {
  const handle = await open(path, 'r');
  try {
    const buffer = Buffer.alloc(maxBytes);
    const { bytesRead } = await handle.read(buffer, 0, maxBytes, 0);
    if (bytesRead <= 0) return null;
    const raw = buffer.subarray(0, bytesRead).toString('utf8');
    return raw.split('\n').find(line => line.trim()) || null;
  } finally {
    await handle.close();
  }
}

export function parseCodexFunctionArgs(raw) {
  if (!raw || typeof raw !== 'string') return {};
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

async function listJsonlFiles(dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  const out = [];
  for (const entry of entries) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...await listJsonlFiles(path));
    } else if (entry.isFile() && entry.name.endsWith('.jsonl')) {
      out.push(path);
    }
  }
  return out;
}
