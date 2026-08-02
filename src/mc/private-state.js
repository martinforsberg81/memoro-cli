import { randomBytes } from 'node:crypto';
import {
  chmodSync,
  closeSync,
  constants,
  fchmodSync,
  fstatSync,
  fsyncSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
} from 'node:path';

const READ_NOFOLLOW = constants.O_RDONLY | (constants.O_NOFOLLOW || 0);

export const privateStateFs = Object.freeze({
  chmodSync,
  closeSync,
  fchmodSync,
  fstatSync,
  fsyncSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeFileSync,
});

export function normalizedPrivateRoot(root) {
  if (typeof root !== 'string' || !isAbsolute(root) || resolve(root) !== root) {
    throw privateStateError('invalid-private-root');
  }
  return root;
}

export function ensurePrivateDirectoryChainSync({
  trustedRoot,
  directory,
  fs = privateStateFs,
} = {}) {
  const chain = trustedDirectoryChain(trustedRoot, directory);
  if (!chain.ok) throw privateStateError(chain.reason);
  for (const path of chain.paths) {
    const inspected = inspectPrivateDirectorySync(path, fs);
    if (inspected.ok) continue;
    if (!inspected.missing) throw privateStateError(inspected.reason);
    try {
      fs.mkdirSync(path, { mode: 0o700 });
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
    }
    try { fs.chmodSync(path, 0o700); } catch {}
    const created = inspectPrivateDirectorySync(path, fs);
    if (!created.ok) throw privateStateError(created.reason);
  }
  return directory;
}

export function inspectPrivateDirectoryChainSync({
  trustedRoot,
  directory,
  fs = privateStateFs,
} = {}) {
  const chain = trustedDirectoryChain(trustedRoot, directory);
  if (!chain.ok) return chain;
  for (const path of chain.paths) {
    const inspected = inspectPrivateDirectorySync(path, fs);
    if (!inspected.ok) return inspected;
  }
  return { ok: true };
}

export function readPrivateJsonSync({
  path,
  trustedRoot,
  validate,
  maxBytes = 64 * 1024,
  fs = privateStateFs,
} = {}) {
  if (typeof validate !== 'function') throw new TypeError('validate is required');
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) throw new TypeError('invalid maxBytes');
  const directory = dirname(path || '');
  const chain = inspectPrivateDirectoryChainSync({ trustedRoot, directory, fs });
  if (!chain.ok) return chain.missing ? { kind: 'absent' } : unknown(chain.reason);

  let fd = null;
  try {
    const before = fs.lstatSync(path);
    if (!privateRegularFile(before)) return unknown('unsafe-file');
    fd = fs.openSync(path, READ_NOFOLLOW);
    const opened = fs.fstatSync(fd);
    if (!sameNode(before, opened) || !privateRegularFile(opened)) return unknown('unsafe-file');
    if (!Number.isSafeInteger(opened.size) || opened.size < 0 || opened.size > maxBytes) {
      return unknown('too-large');
    }
    const reopened = inspectPrivateDirectoryChainSync({ trustedRoot, directory, fs });
    if (!reopened.ok) return unknown(reopened.reason);

    // Private state is published by immutable link or atomic rename, so the
    // opened inode is size-stable. Allocate for the bounded file instead of a
    // 64 KiB maximum buffer on every catalog read.
    const buffer = Buffer.alloc(opened.size);
    let count = 0;
    while (count < opened.size) {
      const read = fs.readSync(fd, buffer, count, opened.size - count, count);
      if (read === 0) return unknown('short-read');
      count += read;
    }
    const completed = fs.fstatSync(fd);
    if (!sameNode(opened, completed) || completed.size !== opened.size) {
      return unknown('unstable-file');
    }
    let parsed;
    try {
      parsed = JSON.parse(buffer.subarray(0, count).toString('utf8'));
    } catch {
      return unknown('corrupt');
    }
    const checked = validate(parsed);
    return checked?.ok ? { kind: 'present', value: checked.value } : unknown(checked?.reason || 'invalid');
  } catch (error) {
    return error?.code === 'ENOENT' ? { kind: 'absent' } : unknown('unreadable');
  } finally {
    if (fd !== null) try { fs.closeSync(fd); } catch {}
  }
}

export function publishImmutablePrivateJsonSync({
  path,
  value,
  trustedRoot,
  fs = privateStateFs,
  random = randomBytes,
} = {}) {
  const directory = dirname(path || '');
  ensurePrivateDirectoryChainSync({ trustedRoot, directory, fs });
  const temporary = temporaryPath(path, random);
  let fd = null;
  try {
    fd = fs.openSync(temporary, 'wx', 0o600);
    fs.writeFileSync(fd, `${JSON.stringify(value)}\n`, 'utf8');
    fs.fsyncSync(fd);
    fs.fchmodSync(fd, 0o600);
    fs.closeSync(fd);
    fd = null;
    fs.linkSync(temporary, path);
    fs.unlinkSync(temporary);
    fsyncDirectorySync(directory, fs);
    return path;
  } catch (error) {
    if (fd !== null) try { fs.closeSync(fd); } catch {}
    try { fs.rmSync(temporary, { force: true }); } catch {}
    throw error;
  }
}

export function replacePrivateJsonSync({
  path,
  value,
  trustedRoot,
  fs = privateStateFs,
  random = randomBytes,
} = {}) {
  const directory = dirname(path || '');
  ensurePrivateDirectoryChainSync({ trustedRoot, directory, fs });
  const existing = inspectPrivateFileForReplace(path, fs);
  if (!existing.ok && !existing.missing) throw privateStateError(existing.reason);
  const temporary = temporaryPath(path, random);
  let fd = null;
  try {
    fd = fs.openSync(temporary, 'wx', 0o600);
    fs.writeFileSync(fd, `${JSON.stringify(value)}\n`, 'utf8');
    fs.fsyncSync(fd);
    fs.fchmodSync(fd, 0o600);
    fs.closeSync(fd);
    fd = null;
    fs.renameSync(temporary, path);
    try { fs.chmodSync(path, 0o600); } catch {}
    fsyncDirectorySync(directory, fs);
    return path;
  } catch (error) {
    if (fd !== null) try { fs.closeSync(fd); } catch {}
    try { fs.rmSync(temporary, { force: true }); } catch {}
    throw error;
  }
}

export function inspectPrivateDirectorySync(path, fs = privateStateFs) {
  try {
    const stat = fs.lstatSync(path);
    if (!stat.isDirectory?.() || stat.isSymbolicLink?.() || (stat.mode & 0o077) !== 0) {
      return invalid('unsafe-directory');
    }
    if (typeof process.getuid === 'function'
      && Number.isInteger(stat.uid)
      && stat.uid !== process.getuid()) {
      return invalid('unsafe-directory-owner');
    }
    return { ok: true };
  } catch (error) {
    return error?.code === 'ENOENT'
      ? { ok: false, missing: true, reason: 'missing-directory' }
      : invalid('unreadable-directory');
  }
}

export function fsyncDirectorySync(path, fs = privateStateFs) {
  let fd = null;
  try {
    fd = fs.openSync(path, constants.O_RDONLY);
    fs.fsyncSync(fd);
  } catch {
    // Some supported filesystems do not allow directory fsync. The file was
    // still written and fsynced; callers retain their journal-level recovery.
  } finally {
    if (fd !== null) try { fs.closeSync(fd); } catch {}
  }
}

export function privateStateError(reason) {
  const error = new Error(`unsafe private state (${reason})`);
  error.code = 'MC_PRIVATE_STATE_UNSAFE';
  error.reason = reason;
  return error;
}

function trustedDirectoryChain(trustedRoot, directory) {
  try {
    normalizedPrivateRoot(trustedRoot);
  } catch {
    return invalid('invalid-private-root');
  }
  if (typeof directory !== 'string'
    || !isAbsolute(directory)
    || resolve(directory) !== directory) return invalid('invalid-directory-chain');
  const rel = relative(trustedRoot, directory);
  if (rel.startsWith('..') || isAbsolute(rel)) return invalid('directory-outside-trusted-root');
  const paths = [trustedRoot];
  if (rel) {
    let current = trustedRoot;
    for (const part of rel.split('/')) {
      current = join(current, part);
      paths.push(current);
    }
  }
  return { ok: true, paths };
}

function inspectPrivateFileForReplace(path, fs) {
  try {
    const stat = fs.lstatSync(path);
    return privateRegularFile(stat) ? { ok: true } : invalid('unsafe-file');
  } catch (error) {
    return error?.code === 'ENOENT'
      ? { ok: false, missing: true, reason: 'missing-file' }
      : invalid('unreadable-file');
  }
}

function privateRegularFile(stat) {
  return stat?.isFile?.()
    && !stat?.isSymbolicLink?.()
    && (stat.mode & 0o077) === 0
    && (typeof process.getuid !== 'function'
      || !Number.isInteger(stat.uid)
      || stat.uid === process.getuid());
}

function sameNode(before, opened) {
  return before.dev === opened.dev && before.ino === opened.ino;
}

function temporaryPath(path, random) {
  return join(dirname(path), `.${basename(path)}.${random(12).toString('hex')}.tmp`);
}

function invalid(reason) {
  return { ok: false, reason };
}

function unknown(reason) {
  return { kind: 'unknown', reason };
}
