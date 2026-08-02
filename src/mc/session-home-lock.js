import { randomBytes } from 'node:crypto';
import { linkSync, unlinkSync } from 'node:fs';
import { dirname } from 'node:path';

import {
  fsyncDirectorySync,
  publishImmutablePrivateJsonSync,
  readPrivateJsonSync,
} from './private-state.js';
import {
  SESSION_HOME_VERSION,
  SESSION_LOCK_OWNER_SCHEMA,
  assertValid,
  sessionHomeError,
} from './session-home-schema.js';

const LOCK_TOKEN_RE = /^[a-f0-9]{32}$/u;

export function withLocksSync(lockPaths, options, callback) {
  const unique = [...new Set(lockPaths)].sort();
  const locks = [];
  try {
    for (const path of unique) locks.push(acquireLockSync({ path, ...options }));
    return callback();
  } finally {
    for (const lock of locks.reverse()) releaseLockSync(lock);
  }
}

export function acquireLockSync({
  path,
  trustedRoot,
  purpose,
  isAlive = processIsAlive,
  random = randomBytes,
  pid = process.pid,
} = {}) {
  const token = random(16).toString('hex');
  const owner = {
    schema: SESSION_LOCK_OWNER_SCHEMA,
    version: SESSION_HOME_VERSION,
    pid,
    token,
    purpose,
  };
  assertValid(validateLockOwner(owner));
  const parent = dirname(path);
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      publishImmutablePrivateJsonSync({ path, value: owner, trustedRoot, random });
      return { path, trustedRoot, token };
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
      const current = readPrivateJsonSync({
        path,
        trustedRoot,
        validate: validateLockOwner,
      });
      if (current.kind === 'absent') continue;
      if (current.kind !== 'present') throw sessionHomeError('unsafe-session-lock');
      if (isAlive(current.value.pid)) {
        throw sessionHomeError('session-mutation-busy');
      }

      // The persistent hard-link tombstone elects exactly one reclaimer for
      // this owner token. Late reclaimers cannot unlink a replacement lock.
      const stalePath = `${path}.stale-${current.value.token}`;
      try {
        linkSync(path, stalePath);
      } catch (linkError) {
        if (linkError?.code === 'ENOENT') continue;
        throw sessionHomeError('stale-session-lock-unremovable');
      }
      const moved = readPrivateJsonSync({
        path: stalePath,
        trustedRoot,
        validate: validateLockOwner,
      });
      if (moved.kind !== 'present' || moved.value.token !== current.value.token) {
        throw sessionHomeError('unsafe-session-lock-reclamation');
      }
      const beforeUnlink = readPrivateJsonSync({
        path,
        trustedRoot,
        validate: validateLockOwner,
      });
      if (beforeUnlink.kind !== 'present' || beforeUnlink.value.token !== current.value.token) {
        throw sessionHomeError('unsafe-session-lock-reclamation');
      }
      try {
        unlinkSync(path);
        fsyncDirectorySync(parent);
      } catch {
        throw sessionHomeError('stale-session-lock-unremovable');
      }
    }
  }
  throw sessionHomeError('session-mutation-busy');
}

export function releaseLockSync(lock) {
  if (!lock?.path || !LOCK_TOKEN_RE.test(lock.token || '')) return false;
  const owner = readPrivateJsonSync({
    path: lock.path,
    trustedRoot: lock.trustedRoot,
    validate: validateLockOwner,
  });
  if (owner.kind !== 'present' || owner.value.token !== lock.token) return false;
  try {
    unlinkSync(lock.path);
    fsyncDirectorySync(dirname(lock.path));
    return true;
  } catch {
    return false;
  }
}

export function validateLockOwner(value) {
  if (!plain(value) || !exactKeys(value, ['schema', 'version', 'pid', 'token', 'purpose'])) {
    return invalid('lock-owner-unexpected-keys');
  }
  if (value.schema !== SESSION_LOCK_OWNER_SCHEMA
    || value.version !== SESSION_HOME_VERSION
    || !Number.isSafeInteger(value.pid)
    || value.pid < 1
    || !LOCK_TOKEN_RE.test(value.token || '')
    || typeof value.purpose !== 'string'
    || value.purpose.length < 1
    || value.purpose.length > 64) return invalid('lock-owner-invalid-fields');
  return { ok: true, value: structuredClone(value) };
}

export function processIsAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === 'EPERM';
  }
}

function exactKeys(value, keys) {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length
    && actual.every((key, index) => key === expected[index]);
}

function plain(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function invalid(reason) {
  return { ok: false, reason };
}
