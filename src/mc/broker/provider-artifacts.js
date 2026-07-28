import {
  closeSync, constants, fstatSync, lstatSync, openSync, readSync, realpathSync,
} from 'node:fs';
import { basename, dirname, isAbsolute, join, relative } from 'node:path';
import { CLAUDE_PROJECTS_DIR, encodeClaudeProjectPath } from '../../lib/claude.js';
import { CODEX_SESSIONS_DIR } from '../../lib/codex.js';

const ID = /^[A-Za-z0-9._:-]{1,128}$/;
const READ_NOFOLLOW = constants.O_RDONLY | (constants.O_NOFOLLOW || 0);
const META_BYTES = 64 * 1024;

/** Validate Claude's SessionStart evidence without opening the transcript. */
export function validateClaudeProviderArtifact({ cwd, providerSessionId, transcriptPath } = {}, {
  projectsDir = CLAUDE_PROJECTS_DIR,
  realpath = realpathSync,
  lstat = lstatSync,
  open = openSync,
  fstat = fstatSync,
  close = closeSync,
} = {}) {
  if (!ID.test(providerSessionId || '') || typeof cwd !== 'string' || !cwd || typeof transcriptPath !== 'string' || !transcriptPath) {
    return { ok: false, reason: 'invalid-artifact-input' };
  }
  let workspace;
  let expectedDir;
  let actualPath;
  let before;
  let fd = null;
  try {
    workspace = realpath(cwd);
    expectedDir = realpath(join(projectsDir, encodeClaudeProjectPath(workspace)));
    before = lstat(transcriptPath);
    if (!regularFile(before)) return { ok: false, reason: 'artifact-not-regular-file' };
    actualPath = realpath(transcriptPath);
    fd = open(transcriptPath, READ_NOFOLLOW);
    const opened = fstat(fd);
    if (!regularFile(opened) || !sameNode(before, opened)) {
      return { ok: false, reason: 'artifact-path-raced' };
    }
  } catch {
    return { ok: false, reason: 'artifact-path-unavailable' };
  } finally {
    if (fd !== null) try { close(fd); } catch {}
  }
  if (dirname(actualPath) !== expectedDir || actualPath !== join(expectedDir, `${providerSessionId}.jsonl`)) {
    return { ok: false, reason: 'artifact-path-mismatch' };
  }
  return { ok: true, transcriptPath: actualPath, workspace };
}

/**
 * Validate provider-owned Codex SessionStart evidence. The hook gives us the
 * exact transcript path and native session id, so no directory scan or
 * "latest file" heuristic is involved.
 */
export function validateCodexProviderArtifact({ cwd, providerSessionId, transcriptPath } = {}, {
  sessionsDir = CODEX_SESSIONS_DIR,
  realpath = realpathSync,
  lstat = lstatSync,
  open = openSync,
  fstat = fstatSync,
  read = readSync,
  close = closeSync,
} = {}) {
  if (!ID.test(providerSessionId || '')
    || typeof cwd !== 'string' || !cwd
    || typeof transcriptPath !== 'string' || !isAbsolute(transcriptPath)) {
    return { ok: false, reason: 'invalid-artifact-input' };
  }

  let workspace;
  let root;
  let actualPath;
  let before;
  let fd = null;
  let meta;
  try {
    workspace = realpath(cwd);
    root = realpath(sessionsDir);
    before = lstat(transcriptPath);
    if (!regularFile(before)) return { ok: false, reason: 'artifact-not-regular-file' };
    actualPath = realpath(transcriptPath);
    const rel = relative(root, actualPath);
    if (!rel || rel.startsWith('..') || isAbsolute(rel)
      || !basename(actualPath).endsWith(`-${providerSessionId}.jsonl`)) {
      return { ok: false, reason: 'artifact-path-mismatch' };
    }
    fd = open(transcriptPath, READ_NOFOLLOW);
    const opened = fstat(fd);
    if (!regularFile(opened) || !sameNode(before, opened)) {
      return { ok: false, reason: 'artifact-path-raced' };
    }
    meta = readCodexMeta(fd, { read });
  } catch {
    return { ok: false, reason: 'artifact-path-unavailable' };
  } finally {
    if (fd !== null) try { close(fd); } catch {}
  }
  if (meta?.sessionId !== providerSessionId) {
    return { ok: false, reason: 'artifact-native-id-mismatch' };
  }
  let metaWorkspace;
  try { metaWorkspace = realpath(meta.cwd); } catch {
    return { ok: false, reason: 'artifact-workspace-unavailable' };
  }
  if (metaWorkspace !== workspace) {
    return { ok: false, reason: 'artifact-workspace-mismatch' };
  }
  return { ok: true, transcriptPath: actualPath, workspace };
}

function readCodexMeta(fd, { read }) {
  const buffer = Buffer.alloc(META_BYTES);
  const count = read(fd, buffer, 0, buffer.length, 0);
  if (count <= 0) return null;
  const raw = buffer.subarray(0, count).toString('utf8');
  const line = raw.split('\n').find((value) => value.trim());
  if (!line) return null;
  const value = JSON.parse(line);
  if (value?.type !== 'session_meta' || !value.payload) return null;
  return {
    sessionId: value.payload.id,
    cwd: value.payload.cwd,
  };
}

function regularFile(stat) {
  return stat?.isFile?.() && !stat.isSymbolicLink?.();
}

function sameNode(left, right) {
  return left.dev === right.dev && left.ino === right.ino;
}
