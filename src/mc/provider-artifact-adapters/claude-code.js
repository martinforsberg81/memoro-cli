import {
  closeSync, constants, fstatSync, lstatSync, openSync, realpathSync,
} from 'node:fs';
import { dirname, join } from 'node:path';

import { CLAUDE_PROJECTS_DIR, encodeClaudeProjectPath } from '../../lib/claude.js';

export const TOOL_ID = 'claude-code';

const ID = /^[A-Za-z0-9._:-]{1,128}$/;
const READ_NOFOLLOW = constants.O_RDONLY | (constants.O_NOFOLLOW || 0);

export function captureContext({ provider, input } = {}) {
  const configDir = stringOrNull(provider?.env?.CLAUDE_CONFIG_DIR)
    || stringOrNull(input?.env?.CLAUDE_CONFIG_DIR)
    || stringOrNull(process.env.CLAUDE_CONFIG_DIR);
  return Object.freeze({
    projects_dir: configDir
      ? join(configDir.replace(/\/+$/u, ''), 'projects')
      : null,
  });
}

/** Validate Claude's SessionStart evidence without opening the transcript. */
export function validate({ evidence, context } = {}, {
  projectsDir = stringOrNull(context?.projects_dir) || CLAUDE_PROJECTS_DIR,
  realpath = realpathSync,
  lstat = lstatSync,
  open = openSync,
  fstat = fstatSync,
  close = closeSync,
} = {}) {
  const {
    cwd,
    providerSessionId,
    transcriptPath,
  } = evidence || {};
  if (!ID.test(providerSessionId || '')
    || typeof cwd !== 'string'
    || !cwd
    || typeof transcriptPath !== 'string'
    || !transcriptPath) {
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
  if (dirname(actualPath) !== expectedDir
    || actualPath !== join(expectedDir, `${providerSessionId}.jsonl`)) {
    return { ok: false, reason: 'artifact-path-mismatch' };
  }
  return { ok: true, transcriptPath: actualPath, workspace };
}

function regularFile(stat) {
  return stat?.isFile?.() && !stat.isSymbolicLink?.();
}

function sameNode(left, right) {
  return left.dev === right.dev && left.ino === right.ino;
}

function stringOrNull(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}
