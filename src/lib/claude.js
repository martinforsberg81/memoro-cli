import { readdir, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { resolveWorkspaceRoot } from './codex.js';

export const CLAUDE_HOME = process.env.CLAUDE_HOME || join(homedir(), '.claude');
export const CLAUDE_PROJECTS_DIR = join(CLAUDE_HOME, 'projects');

export function encodeClaudeProjectPath(workspacePath) {
  return String(workspacePath || '').replace(/[/.]/g, '-');
}

export async function findLatestClaudeSession({
  cwd = null,
  newerThanMs = 0,
  projectsDir = CLAUDE_PROJECTS_DIR,
} = {}) {
  const workspace = cwd ? resolveWorkspaceRoot(cwd) : null;
  if (!workspace) return null;

  const dir = join(projectsDir, encodeClaudeProjectPath(workspace));
  if (!existsSync(dir)) return null;

  let names;
  try {
    names = await readdir(dir);
  } catch {
    return null;
  }

  const stats = await Promise.all(
    names
      .filter((name) => name.endsWith('.jsonl'))
      .map(async (name) => {
        const path = join(dir, name);
        try {
          const info = await stat(path);
          return { path, mtimeMs: info.mtimeMs };
        } catch {
          return null;
        }
      }),
  );

  const latest = stats
    .filter(Boolean)
    .filter((entry) => entry.mtimeMs >= newerThanMs)
    .sort((a, b) => b.mtimeMs - a.mtimeMs)[0];

  if (!latest) return null;
  return {
    ...latest,
    cwd: workspace,
    sessionId: sessionIdFromPath(latest.path),
  };
}

export async function findClaudeSessionById({
  sessionId,
  cwd = null,
  projectsDir = CLAUDE_PROJECTS_DIR,
} = {}) {
  const workspace = cwd ? resolveWorkspaceRoot(cwd) : null;
  if (!workspace || !sessionId) return null;
  const path = join(projectsDir, encodeClaudeProjectPath(workspace), `${sessionId}.jsonl`);
  let info;
  try {
    info = await stat(path);
  } catch {
    return null;
  }
  return {
    path,
    mtimeMs: info.mtimeMs,
    cwd: workspace,
    sessionId,
  };
}

function sessionIdFromPath(path) {
  const name = String(path || '').split('/').pop() || '';
  return name.endsWith('.jsonl') ? name.slice(0, -'.jsonl'.length) : null;
}
