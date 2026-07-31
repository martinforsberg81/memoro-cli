import { createHash } from 'node:crypto';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  verifyManagedCodexArtifactFixture,
} from '../../../src/mc/provider-adapters/codex-managed-artifacts.js';
import {
  MANAGED_CODEX_VERSION_PROBE_TIMEOUT_MS,
} from '../../../src/mc/provider-adapters/codex-managed.js';

function fixture() {
  const parent = mkdtempSync(join(tmpdir(), 'mc-codex-artifact-'));
  const requestedRoot = join(parent, 'slot');
  const binary = Buffer.from('pinned-codex-fixture');
  mkdirSync(requestedRoot, { mode: 0o700 });
  const root = realpathSync(requestedRoot);
  chmodSync(root, 0o700);
  writeFileSync(join(root, 'codex'), binary, { mode: 0o700 });
  chmodSync(join(root, 'codex'), 0o700);
  return {
    parent,
    root,
    expected: {
      platform: 'darwin',
      arch: 'arm64',
      version: '0.145.0',
      sha256: createHash('sha256').update(binary).digest('hex'),
      identifier: 'codex',
      teamId: '2DC432GLL2',
    },
  };
}

function deps({ calls = [] } = {}) {
  return {
    platform: () => 'darwin',
    arch: () => 'arm64',
    spawnSync: (command, argv, options) => {
      calls.push({ command, argv, options });
      if (command === 'codesign') {
        return {
          status: 0,
          stdout: '',
          stderr: 'Identifier=codex\nTeamIdentifier=2DC432GLL2\n',
        };
      }
      assert.equal(argv[0], '--version');
      return { status: 0, stdout: 'codex-cli 0.145.0\n', stderr: '' };
    },
  };
}

test('managed Codex accepts only the exact private fixed artifact slot', () => {
  const value = fixture();
  const calls = [];
  try {
    const verified = verifyManagedCodexArtifactFixture({
      artifactRoot: value.root,
      expected: value.expected,
    }, deps({ calls }));
    assert.equal(verified.ok, true);
    assert.equal(verified.nativeBinary, join(value.root, 'codex'));
    const versionCall = calls.find(({ command }) => command !== 'codesign');
    assert.equal(versionCall.options.timeout, MANAGED_CODEX_VERSION_PROBE_TIMEOUT_MS);

    writeFileSync(join(value.root, 'unexpected'), 'x', { mode: 0o600 });
    const polluted = verifyManagedCodexArtifactFixture({
      artifactRoot: value.root,
      expected: value.expected,
    }, deps());
    assert.equal(polluted.reason, 'managed-codex-artifact-untrusted');
  } finally {
    rmSync(value.parent, { recursive: true, force: true });
  }
});

test('managed Codex rejects substitution, version drift, and platform drift', () => {
  const value = fixture();
  try {
    const substituted = verifyManagedCodexArtifactFixture({
      artifactRoot: value.root,
      expected: { ...value.expected, sha256: 'a'.repeat(64) },
    }, deps());
    assert.equal(substituted.reason, 'managed-codex-artifact-binary-mismatch');

    const wrongVersion = verifyManagedCodexArtifactFixture({
      artifactRoot: value.root,
      expected: value.expected,
    }, {
      ...deps(),
      spawnSync: (command) => (
        command === 'codesign'
          ? {
              status: 0,
              stdout: '',
              stderr: 'Identifier=codex\nTeamIdentifier=2DC432GLL2\n',
            }
          : { status: 0, stdout: 'codex-cli 0.146.0\n', stderr: '' }
      ),
    });
    assert.equal(wrongVersion.reason, 'managed-codex-artifact-version-unsupported');

    const wrongPlatform = verifyManagedCodexArtifactFixture({
      artifactRoot: value.root,
      expected: value.expected,
    }, {
      ...deps(),
      platform: () => 'linux',
    });
    assert.equal(wrongPlatform.reason, 'managed-codex-artifact-platform-unsupported');
  } finally {
    rmSync(value.parent, { recursive: true, force: true });
  }
});
