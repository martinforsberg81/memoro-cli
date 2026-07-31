/**
 * Machine-local C1/provider exclusion.
 *
 * This deliberately is not a PID lock.  A broker crash leaves its evidence in
 * place, which makes the next operation fail closed until an operator has
 * investigated it.  The only mutable state is private, bounded metadata: it
 * contains no command line, environment, credential, or provider output.
 */
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
  readdirSync,
  renameSync,
  unlinkSync,
  writeSync,
} from 'node:fs';
import { createHash, randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { mcHome } from '../paths.js';
import { readInstalledC1Generation } from './c1-install-receipt.js';

const ROOT_NAME = 'c1-global-interlock';
const PROVIDERS_NAME = 'providers';
const C1_LOCK_NAME = 'claude-c1.lock';
const INSTALL_EPOCH_NAME = 'install-epoch.json';
const PROVIDER_SCHEMA = 'mc-c1-provider-marker-v2';
const LEGACY_PROVIDER_SCHEMA = 'mc-c1-provider-marker-v1';
const UNBOUND_PROVIDER_SCHEMA = 'mc-c1-provider-marker-unbound-v1';
const C1_SCHEMA = 'mc-c1-global-lock-v1';
const INSTALL_EPOCH_SCHEMA = 'mc-c1-install-epoch-v2';
const LEGACY_INSTALL_EPOCH_SCHEMA = 'mc-c1-install-epoch-v1';
const MAX_ID_BYTES = 256;
const READ_NOFOLLOW = constants.O_NOFOLLOW || 0;
const CREATE_EXCLUSIVE = constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | READ_NOFOLLOW;
const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const INSTALL_IDENTITY_INPUTS = Object.freeze([
  'package.json',
  'scripts/security/credential-boundary-child.c',
  'scripts/security/credential-boundary-probe.mjs',
  'scripts/security/managed-claude-c1-probe.c',
  'src/mc/broker/c1-global-interlock.js',
  'src/mc/broker/c1-install-receipt.js',
  'src/mc/broker/runtime.js',
  'src/mc/commands/storage.js',
  'src/mc/credential-domain/local-codex.js',
  'src/mc/managed-codex-recovery.js',
  'src/mc/provider-adapters/codex-managed-artifacts.js',
  'src/mc/provider-adapters/codex-managed.js',
  'src/mc/runtime-secrets.js',
  'src/mc/session-intent.js',
  'src/mc/sidecar-cleanup.js',
]);

/**
 * The production entry point takes no caller-controlled path, environment, or
 * secret input.  Test-only construction below exists solely to exercise the
 * interleavings against a disposable filesystem root.
 */
export function createC1GlobalInterlock() {
  return createC1GlobalInterlockForTesting({ root: join(mcHome(), ROOT_NAME) });
}

// This is intentionally a fixed-argument production entry point for package
// installation. The fresh receipt is part of the derived identity, so an
// install records its own boot as the baseline before any later mc launch.
export function baselineInstalledC1Epoch() {
  return baselineC1InstallEpochFixture({
    root: join(mcHome(), ROOT_NAME),
    bootId: readBootIdentity(),
    installIdentity: readC1InstallIdentity(),
  });
}

// Exported solely for deterministic package-install lifecycle tests.
export function baselineC1InstallEpochFixture({
  root,
  fs = syncFs,
  uid = typeof process.getuid === 'function' ? process.getuid() : null,
  bootId,
  installIdentity,
} = {}) {
  if (typeof root !== 'string' || !root) return failed('install-epoch-root-invalid');
  const state = ensureRoots({
    root,
    providersRoot: join(root, PROVIDERS_NAME),
    installEpochPath: join(root, INSTALL_EPOCH_NAME),
    fs,
    uid,
    bootId,
    installIdentity,
    forceInstallEpochBaseline: true,
  });
  return state.ok && state.identityAvailable
    ? { ok: true, code: 'c1-install-epoch-baselined' }
    : failed('install-epoch-baseline-unavailable');
}

export function createC1GlobalInterlockForTesting({
  root,
  fs = syncFs,
  random = randomBytes,
  uid = typeof process.getuid === 'function' ? process.getuid() : null,
  bootId = readBootIdentity(),
  installIdentity = readC1InstallIdentity(),
  beforeC1ProviderScan = null,
} = {}) {
  if (typeof root !== 'string' || !root) throw new TypeError('test root is required');
  const providersRoot = join(root, PROVIDERS_NAME);
  const c1LockPath = join(root, C1_LOCK_NAME);
  const installEpochPath = join(root, INSTALL_EPOCH_NAME);

  function acquireProvider({ sessionId, runtimeGeneration } = {}) {
    if (!boundedIdentifier(sessionId) || !boundedIdentifier(runtimeGeneration)) {
      return failed('invalid-provider-identity');
    }
    const roots = ensureRoots({
      root,
      providersRoot,
      installEpochPath,
      fs,
      uid,
      bootId,
      installIdentity,
    });
    if (!roots.ok) return failed('unsafe-interlock-root');

    const nonce = nonceHex(random);
    if (!nonce) return failed('randomness-unavailable');
    const markerName = `provider-${nonce}.json`;
    const markerPath = join(providersRoot, markerName);
    const marker = JSON.stringify({
      schema: roots.identityAvailable ? PROVIDER_SCHEMA : UNBOUND_PROVIDER_SCHEMA,
      ...(roots.identityAvailable ? { install_identity: roots.installIdentity } : {}),
      session_id: sessionId,
      runtime_generation: runtimeGeneration,
      nonce,
    });
    const created = createPrivateFile({ path: markerPath, content: marker, fs });
    if (!created.ok) return failed(created.reason);
    const lease = makeLease({ path: markerPath, node: created.node, fs });

    // The marker is deliberately written first.  If C1 won the race after
    // this write, provider launch fails before spawn and removes only its own
    // marker.  If removal cannot be proved, leave the marker as fail-closed
    // evidence rather than risking a concurrent launch.
    if (pathExistsOrUnsafe(c1LockPath, fs)) {
      lease.release();
      return failed('c1-global-lock-active');
    }
    return { ok: true, lease };
  }

  function acquireC1() {
    const roots = ensureRoots({
      root,
      providersRoot,
      installEpochPath,
      fs,
      uid,
      bootId,
      installIdentity,
    });
    if (!roots.ok) return failed('unsafe-interlock-root');
    // A process from before this exact containment release cannot necessarily
    // be represented by its provider marker. Requiring one later OS boot after
    // each install-identity transition gives C1 a zero-legacy-process baseline
    // without PID guesses, including upgrade and rollback sequences.
    if (!roots.cleanBootObserved) return failed('c1-clean-restart-required');
    const nonce = nonceHex(random);
    if (!nonce) return failed('randomness-unavailable');
    const created = createPrivateFile({
      path: c1LockPath,
      content: JSON.stringify({ schema: C1_SCHEMA, nonce }),
      fs,
    });
    if (!created.ok) return failed(created.reason === 'already-exists'
      ? 'c1-global-lock-active'
      : created.reason);
    const lease = makeLease({ path: c1LockPath, node: created.node, fs });

    // A provider which creates its marker after this scan must observe our
    // lock before it can call spawn.  A marker created before/during this scan
    // makes this C1 attempt fail; its provider then observes the lock and does
    // not launch.  This is the two-party ordering that removes the TOCTOU.
    try { beforeC1ProviderScan?.(); } catch {
      lease.release();
      return failed('provider-scan-unavailable');
    }
    if (providerMarkersPresent(providersRoot, fs, {
      installIdentity: roots.installIdentity,
      cleanBootObserved: roots.cleanBootObserved,
      uid,
    })) {
      lease.release();
      return failed('provider-marker-active');
    }
    return { ok: true, lease };
  }

  return Object.freeze({
    acquireProvider,
    acquireC1,
  });
}

function ensureRoots({
  root,
  providersRoot,
  installEpochPath,
  fs,
  uid,
  bootId,
  installIdentity,
  forceInstallEpochBaseline = false,
}) {
  try {
    fs.mkdirSync(root, { recursive: true, mode: 0o700 });
    fs.mkdirSync(providersRoot, { recursive: true, mode: 0o700 });
    if (!privateDirectory(root, fs, uid) || !privateDirectory(providersRoot, fs, uid)) {
      return { ok: false, cleanBootObserved: false, identityAvailable: false };
    }
    if (!boundedIdentifier(bootId)
      || !validInstallIdentity(installIdentity)
      || !installEpochPath) {
      return { ok: true, cleanBootObserved: false, identityAvailable: false };
    }
    const epoch = installEpochState({
      path: installEpochPath,
      bootId,
      installIdentity,
      fs,
      uid,
      forceInstallEpochBaseline,
    });
    return {
      ...epoch,
      identityAvailable: epoch.ok,
      bootId,
      installIdentity,
    };
  } catch {
    return { ok: false, cleanBootObserved: false, identityAvailable: false };
  }
}

function installEpochState({
  path,
  bootId,
  installIdentity,
  fs,
  uid,
  forceInstallEpochBaseline = false,
}) {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const stat = fs.lstatSync(path);
      if (!privateRegularFile(stat)
        || (uid !== null && stat.uid !== uid)) {
        return { ok: false, cleanBootObserved: false };
      }
      const raw = fs.readFileSync(path, 'utf8');
      if (Buffer.byteLength(raw, 'utf8') > 512) {
        return { ok: false, cleanBootObserved: false };
      }
      const value = JSON.parse(raw);
      const current = isExactInstallEpoch(value);
      const legacy = isLegacyInstallEpoch(value);
      if (!current && !legacy) {
        return { ok: false, cleanBootObserved: false };
      }
      if (current && value.install_identity === installIdentity && !forceInstallEpochBaseline) {
        return { ok: true, cleanBootObserved: value.boot_id !== bootId };
      }
      const replaced = replacePrivateFile({
        path,
        previousNode: { dev: stat.dev, ino: stat.ino },
        content: installEpochContent(bootId, installIdentity),
        fs,
      });
      if (!replaced.ok) return { ok: false, cleanBootObserved: false };
      // A release change, reinstall, downgrade, or legacy migration records
      // the current boot as the new baseline and cannot authorize C1 yet.
      return { ok: true, cleanBootObserved: false };
    } catch (error) {
      if (error?.code !== 'ENOENT') return { ok: false, cleanBootObserved: false };
      const created = createPrivateFile({
        path,
        content: installEpochContent(bootId, installIdentity),
        fs,
      });
      if (created.ok) return { ok: true, cleanBootObserved: false };
      if (created.reason !== 'already-exists') {
        return { ok: false, cleanBootObserved: false };
      }
    }
  }
  return { ok: false, cleanBootObserved: false };
}

function replacePrivateFile({ path, previousNode, content, fs }) {
  const nextPath = `${path}.next`;
  const created = createPrivateFile({ path: nextPath, content, fs });
  if (!created.ok) return created;
  try {
    const current = fs.lstatSync(path);
    if (!privateRegularFile(current)
      || current.dev !== previousNode.dev
      || current.ino !== previousNode.ino) {
      return failed('interlock-replace-raced');
    }
    fs.renameSync(nextPath, path);
    let directoryFd = null;
    try {
      directoryFd = fs.openSync(dirname(path), constants.O_RDONLY);
      fs.fsyncSync(directoryFd);
    } finally {
      if (directoryFd !== null) fs.closeSync(directoryFd);
    }
    const rebound = fs.lstatSync(path);
    if (!privateRegularFile(rebound)
      || rebound.dev !== created.node.dev
      || rebound.ino !== created.node.ino) {
      return failed('interlock-replace-unconfirmed');
    }
    return { ok: true };
  } catch {
    // Leave the private `.next` file as fail-closed crash/race evidence.
    return failed('interlock-replace-unconfirmed');
  }
}

function installEpochContent(bootId, installIdentity) {
  return JSON.stringify({
    schema: INSTALL_EPOCH_SCHEMA,
    boot_id: bootId,
    install_identity: installIdentity,
  });
}

function isExactInstallEpoch(value) {
  return value && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).length === 3
    && value.schema === INSTALL_EPOCH_SCHEMA
    && boundedIdentifier(value.boot_id)
    && validInstallIdentity(value.install_identity);
}

function isLegacyInstallEpoch(value) {
  return value && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).length === 2
    && value.schema === LEGACY_INSTALL_EPOCH_SCHEMA
    && boundedIdentifier(value.boot_id);
}

function privateDirectory(path, fs, uid) {
  try {
    const stat = fs.lstatSync(path);
    return stat.isDirectory()
      && !stat.isSymbolicLink()
      && (stat.mode & 0o077) === 0
      && (uid === null || stat.uid === uid);
  } catch {
    return false;
  }
}

function createPrivateFile({ path, content, fs }) {
  let fd = null;
  try {
    fd = fs.openSync(path, CREATE_EXCLUSIVE, 0o600);
    fs.writeSync(fd, content, undefined, 'utf8');
    fs.fchmodSync(fd, 0o600);
    fs.fsyncSync(fd);
    const stat = fs.fstatSync(fd);
    if (!privateRegularFile(stat)) throw new Error('unsafe-created-file');
    fs.closeSync(fd); fd = null;
    return { ok: true, node: { dev: stat.dev, ino: stat.ino } };
  } catch (error) {
    if (fd !== null) {
      try { fs.closeSync(fd); } catch {}
    }
    // Never remove an uncertain file after a failed exclusive open: doing so
    // could erase evidence created by another broker.
    return failed(error?.code === 'EEXIST' ? 'already-exists' : 'interlock-write-failed');
  }
}

function providerMarkersPresent(providersRoot, fs, {
  installIdentity,
  cleanBootObserved,
  uid,
} = {}) {
  if (!cleanBootObserved || !validInstallIdentity(installIdentity)) return true;
  try {
    const entries = fs.readdirSync(providersRoot, { withFileTypes: true });
    for (const entry of entries) {
      const state = classifyProviderMarker({
        path: join(providersRoot, entry.name),
        name: entry.name,
        fs,
        uid,
        installIdentity,
      });
      // Superseded evidence is never removed here. It is safe to disregard
      // only because C1 has already proved a boot later than the current
      // installation baseline, so an old-release provider cannot survive.
      if (state !== 'superseded') return true;
    }
    return false;
  } catch {
    return true;
  }
}

function classifyProviderMarker({ path, name, fs, uid, installIdentity }) {
  const nonce = markerNonceFromName(name);
  if (!nonce) return 'unsafe';
  try {
    const stat = fs.lstatSync(path);
    if (!privateRegularFile(stat) || (uid !== null && stat.uid !== uid)) return 'unsafe';
    const raw = fs.readFileSync(path, 'utf8');
    if (Buffer.byteLength(raw, 'utf8') > 1024) return 'unsafe';
    const value = JSON.parse(raw);
    if (isExactProviderMarkerV2(value, nonce)) {
      return value.install_identity === installIdentity ? 'current' : 'superseded';
    }
    // v1 predates the install-identity-bound format; the unbound schema is
    // used only when an installation could not prove its identity. Since this
    // scan occurs after a clean boot for a fresh install identity, either can
    // only describe an older release and is superseded.
    return isExactProviderMarkerV1(value, nonce) || isExactUnboundProviderMarker(value, nonce)
      ? 'superseded'
      : 'unsafe';
  } catch {
    return 'unsafe';
  }
}

function markerNonceFromName(name) {
  const match = /^provider-([a-f0-9]{32})\.json$/u.exec(name || '');
  return match?.[1] || null;
}

function isExactProviderMarkerV1(value, nonce) {
  return isExactProviderMarker(value, {
    schema: LEGACY_PROVIDER_SCHEMA,
    nonce,
    keys: ['nonce', 'runtime_generation', 'schema', 'session_id'],
  });
}

function isExactProviderMarkerV2(value, nonce) {
  return isExactProviderMarker(value, {
    schema: PROVIDER_SCHEMA,
    nonce,
    keys: ['install_identity', 'nonce', 'runtime_generation', 'schema', 'session_id'],
  }) && validInstallIdentity(value.install_identity);
}

function isExactUnboundProviderMarker(value, nonce) {
  return isExactProviderMarker(value, {
    schema: UNBOUND_PROVIDER_SCHEMA,
    nonce,
    keys: ['nonce', 'runtime_generation', 'schema', 'session_id'],
  });
}

function isExactProviderMarker(value, { schema, nonce, keys }) {
  return value && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).sort().join('\0') === keys.join('\0')
    && value.schema === schema
    && value.nonce === nonce
    && boundedIdentifier(value.session_id)
    && boundedIdentifier(value.runtime_generation);
}

function makeLease({ path, node, fs }) {
  let released = false;
  return Object.freeze({
    release() {
      if (released) return { ok: true, released: false };
      try {
        const stat = fs.lstatSync(path);
        if (!privateRegularFile(stat) || stat.dev !== node.dev || stat.ino !== node.ino) {
          return failed('interlock-release-unconfirmed');
        }
        fs.unlinkSync(path);
        released = true;
        return { ok: true, released: true };
      } catch {
        return failed('interlock-release-unconfirmed');
      }
    },
  });
}

function privateRegularFile(stat) {
  return stat.isFile() && !stat.isSymbolicLink() && (stat.mode & 0o077) === 0;
}

function pathExistsOrUnsafe(path, fs) {
  try {
    fs.lstatSync(path);
    return true;
  } catch (error) {
    return error?.code !== 'ENOENT';
  }
}

function boundedIdentifier(value) {
  return typeof value === 'string'
    && value.length > 0
    && Buffer.byteLength(value, 'utf8') <= MAX_ID_BYTES
    && !/[\u0000-\u001f\u007f]/.test(value);
}

function nonceHex(random) {
  try {
    const value = random(16);
    return Buffer.isBuffer(value) && value.length === 16 ? value.toString('hex') : null;
  } catch {
    return null;
  }
}

function failed(reason) {
  return { ok: false, reason };
}

function readBootIdentity() {
  if (process.platform !== 'darwin') return null;
  try {
    const result = spawnSync('/usr/sbin/sysctl', ['-n', 'kern.boottime'], {
      encoding: 'utf8',
      env: { PATH: '/usr/bin:/bin:/usr/sbin:/sbin', LANG: 'C', LC_ALL: 'C' },
      timeout: 2_000,
    });
    const seconds = String(result.stdout || '').match(/\bsec\s*=\s*(\d+)\b/u)?.[1];
    return result.status === 0 && seconds ? `darwin-boot-${seconds}` : null;
  } catch {
    return null;
  }
}

function readC1InstallIdentity() {
  try {
    const installGeneration = readInstalledC1Generation();
    if (!validInstallIdentity(installGeneration)) return null;
    const hash = createHash('sha256');
    hash.update(installGeneration);
    hash.update('\0');
    for (const relativePath of INSTALL_IDENTITY_INPUTS) {
      const path = join(PACKAGE_ROOT, relativePath);
      const stat = lstatSync(path);
      if (!stat.isFile() || stat.isSymbolicLink()) return null;
      hash.update(relativePath);
      hash.update('\0');
      // Content binds the release; filesystem identity binds an exact
      // installation even when package scripts were skipped during reinstall.
      hash.update([
        stat.dev,
        stat.ino,
        stat.size,
        stat.ctimeMs,
        stat.birthtimeMs,
      ].join(':'));
      hash.update('\0');
      hash.update(readFileSync(path));
      hash.update('\0');
    }
    return hash.digest('hex');
  } catch {
    return null;
  }
}

function validInstallIdentity(value) {
  return typeof value === 'string' && /^[a-f0-9]{64}$/u.test(value);
}

const syncFs = Object.freeze({
  mkdirSync,
  openSync,
  writeSync,
  fsyncSync,
  fchmodSync,
  fstatSync,
  closeSync,
  lstatSync,
  readFileSync,
  readdirSync,
  renameSync,
  unlinkSync,
});
