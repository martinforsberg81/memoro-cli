import {
  closeSync, constants, fstatSync, lstatSync, openSync, realpathSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';

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
  let fd = null;
  try {
    // The workspace and the projects root both exist — the broker set the cwd
    // and Claude has been installed — so they resolve. The per-workspace subdir
    // and the transcript itself may not: Claude Code creates the transcript on
    // the first user turn, which is after SessionStart, when this evidence is
    // captured. The expected path is therefore built from the resolved roots
    // plus the encoded workspace, not by resolving a file that isn't there yet.
    workspace = realpath(cwd);
    const projectsRoot = realpath(projectsDir);
    const expectedDir = join(projectsRoot, encodeClaudeProjectPath(workspace));
    const expectedTranscript = join(expectedDir, `${providerSessionId}.jsonl`);

    let before;
    try {
      before = lstat(transcriptPath);
    } catch (error) {
      if (error?.code !== 'ENOENT') return { ok: false, reason: 'artifact-path-unavailable' };
      // Pending transcript. Its path is fully constrained by the broker-set
      // workspace and Claude's own session id, so it cannot point elsewhere;
      // accept the declared path when it matches the expected one exactly.
      // Delivery is confirmed by that binding, never by the file's contents.
      if (resolve(transcriptPath) !== resolve(expectedTranscript)) {
        return { ok: false, reason: 'artifact-path-mismatch' };
      }
      return { ok: true, transcriptPath: expectedTranscript, workspace, pending: true };
    }

    // The transcript already exists: keep the strict physical check as
    // defense in depth against a symlinked or swapped path.
    if (!regularFile(before)) return { ok: false, reason: 'artifact-not-regular-file' };
    const actualPath = realpath(transcriptPath);
    fd = open(transcriptPath, READ_NOFOLLOW);
    const opened = fstat(fd);
    if (!regularFile(opened) || !sameNode(before, opened)) {
      return { ok: false, reason: 'artifact-path-raced' };
    }
    const resolvedDir = realpath(expectedDir);
    if (dirname(actualPath) !== resolvedDir
      || actualPath !== join(resolvedDir, `${providerSessionId}.jsonl`)) {
      return { ok: false, reason: 'artifact-path-mismatch' };
    }
    return { ok: true, transcriptPath: actualPath, workspace };
  } catch {
    return { ok: false, reason: 'artifact-path-unavailable' };
  } finally {
    if (fd !== null) try { close(fd); } catch {}
  }
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
