import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  resolveClaudeC1GpgExecutable,
  verifyClaudeC1ArtifactFixture,
  verifyClaudeC1Manifest,
} from '../../../src/runtime/broker/c1-artifacts.js';

test('C1 fixture verifier rebinds the pinned tree and returns only fixed verified paths', (t) => {
  const fixture = createFixture(t);
  const result = verify(fixture);

  assert.deepEqual(Object.keys(result).sort(), ['artifacts', 'code', 'ok']);
  assert.equal(result.ok, true);
  assert.equal(result.code, 'c1-artifact-verified');
  assert.equal(result.artifacts.artifactRoot, realpathSync(fixture.root));
  assert.equal(result.artifacts.claudeSha256, fixture.expected.sha256);
  assert.equal(result.artifacts.srtModule, realpathSync(join(
    fixture.srtRoot,
    'node_modules',
    '@anthropic-ai',
    'sandbox-runtime',
    'dist',
    'index.js',
  )));
  assert.equal(result.artifacts.platformSignatureVerified, false);
  assert.equal(Object.isFrozen(result), true);
  assert.equal(Object.isFrozen(result.artifacts), true);
});

test('C1 fixture verifier fails closed for a symlinked binary and non-private root', (t) => {
  const fixture = createFixture(t);
  const outside = join(fixture.tmp, 'outside-claude');
  writeFileSync(outside, 'outside', { mode: 0o700 });
  rmSync(fixture.binary);
  symlinkSync(outside, fixture.binary);
  assert.equal(verify(fixture).code, 'c1-artifact-path-symlink');

  rmSync(fixture.root, { recursive: true, force: true });
  const insecure = createFixture(t);
  chmodSync(insecure.root, 0o755);
  assert.equal(verify(insecure).code, 'c1-artifact-permissions-invalid');
});

test('C1 fixture verifier rejects changed binary, package lock, and installed tree evidence', (t) => {
  const binary = createFixture(t);
  writeFileSync(binary.binary, 'changed', { mode: 0o700 });
  assert.equal(verify(binary).code, 'c1-artifact-binary-mismatch');

  const lock = createFixture(t);
  const lockBody = JSON.parse(readFileSync(lock.srtLock, 'utf8'));
  lockBody.packages['node_modules/@anthropic-ai/sandbox-runtime'].integrity = 'sha512-bad';
  writeFileSync(lock.srtLock, JSON.stringify(lockBody), { mode: 0o644 });
  assert.equal(verify(lock).code, 'c1-artifact-srt-package-mismatch');

  const tree = createFixture(t);
  writeFileSync(join(tree.srtRoot, 'extra.txt'), 'drift', { mode: 0o644 });
  assert.equal(verify(tree).code, 'c1-artifact-srt-tree-mismatch');
});

test('C1 fixture verifier keeps signed-manifest trust primary and reports the platform observation', (t) => {
  const untrusted = createFixture(t);
  assert.equal(verify(untrusted, { verifyManifest: () => false }).code, 'c1-artifact-manifest-untrusted');

  // Both real strict outcomes are admissible on a supported host and are
  // reported exactly as observed. Neither moves the trust root, which stays
  // the signed manifest plus the pinned bytes.
  const unverified = verify(createFixture(t), { strictStatus: 1 });
  assert.equal(unverified.code, 'c1-artifact-verified');
  assert.equal(unverified.artifacts.manifestSignatureVerified, true);
  assert.equal(unverified.artifacts.platformSignatureVerified, false);

  const verified = verify(createFixture(t), { strictStatus: 0 });
  assert.equal(verified.code, 'c1-artifact-verified');
  assert.equal(verified.artifacts.manifestSignatureVerified, true);
  assert.equal(verified.artifacts.platformSignatureVerified, true);

  // A status that is not an observation of the binary still fails closed.
  assert.equal(
    verify(createFixture(t), { strictStatus: 2 }).code,
    'c1-artifact-codesign-strict-unexpected',
  );
  assert.equal(
    verify(createFixture(t), { strictStatus: null }).code,
    'c1-artifact-codesign-strict-unavailable',
  );

  const identity = createFixture(t);
  assert.equal(verify(identity, { signing: 'Identifier=wrong\nTeamIdentifier=Q6L2SF6YDW' }).code, 'c1-artifact-codesign-identity-mismatch');
});

test('C1 fixture verifier fails closed on an unsupported host before reading the artifact root', (t) => {
  const fixture = createFixture(t);
  const result = verifyClaudeC1ArtifactFixture({
    artifactRoot: fixture.root,
    expected: fixture.expected,
  }, {
    platform: () => 'linux',
    arch: () => 'arm64',
  });
  assert.deepEqual(result, { ok: false, code: 'c1-artifact-platform-unsupported' });
});

test('C1 manifest verification uses a rebound fixed GPG executable, never PATH', (t) => {
  const fixture = createFixture(t);
  const calls = [];
  const gpgPath = '/opt/homebrew/Cellar/gnupg/2.5.18/bin/gpg';
  const result = verifyClaudeC1Manifest({
    manifestPath: join(fixture.root, 'manifest.json'),
    signaturePath: join(fixture.root, 'manifest.json.sig'),
    signingKeyPath: join(fixture.root, 'claude-code.asc'),
    expectedFingerprint: fixture.expected.manifestSigningFingerprint,
    gpgPath,
    spawnSync(command, args) {
      calls.push({ command, args });
      if (args.includes('--import')) {
        return {
          status: 2,
          stdout: `[GNUPG:] IMPORT_OK 1 ${fixture.expected.manifestSigningFingerprint}\n`,
        };
      }
      return {
        status: 0,
        stdout: `[GNUPG:] VALIDSIG ${fixture.expected.manifestSigningFingerprint} 2026-07-24 0 4 0 1 10 00 ${fixture.expected.manifestSigningFingerprint}\n`,
      };
    },
  });

  assert.equal(result, true);
  assert.deepEqual(calls.map(({ command }) => command), [gpgPath, gpgPath]);
  assert.equal(verifyClaudeC1Manifest({
    manifestPath: join(fixture.root, 'manifest.json'),
    signaturePath: join(fixture.root, 'manifest.json.sig'),
    signingKeyPath: join(fixture.root, 'claude-code.asc'),
    expectedFingerprint: fixture.expected.manifestSigningFingerprint,
    gpgPath: null,
    spawnSync() {
      assert.fail('missing fixed GPG must fail before spawn');
    },
  }), false);
});

test('C1 GPG resolution accepts only an executable rebound into its fixed prefix', () => {
  const target = '/opt/homebrew/Cellar/gnupg/2.5.18/bin/gpg';
  const regular = {
    uid: 502,
    mode: 0o100555,
    isFile: () => true,
    isSymbolicLink: () => false,
  };
  const link = {
    isFile: () => false,
    isSymbolicLink: () => true,
  };
  const fs = {
    lstat(path) {
      if (path === '/opt/homebrew/bin/gpg') return link;
      if (path === target) return regular;
      throw new Error('unexpected path');
    },
    realpath: () => target,
  };
  const candidates = [{
    entry: '/opt/homebrew/bin/gpg',
    targetPrefix: '/opt/homebrew/Cellar/gnupg/',
  }];

  assert.equal(resolveClaudeC1GpgExecutable({ candidates, fs, uid: 502 }), target);
  regular.mode = 0o100775;
  assert.equal(resolveClaudeC1GpgExecutable({ candidates, fs, uid: 502 }), null);
});

function verify(fixture, overrides = {}) {
  return verifyClaudeC1ArtifactFixture({
    artifactRoot: fixture.root,
    expected: fixture.expected,
  }, {
    platform: () => 'darwin',
    arch: () => 'arm64',
    verifyManifest: overrides.verifyManifest || (() => true),
    spawnSync: (command, args) => {
      if (command === 'codesign' && args[0] === '-dv') {
        return { status: 0, stderr: overrides.signing || [
          'Identifier=com.anthropic.claude-code',
          'TeamIdentifier=Q6L2SF6YDW',
        ].join('\n') };
      }
      if (command === 'codesign' && args[0] === '--verify') {
        return { status: overrides.strictStatus === undefined ? 1 : overrides.strictStatus };
      }
      if (command === fixture.binary && args[0] === '--version') {
        return { status: 0, stdout: `${fixture.expected.version}\n` };
      }
      assert.fail(`unexpected command: ${command} ${args.join(' ')}`);
    },
  });
}

function createFixture(t) {
  const tmp = mkdtempSync(join(tmpdir(), 'mc-c1-artifacts-'));
  const root = join(tmp, 'artifact');
  const srtRoot = join(root, 'srt');
  const packageRoot = join(srtRoot, 'node_modules', '@anthropic-ai', 'sandbox-runtime');
  const binary = join(root, 'claude');
  const srtLock = join(srtRoot, 'package-lock.json');
  mkdirSync(root, { recursive: true, mode: 0o700 });
  mkdirSync(join(packageRoot, 'dist'), { recursive: true, mode: 0o755 });
  writeFileSync(binary, 'fixture claude binary', { mode: 0o700 });
  const expected = {
    platform: 'darwin',
    arch: 'arm64',
    version: '2.1.220',
    sha256: sha256(readFileSync(binary)),
    size: readFileSync(binary).length,
    identifier: 'com.anthropic.claude-code',
    teamId: 'Q6L2SF6YDW',
    manifestSigningFingerprint: '31DDDE24DDFAB679F42D7BD2BAA929FF1A7ECACE',
    srtVersion: '0.0.67',
    srtIntegrity: 'sha512-4doSyr6KNdc/4zARMXYEawhFu3z6bPQjgKRq3lKp6dbgEYVMv39oaLJ28QsDc7TmLvrLqzHW+VzD2LAXxvnw8A==',
    srtTreeSha256: null,
  };
  writeFileSync(join(root, 'manifest.json'), JSON.stringify({
    version: expected.version,
    platforms: {
      'darwin-arm64': { binary: 'claude', checksum: expected.sha256, size: expected.size },
    },
  }), { mode: 0o644 });
  writeFileSync(join(root, 'manifest.json.sig'), 'signature', { mode: 0o644 });
  writeFileSync(join(root, 'claude-code.asc'), 'public key', { mode: 0o644 });
  writeFileSync(join(packageRoot, 'package.json'), JSON.stringify({
    name: '@anthropic-ai/sandbox-runtime',
    version: expected.srtVersion,
    bin: { srt: 'dist/cli.js' },
  }), { mode: 0o644 });
  writeFileSync(join(packageRoot, 'dist', 'cli.js'), '#!/usr/bin/env node\n', { mode: 0o755 });
  writeFileSync(join(packageRoot, 'dist', 'index.js'), 'export const fixture = true;\n', { mode: 0o644 });
  writeFileSync(srtLock, JSON.stringify({
    lockfileVersion: 3,
    packages: {
      '': { dependencies: { '@anthropic-ai/sandbox-runtime': `^${expected.srtVersion}` } },
      'node_modules/@anthropic-ai/sandbox-runtime': {
        version: expected.srtVersion,
        integrity: expected.srtIntegrity,
        bin: { srt: 'dist/cli.js' },
      },
    },
  }), { mode: 0o644 });
  expected.srtTreeSha256 = treeHash(srtRoot);
  t.after(() => rmSync(tmp, { recursive: true, force: true }));
  return { tmp, root, binary, srtRoot, srtLock, expected };
}

function treeHash(root) {
  const hash = createHash('sha256');
  const walk = (directory) => {
    for (const name of readdirSync(directory).sort()) {
      const path = join(directory, name);
      const relativePath = path.slice(root.length + 1);
      const info = lstatSync(path);
      if (info.isDirectory()) {
        hash.update(`d\0${relativePath}\0`);
        walk(path);
      } else if (info.isSymbolicLink()) {
        hash.update(`l\0${relativePath}\0${readlinkSync(path)}\0`);
      } else if (info.isFile()) {
        hash.update(`f\0${relativePath}\0${info.mode.toString(8)}\0`);
        hash.update(readFileSync(path));
        hash.update('\0');
      }
    }
  };
  walk(root);
  return hash.digest('hex');
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}
