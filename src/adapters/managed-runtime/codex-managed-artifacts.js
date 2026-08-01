/**
 * Fixed artifact slot for the managed Codex adapter.
 *
 * Production accepts no caller-selected path or release. A global `codex`
 * installation may move independently and is therefore never a managed
 * provider trust source.
 */
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import {
  lstatSync,
  readFileSync,
  readdirSync,
  realpathSync,
} from 'node:fs';
import { arch, platform } from 'node:os';
import { join, resolve } from 'node:path';

import { mcHome } from '../../mc/paths.js';
import {
  MANAGED_CODEX_RELEASE_SHA256,
  MANAGED_CODEX_TEAM_ID,
  MANAGED_CODEX_VERSION,
  MANAGED_CODEX_VERSION_PROBE_TIMEOUT_MS,
} from './codex-managed.js';

export const MANAGED_CODEX_ARTIFACT_PINS = Object.freeze({
  platform: 'darwin',
  arch: 'arm64',
  version: MANAGED_CODEX_VERSION,
  sha256: MANAGED_CODEX_RELEASE_SHA256['darwin-arm64'],
  identifier: 'codex',
  teamId: MANAGED_CODEX_TEAM_ID,
});

export function verifyInstalledManagedCodexArtifact() {
  const pins = MANAGED_CODEX_ARTIFACT_PINS;
  const artifactRoot = join(
    mcHome(),
    'managed-artifacts',
    'codex',
    `${pins.platform}-${pins.arch}`,
    pins.sha256,
  );
  return verifyManagedCodexArtifactFixture({
    artifactRoot,
    expected: pins,
  });
}

export function verifyManagedCodexArtifactFixture({
  artifactRoot,
  expected = MANAGED_CODEX_ARTIFACT_PINS,
} = {}, deps = {}) {
  const hostPlatform = (deps.platform || platform)();
  const hostArch = (deps.arch || arch)();
  if (hostPlatform !== expected?.platform || hostArch !== expected?.arch) {
    return failure('managed-codex-artifact-platform-unsupported');
  }
  if (!validPins(expected)
    || typeof artifactRoot !== 'string'
    || !artifactRoot.startsWith('/')) {
    return failure('managed-codex-artifact-input-invalid');
  }
  const fs = {
    lstatSync: deps.lstatSync || lstatSync,
    readFileSync: deps.readFileSync || readFileSync,
    readdirSync: deps.readdirSync || readdirSync,
    realpathSync: deps.realpathSync || realpathSync,
  };
  const expectedUid = (deps.getuid || (() => (
    typeof process.getuid === 'function' ? process.getuid() : null
  )))();
  const binaryPath = join(artifactRoot, 'codex');
  let binary;
  try {
    const rootInfo = fs.lstatSync(artifactRoot);
    const binaryInfo = fs.lstatSync(binaryPath);
    const entries = fs.readdirSync(artifactRoot);
    if (!privateDirectory(rootInfo, expectedUid)
      || !privateExecutable(binaryInfo, expectedUid)
      || entries.length !== 1
      || entries[0] !== 'codex'
      || fs.realpathSync(artifactRoot) !== resolve(artifactRoot)
      || fs.realpathSync(binaryPath) !== resolve(binaryPath)) {
      return failure('managed-codex-artifact-untrusted');
    }
    binary = fs.readFileSync(binaryPath);
  } catch {
    return failure('managed-codex-artifact-unavailable');
  }
  if (!Buffer.isBuffer(binary) || sha256(binary) !== expected.sha256) {
    return failure('managed-codex-artifact-binary-mismatch');
  }

  const run = deps.spawnSync || spawnSync;
  const codesign = run('codesign', ['-dv', '--verbose=4', binaryPath], {
    encoding: 'utf8',
    timeout: 10_000,
  });
  const signing = `${codesign?.stdout || ''}\n${codesign?.stderr || ''}`;
  const teamId = signing.match(/\bTeamIdentifier=([A-Z0-9]+)\b/u)?.[1] || null;
  const identifier = signing.match(/\bIdentifier=([^\s]+)\b/u)?.[1] || null;
  if (codesign?.status !== 0
    || teamId !== expected.teamId
    || identifier !== expected.identifier) {
    return failure('managed-codex-artifact-signature-untrusted');
  }

  const versionProbe = run(binaryPath, ['--version'], {
    encoding: 'utf8',
    timeout: MANAGED_CODEX_VERSION_PROBE_TIMEOUT_MS,
    env: {
      PATH: '/usr/bin:/bin:/usr/sbin:/sbin',
      HOME: '/var/empty',
    },
  });
  const version = String(versionProbe?.stdout || '')
    .match(/\b(\d+\.\d+\.\d+)\b/u)?.[1] || null;
  if (versionProbe?.status !== 0 || version !== expected.version) {
    return failure('managed-codex-artifact-version-unsupported');
  }
  return Object.freeze({
    ok: true,
    code: 'managed-codex-artifact-verified',
    nativeBinary: resolve(binaryPath),
    version,
    teamId,
    sha256: expected.sha256,
  });
}

function validPins(value) {
  return value
    && value.platform === 'darwin'
    && value.arch === 'arm64'
    && /^\d+\.\d+\.\d+$/u.test(value.version || '')
    && /^[a-f0-9]{64}$/u.test(value.sha256 || '')
    && /^[A-Za-z0-9._-]{1,128}$/u.test(value.identifier || '')
    && /^[A-Z0-9]{10}$/u.test(value.teamId || '');
}

function privateDirectory(info, expectedUid) {
  return info.isDirectory()
    && !info.isSymbolicLink()
    && (info.mode & 0o077) === 0
    && (expectedUid === null || info.uid === expectedUid);
}

function privateExecutable(info, expectedUid) {
  return info.isFile()
    && !info.isSymbolicLink()
    && (info.mode & 0o077) === 0
    && (info.mode & 0o100) !== 0
    && (expectedUid === null || info.uid === expectedUid);
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function failure(code) {
  return Object.freeze({ ok: false, code, reason: code });
}
