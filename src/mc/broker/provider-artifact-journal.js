/**
 * Host-local proof that a provider-native transcript belongs to one exact
 * broker runtime generation.  It deliberately carries metadata only: never
 * transcript text, PTY data, command arguments, environment, or authority.
 */
import {
  chmodSync, closeSync, constants, fchmodSync, fstatSync, fsyncSync, linkSync,
  lstatSync, mkdirSync, openSync, readSync, rmSync, unlinkSync, writeFileSync,
} from 'node:fs';
import {
  basename, dirname, isAbsolute, join, relative, resolve,
} from 'node:path';
import { randomBytes } from 'node:crypto';

export const PROVIDER_ARTIFACT_SCHEMA = 'mc-provider-artifact-v1';
const MAX_BYTES = 4096;
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ID = /^[A-Za-z0-9._:-]{1,128}$/;
const TOOLS = new Set(['claude-code', 'codex']);
const READ_NOFOLLOW = constants.O_RDONLY | (constants.O_NOFOLLOW || 0);

export function buildProviderArtifact(input = {}) {
  const value = {
    schema: PROVIDER_ARTIFACT_SCHEMA,
    coding_session_id: input.codingSessionId,
    runtime_generation: input.runtimeGeneration,
    tool: input.tool,
    provider_session_id: input.providerSessionId,
    transcript_path: input.transcriptPath,
    captured_at: input.capturedAt,
  };
  const checked = validateProviderArtifact(value);
  if (!checked.ok) throw new TypeError(`invalid provider artifact: ${checked.reason}`);
  return value;
}

export function validateProviderArtifact(value) {
  if (!plain(value)) return invalid('not-object');
  const keys = Object.keys(value);
  const required = ['schema', 'coding_session_id', 'runtime_generation', 'tool', 'provider_session_id', 'transcript_path', 'captured_at'];
  if (keys.length !== required.length || keys.some((key) => !required.includes(key))) return invalid('unexpected-keys');
  if (value.schema !== PROVIDER_ARTIFACT_SCHEMA || !ID.test(value.coding_session_id || '')
    || !UUID_V4.test(value.runtime_generation || '') || !TOOLS.has(value.tool)
    || !ID.test(value.provider_session_id || '') || !absolutePath(value.transcript_path)
    || !iso(value.captured_at)) return invalid('invalid-fields');
  return { ok: true, value: { ...value } };
}

export function writeProviderArtifactSync({
  path,
  artifact,
  fs = syncFs,
  randomBytes: random = randomBytes,
  trustedRoot = null,
} = {}) {
  const checked = validateProviderArtifact(artifact);
  if (!checked.ok) throw new TypeError(`invalid provider artifact: ${checked.reason}`);
  if (typeof path !== 'string' || !path) throw new TypeError('provider artifact path is required');
  const directory = dirname(path);
  if (trustedRoot) {
    ensurePrivateDirectoryChain({ trustedRoot, directory, fs });
  } else {
    ensurePrivateDirectory(directory, fs);
  }
  const existing = readProviderArtifactSync({ path, fs, trustedRoot });
  if (existing.kind === 'present') {
    if (sameArtifact(existing.artifact, checked.value)) return { ok: true, duplicate: true, artifact: existing.artifact };
    throw new Error('provider artifact already bound to a different value');
  }
  if (existing.kind === 'unknown') throw new Error(`provider artifact journal is unsafe (${existing.reason})`);
  const temporary = join(directory, `.${basename(path)}.${random(16).toString('hex')}.tmp`);
  let fd = null;
  try {
    fd = fs.openSync(temporary, 'wx', 0o600);
    fs.writeFileSync(fd, `${JSON.stringify(checked.value)}\n`, 'utf8');
    fs.fsyncSync(fd); fs.fchmodSync(fd, 0o600); fs.closeSync(fd); fd = null;
    // A hard-link publication is atomic and, unlike rename(), never replaces
    // a racing writer's already-bound generation.
    fs.linkSync(temporary, path);
    fs.unlinkSync(temporary);
    if (trustedRoot) {
      const chain = privateDirectoryChainSafety({ trustedRoot, directory, fs });
      if (!chain.ok) throw new Error(`provider artifact directory chain is unsafe (${chain.reason})`);
    }
    fsyncDirectory(directory, fs);
    return { ok: true, duplicate: false, artifact: checked.value };
  } catch (error) {
    if (fd !== null) try { fs.closeSync(fd); } catch {}
    try { fs.rmSync(temporary, { force: true }); } catch {}
    if (error?.code === 'EEXIST') {
      const raced = readProviderArtifactSync({ path, fs, trustedRoot });
      if (raced.kind === 'present' && sameArtifact(raced.artifact, checked.value)) {
        return { ok: true, duplicate: true, artifact: raced.artifact };
      }
      throw new Error('provider artifact already bound to a different value');
    }
    throw error;
  }
}

export function readProviderArtifactSync({
  path,
  fs = syncFs,
  codingSessionId,
  runtimeGeneration,
  trustedRoot = null,
} = {}) {
  if (typeof path !== 'string' || !path) return unknown('invalid-path');
  let fd = null;
  try {
    const directory = dirname(path);
    const directorySafety = trustedRoot
      ? privateDirectoryChainSafety({ trustedRoot, directory, fs })
      : privateDirectorySafety(directory, fs);
    if (!directorySafety.ok) {
      return directorySafety.missing ? { kind: 'absent' } : unknown(directorySafety.reason);
    }
    const stat = fs.lstatSync(path);
    if (!privateRegularFile(stat)) return unknown('unsafe-file');
    fd = fs.openSync(path, READ_NOFOLLOW);
    const opened = fs.fstatSync(fd);
    if (!sameNode(stat, opened) || !privateRegularFile(opened)) return unknown('unsafe-file');
    if (trustedRoot) {
      const reopenedChain = privateDirectoryChainSafety({ trustedRoot, directory, fs });
      if (!reopenedChain.ok) return unknown(reopenedChain.reason);
    }
    const buffer = Buffer.alloc(MAX_BYTES + 1);
    const count = fs.readSync(fd, buffer, 0, buffer.length, 0);
    if (count > MAX_BYTES) return unknown('too-large');
    const raw = buffer.subarray(0, count).toString('utf8');
    const parsed = JSON.parse(raw);
    const checked = validateProviderArtifact(parsed);
    if (!checked.ok) return unknown(checked.reason);
    if (codingSessionId && parsed.coding_session_id !== codingSessionId) return unknown('session-mismatch');
    if (runtimeGeneration && parsed.runtime_generation !== runtimeGeneration) return unknown('generation-mismatch');
    return { kind: 'present', artifact: checked.value };
  } catch (error) {
    return error?.code === 'ENOENT' ? { kind: 'absent' } : unknown('unreadable');
  } finally {
    if (fd !== null) try { fs.closeSync(fd); } catch {}
  }
}

function sameArtifact(a, b) { return JSON.stringify(a) === JSON.stringify(b); }
function absolutePath(value) { return typeof value === 'string' && value.startsWith('/') && value.length <= 2048 && !/[\0-\x1f\x7f]/.test(value); }
function iso(value) {
  if (typeof value !== 'string') return false;
  const d = new Date(value);
  return Number.isFinite(d.getTime()) && d.toISOString() === value;
}
function plain(value) { return value && typeof value === 'object' && !Array.isArray(value) && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null); }
function invalid(reason) { return { ok: false, reason }; }
function unknown(reason) { return { kind: 'unknown', reason }; }

function ensurePrivateDirectory(path, fs) {
  try {
    const stat = fs.lstatSync(path);
    if (!stat.isDirectory?.() || stat.isSymbolicLink?.()) {
      throw new Error('provider artifact directory is unsafe (unsafe-directory)');
    }
    if (typeof process.getuid === 'function' && Number.isInteger(stat.uid) && stat.uid !== process.getuid()) {
      throw new Error('provider artifact directory is unsafe (unsafe-directory-owner)');
    }
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
    fs.mkdirSync(path, { recursive: true, mode: 0o700 });
  }
  try { fs.chmodSync(path, 0o700); } catch {}
  const safety = privateDirectorySafety(path, fs);
  if (!safety.ok) throw new Error(`provider artifact directory is unsafe (${safety.reason})`);
}

function privateDirectorySafety(path, fs) {
  try {
    const stat = fs.lstatSync(path);
    if (!stat.isDirectory?.() || stat.isSymbolicLink?.() || (stat.mode & 0o077) !== 0) {
      return { ok: false, reason: 'unsafe-directory' };
    }
    if (typeof process.getuid === 'function' && Number.isInteger(stat.uid) && stat.uid !== process.getuid()) {
      return { ok: false, reason: 'unsafe-directory-owner' };
    }
    return { ok: true };
  } catch (error) {
    return error?.code === 'ENOENT'
      ? { ok: false, missing: true, reason: 'missing-directory' }
      : { ok: false, reason: 'unreadable-directory' };
  }
}

function ensurePrivateDirectoryChain({ trustedRoot, directory, fs }) {
  const chain = resolveTrustedChain(trustedRoot, directory);
  if (!chain.ok) {
    throw new Error(`provider artifact directory chain is unsafe (${chain.reason})`);
  }
  for (const path of chain.paths) {
    const safety = privateDirectorySafety(path, fs);
    if (safety.ok) continue;
    if (!safety.missing) {
      throw new Error(`provider artifact directory chain is unsafe (${safety.reason})`);
    }
    try {
      fs.mkdirSync(path, { mode: 0o700 });
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
    }
    const created = privateDirectorySafety(path, fs);
    if (!created.ok) {
      throw new Error(`provider artifact directory chain is unsafe (${created.reason})`);
    }
  }
}

function privateDirectoryChainSafety({ trustedRoot, directory, fs }) {
  const chain = resolveTrustedChain(trustedRoot, directory);
  if (!chain.ok) return chain;
  for (const path of chain.paths) {
    const safety = privateDirectorySafety(path, fs);
    if (!safety.ok) return safety;
  }
  return { ok: true };
}

function resolveTrustedChain(trustedRoot, directory) {
  if (typeof trustedRoot !== 'string' || typeof directory !== 'string'
    || !isAbsolute(trustedRoot) || !isAbsolute(directory)
    || resolve(trustedRoot) !== trustedRoot || resolve(directory) !== directory) {
    return { ok: false, reason: 'invalid-directory-chain' };
  }
  const rel = relative(trustedRoot, directory);
  if (rel.startsWith('..') || isAbsolute(rel)) {
    return { ok: false, reason: 'directory-outside-trusted-root' };
  }
  const paths = [trustedRoot];
  if (rel) {
    let current = trustedRoot;
    for (const segment of rel.split('/')) {
      current = join(current, segment);
      paths.push(current);
    }
  }
  return { ok: true, paths };
}

function privateRegularFile(stat) {
  return stat.isFile?.()
    && !stat.isSymbolicLink?.()
    && (stat.mode & 0o077) === 0
    && (typeof process.getuid !== 'function' || !Number.isInteger(stat.uid) || stat.uid === process.getuid());
}

function sameNode(left, right) {
  return left.dev === right.dev && left.ino === right.ino;
}

function fsyncDirectory(path, fs) {
  let fd = null;
  try {
    fd = fs.openSync(path, constants.O_RDONLY);
    fs.fsyncSync(fd);
  } finally {
    if (fd !== null) fs.closeSync(fd);
  }
}

const syncFs = {
  chmodSync, closeSync, fchmodSync, fstatSync, fsyncSync, linkSync, lstatSync,
  mkdirSync, openSync, readSync, rmSync, unlinkSync, writeFileSync,
};
