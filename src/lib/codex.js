import { readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, dirname, basename } from 'node:path';
import { homedir } from 'node:os';
import { execFileSync } from 'node:child_process';

export const CODEX_HOME = process.env.CODEX_HOME || join(homedir(), '.codex');
export const CODEX_SESSIONS_DIR = join(CODEX_HOME, 'sessions');

export function resolveWorkspaceRoot(cwd = process.cwd()) {
  if (!cwd) return process.cwd();
  try {
    const out = execFileSync('git', ['-C', cwd, 'rev-parse', '--show-toplevel'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    return out || cwd;
  } catch {
    return cwd;
  }
}

export function guessRepoHint(cwd = process.cwd()) {
  return basename(resolveWorkspaceRoot(cwd));
}

export function resolveRealCodexBinary({
  wrapperPaths = [
    join(homedir(), '.local', 'bin', 'codex'),
    join(homedir(), '.local', 'bin', 'codex-memoro'),
  ],
} = {}) {
  try {
    const out = execFileSync('which', ['-a', 'codex'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    const paths = out
      .split('\n')
      .map(s => s.trim())
      .filter(Boolean);
    const chosen = paths.find(p => !wrapperPaths.includes(p));
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

export async function readCodexSessionMeta(path) {
  try {
    const raw = await readFile(path, 'utf8');
    const firstLine = raw.split('\n').find(line => line.trim());
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

export function parseCodexFunctionArgs(raw) {
  if (!raw || typeof raw !== 'string') return {};
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

export async function ensureCodexAgentsIgnored(cwd = process.cwd()) {
  const root = resolveWorkspaceRoot(cwd);
  let excludePath = null;
  try {
    excludePath = execFileSync('git', ['-C', root, 'rev-parse', '--git-path', 'info/exclude'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return null;
  }

  if (!excludePath) return null;

  let existing = '';
  try {
    existing = await readFile(excludePath, 'utf8');
  } catch {
    // File may not exist yet.
  }
  if (/(^|\n)\/AGENTS\.md(\n|$)/.test(existing)) return excludePath;

  const next = existing.replace(/\s*$/, '');
  const suffix = next ? '\n/AGENTS.md\n' : '/AGENTS.md\n';
  await writeFile(excludePath, `${next}${suffix}`);
  return excludePath;
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
