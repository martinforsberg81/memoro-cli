/**
 * Private installation receipt for the Claude C1 clean-boot baseline.
 *
 * Every package installation writes a fresh, value-free generation. Runtime
 * combines it with the exact containment-source digest, so upgrades,
 * downgrades, same-version reinstalls, and rollbacks all invalidate an older
 * clean-boot receipt. Missing or unsafe state disables C1 but never blocks
 * ordinary provider use.
 */

import { randomBytes } from 'node:crypto';
import {
  closeSync,
  constants,
  fchmodSync,
  fsyncSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  unlinkSync,
  writeSync,
} from 'node:fs';
import { dirname, join } from 'node:path';

import { mcHome } from '../paths.js';

const ROOT_NAME = 'c1-global-interlock';
const RECEIPT_NAME = 'install-receipt.json';
const RECEIPT_SCHEMA = 'mc-c1-install-receipt-v1';
const CREATE_EXCLUSIVE = constants.O_WRONLY
  | constants.O_CREAT
  | constants.O_EXCL
  | (constants.O_NOFOLLOW || 0);

export function writeInstalledC1Receipt() {
  return writeC1InstallReceiptFixture({
    root: join(mcHome(), ROOT_NAME),
  });
}

export function readInstalledC1Generation() {
  return readC1InstallGenerationFixture({
    root: join(mcHome(), ROOT_NAME),
  });
}

export function shouldWriteInstalledC1Receipt(env = process.env) {
  return env?.npm_config_global === 'true' || env?.npm_config_global === '1';
}

export function writeC1InstallReceiptFixture({
  root,
  fs = syncFs,
  random = randomBytes,
  uid = typeof process.getuid === 'function' ? process.getuid() : null,
} = {}) {
  if (typeof root !== 'string' || !root) return failure('c1-install-receipt-root-invalid');
  try {
    fs.mkdirSync(root, { recursive: true, mode: 0o700 });
    if (!privateDirectory(root, fs, uid)) return failure('c1-install-receipt-root-unsafe');
  } catch {
    return failure('c1-install-receipt-root-unavailable');
  }

  const generation = freshGeneration(random);
  if (!generation) return failure('c1-install-receipt-randomness-unavailable');
  const path = join(root, RECEIPT_NAME);
  const temporaryPath = join(root, `.${RECEIPT_NAME}.${generation}.next`);
  let fd = null;
  let createdNode = null;
  try {
    const existing = safeExistingReceipt(path, fs, uid);
    if (existing === false) return failure('c1-install-receipt-existing-unsafe');
    fd = fs.openSync(temporaryPath, CREATE_EXCLUSIVE, 0o600);
    fs.writeSync(fd, JSON.stringify({
      schema: RECEIPT_SCHEMA,
      generation,
    }), undefined, 'utf8');
    fs.fchmodSync(fd, 0o600);
    fs.fsyncSync(fd);
    const stat = fs.fstatSync(fd);
    if (!privateRegularFile(stat, uid)) throw new Error('unsafe-created-receipt');
    createdNode = { dev: stat.dev, ino: stat.ino };
    fs.closeSync(fd);
    fd = null;
    fs.renameSync(temporaryPath, path);
    fsyncDirectory(root, fs);
    const rebound = fs.lstatSync(path);
    if (!privateRegularFile(rebound, uid)
      || rebound.dev !== createdNode.dev
      || rebound.ino !== createdNode.ino
      || !sameRealPath(path, fs.realpathSync(path))) {
      return failure('c1-install-receipt-rebind-failed');
    }
    return Object.freeze({ ok: true, code: 'c1-install-receipt-written' });
  } catch {
    if (fd !== null) {
      try { fs.closeSync(fd); } catch {}
    }
    removeCreatedTemporary(temporaryPath, createdNode, fs, uid);
    return failure('c1-install-receipt-write-failed');
  }
}

export function readC1InstallGenerationFixture({
  root,
  fs = syncFs,
  uid = typeof process.getuid === 'function' ? process.getuid() : null,
} = {}) {
  if (typeof root !== 'string' || !root || !privateDirectory(root, fs, uid)) return null;
  const path = join(root, RECEIPT_NAME);
  try {
    const stat = fs.lstatSync(path);
    if (!privateRegularFile(stat, uid)
      || !sameRealPath(path, fs.realpathSync(path))) return null;
    const raw = fs.readFileSync(path, 'utf8');
    if (Buffer.byteLength(raw, 'utf8') > 512) return null;
    const value = JSON.parse(raw);
    return isExactReceipt(value) ? value.generation : null;
  } catch {
    return null;
  }
}

function safeExistingReceipt(path, fs, uid) {
  try {
    const stat = fs.lstatSync(path);
    return privateRegularFile(stat, uid) && sameRealPath(path, fs.realpathSync(path));
  } catch (error) {
    return error?.code === 'ENOENT' ? null : false;
  }
}

function privateDirectory(path, fs, uid) {
  try {
    const stat = fs.lstatSync(path);
    return stat.isDirectory()
      && !stat.isSymbolicLink()
      && (stat.mode & 0o077) === 0
      && (uid === null || stat.uid === uid)
      && sameRealPath(path, fs.realpathSync(path));
  } catch {
    return false;
  }
}

function privateRegularFile(stat, uid) {
  return stat.isFile()
    && !stat.isSymbolicLink()
    && (stat.mode & 0o077) === 0
    && (uid === null || stat.uid === uid);
}

function freshGeneration(random) {
  try {
    const bytes = random(32);
    return Buffer.isBuffer(bytes) && bytes.length === 32 ? bytes.toString('hex') : null;
  } catch {
    return null;
  }
}

function sameRealPath(listed, real) {
  const normalize = (path) => (
    process.platform === 'darwin' && path.startsWith('/private/')
      ? path.slice('/private'.length)
      : path
  );
  return normalize(listed) === normalize(real);
}

function isExactReceipt(value) {
  return value && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).length === 2
    && value.schema === RECEIPT_SCHEMA
    && /^[a-f0-9]{64}$/u.test(value.generation || '');
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

function removeCreatedTemporary(path, node, fs, uid) {
  if (!node) return;
  try {
    const stat = fs.lstatSync(path);
    if (privateRegularFile(stat, uid)
      && stat.dev === node.dev
      && stat.ino === node.ino) {
      fs.unlinkSync(path);
    }
  } catch {}
}

function failure(code) {
  return Object.freeze({ ok: false, code });
}

const syncFs = Object.freeze({
  mkdirSync,
  openSync,
  writeSync,
  fchmodSync,
  fsyncSync,
  fstatSync,
  closeSync,
  renameSync,
  lstatSync,
  realpathSync,
  readFileSync,
  unlinkSync,
});
