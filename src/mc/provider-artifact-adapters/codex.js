import {
  closeSync, constants, fstatSync, lstatSync, openSync, readSync, readdirSync,
  realpathSync,
} from 'node:fs';
import {
  basename, isAbsolute, join, relative,
} from 'node:path';

import { CODEX_SESSIONS_DIR } from '../../lib/codex.js';

export const TOOL_ID = 'codex';

const ID = /^[A-Za-z0-9._:-]{1,128}$/;
const READ_NOFOLLOW = constants.O_RDONLY | (constants.O_NOFOLLOW || 0);
const META_BYTES = 64 * 1024;
const MAX_TRANSCRIPT_ENTRIES = 4096;

export function captureContext({ provider, input } = {}) {
  const providerHome = stringOrNull(provider?.env?.CODEX_HOME)
    || stringOrNull(input?.env?.CODEX_HOME)
    || stringOrNull(process.env.CODEX_HOME);
  return Object.freeze({
    sessions_dir: providerHome
      ? `${providerHome.replace(/\/+$/, '')}/sessions`
      : null,
  });
}

/** Validate one exact provider-owned Codex transcript and native session id. */
export function validate({ evidence, context } = {}, {
  sessionsDir = stringOrNull(context?.sessions_dir) || CODEX_SESSIONS_DIR,
  realpath = realpathSync,
  lstat = lstatSync,
  open = openSync,
  fstat = fstatSync,
  read = readSync,
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
    || !isAbsolute(transcriptPath)) {
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

/**
 * Discover the exact Codex artifact from a private sessions tree owned by one
 * managed credential domain. The broker calls this after provider output (and
 * once more at exit), so provider identity capture does not require a Codex
 * command hook or any hook-trust override.
 */
export function observe({ context, cwd } = {}, {
  realpath = realpathSync,
  lstat = lstatSync,
  readdir = readdirSync,
  open = openSync,
  fstat = fstatSync,
  read = readSync,
  close = closeSync,
} = {}) {
  const sessionsDir = stringOrNull(context?.sessions_dir);
  const expectedProviderSessionId = stringOrNull(
    context?.expected_provider_session_id,
  );
  if (!sessionsDir
    || !isAbsolute(sessionsDir)
    || typeof cwd !== 'string'
    || !cwd
    || (expectedProviderSessionId && !ID.test(expectedProviderSessionId))) {
    return { ok: false, reason: 'provider-artifact-observation-context-invalid' };
  }

  let workspace;
  let root;
  let paths;
  try {
    workspace = realpath(cwd);
    const rootInfo = lstat(sessionsDir);
    if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) {
      return { ok: false, reason: 'provider-artifact-observation-tree-unsafe' };
    }
    root = realpath(sessionsDir);
    if (root !== sessionsDir) {
      return { ok: false, reason: 'provider-artifact-observation-tree-unsafe' };
    }
    paths = listTranscriptPaths(root, {
      realpath,
      lstat,
      readdir,
    });
  } catch (error) {
    return error?.code === 'ENOENT'
      ? { ok: false, reason: 'provider-artifact-not-observed' }
      : { ok: false, reason: 'provider-artifact-observation-unavailable' };
  }

  const candidates = [];
  for (const transcriptPath of paths) {
    let fd = null;
    let meta;
    try {
      const before = lstat(transcriptPath);
      if (!regularFile(before)) continue;
      fd = open(transcriptPath, READ_NOFOLLOW);
      const opened = fstat(fd);
      if (!regularFile(opened) || !sameNode(before, opened)) continue;
      meta = readCodexMeta(fd, { read });
    } catch {
      continue;
    } finally {
      if (fd !== null) try { close(fd); } catch {}
    }
    if (!meta
      || (expectedProviderSessionId
        && meta.sessionId !== expectedProviderSessionId)) continue;
    let metaWorkspace;
    try { metaWorkspace = realpath(meta.cwd); } catch { continue; }
    if (metaWorkspace !== workspace) continue;
    const checked = validate({
      evidence: {
        cwd,
        providerSessionId: meta.sessionId,
        transcriptPath,
      },
      context,
    }, {
      realpath,
      lstat,
      open,
      fstat,
      read,
      close,
    });
    if (checked.ok) {
      candidates.push({
        cwd,
        providerSessionId: meta.sessionId,
        transcriptPath: checked.transcriptPath,
      });
    }
  }
  if (candidates.length === 0) {
    return { ok: false, reason: 'provider-artifact-not-observed' };
  }
  if (candidates.length !== 1) {
    return { ok: false, reason: 'provider-artifact-observation-ambiguous' };
  }
  return { ok: true, evidence: candidates[0] };
}

function listTranscriptPaths(root, {
  realpath,
  lstat,
  readdir,
}) {
  const paths = [];
  const pending = [root];
  let entries = 0;
  while (pending.length) {
    const directory = pending.pop();
    for (const entry of readdir(directory)) {
      entries += 1;
      if (entries > MAX_TRANSCRIPT_ENTRIES) {
        throw new Error('provider artifact observation tree is oversized');
      }
      const path = join(directory, entry);
      const info = lstat(path);
      if (info.isSymbolicLink()) {
        throw new Error('provider artifact observation tree contains a symlink');
      }
      const actualPath = realpath(path);
      const rel = relative(root, actualPath);
      if (!rel || rel.startsWith('..') || isAbsolute(rel)) {
        throw new Error('provider artifact observation path escaped its root');
      }
      if (info.isDirectory()) {
        pending.push(actualPath);
      } else if (info.isFile() && entry.endsWith('.jsonl')) {
        paths.push(actualPath);
      } else if (!info.isFile()) {
        throw new Error('provider artifact observation tree contains a special file');
      }
    }
  }
  return paths.sort();
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

function stringOrNull(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}
