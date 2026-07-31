import assert from 'node:assert/strict';
import test from 'node:test';
import {
  chmodSync, mkdtempSync, rmSync, symlinkSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  readProviderArtifactSync, validateProviderArtifact, writeProviderArtifactSync,
} from '../../../src/mc/broker/provider-artifact-journal.js';

const generation = '4f50f5a1-4c6b-4d6a-8b5c-152c5e6b8701';
function artifact(overrides = {}) {
  return {
    schema: 'mc-provider-artifact-v1', coding_session_id: 'sess_artifact',
    runtime_generation: generation, tool: 'codex', provider_session_id: 'cx_123',
    transcript_path: '/private/tmp/codex.jsonl', captured_at: '2026-07-28T12:00:00.000Z', ...overrides,
  };
}

test('provider artifact journal is idempotent and rejects a conflicting binding', () => {
  const dir = mkdtempSync(join(tmpdir(), 'mc-artifact-'));
  try {
    const path = join(dir, 'artifact.json');
    assert.equal(writeProviderArtifactSync({ path, artifact: artifact() }).duplicate, false);
    assert.equal(writeProviderArtifactSync({ path, artifact: artifact() }).duplicate, true);
    assert.throws(() => writeProviderArtifactSync({ path, artifact: artifact({ provider_session_id: 'cx_other' }) }), /different value/);
    assert.equal(readProviderArtifactSync({ path, codingSessionId: 'sess_artifact', runtimeGeneration: generation }).kind, 'present');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('provider artifact journal treats insecure files as unknown', () => {
  const dir = mkdtempSync(join(tmpdir(), 'mc-artifact-'));
  try {
    const path = join(dir, 'artifact.json');
    writeProviderArtifactSync({ path, artifact: artifact() });
    chmodSync(path, 0o644);
    assert.deepEqual(readProviderArtifactSync({ path }).kind, 'unknown');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('provider artifact journal rejects symlinked files and unsafe directories', () => {
  const dir = mkdtempSync(join(tmpdir(), 'mc-artifact-'));
  try {
    const target = join(dir, 'target.json');
    const link = join(dir, 'artifact.json');
    writeFileSync(target, `${JSON.stringify(artifact())}\n`, { mode: 0o600 });
    symlinkSync(target, link);
    assert.equal(readProviderArtifactSync({ path: link }).kind, 'unknown');
    rmSync(link);
    chmodSync(dir, 0o755);
    assert.equal(readProviderArtifactSync({ path: target }).kind, 'unknown');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('provider artifact journal rejects a symlink in the trusted directory chain', () => {
  const trustedRoot = mkdtempSync(join(tmpdir(), 'mc-artifact-root-'));
  const redirected = mkdtempSync(join(tmpdir(), 'mc-artifact-redirect-'));
  try {
    const hosts = join(trustedRoot, 'hosts');
    symlinkSync(redirected, hosts);
    const path = join(hosts, 'sess_artifact', 'provider-artifacts', `${generation}.json`);
    assert.throws(
      () => writeProviderArtifactSync({
        path,
        artifact: artifact(),
        trustedRoot,
      }),
      /directory chain is unsafe/,
    );
    assert.deepEqual(
      readProviderArtifactSync({ path, trustedRoot }),
      { kind: 'unknown', reason: 'unsafe-directory' },
    );
  } finally {
    rmSync(trustedRoot, { recursive: true, force: true });
    rmSync(redirected, { recursive: true, force: true });
  }
});

test('provider artifact journal creates and verifies a private trusted chain', () => {
  const trustedRoot = mkdtempSync(join(tmpdir(), 'mc-artifact-root-'));
  try {
    const path = join(
      trustedRoot,
      'hosts',
      'sess_artifact',
      'provider-artifacts',
      `${generation}.json`,
    );
    assert.equal(writeProviderArtifactSync({
      path,
      artifact: artifact(),
      trustedRoot,
    }).duplicate, false);
    assert.equal(readProviderArtifactSync({
      path,
      trustedRoot,
      codingSessionId: 'sess_artifact',
      runtimeGeneration: generation,
    }).kind, 'present');
  } finally {
    rmSync(trustedRoot, { recursive: true, force: true });
  }
});

test('provider artifact validation rejects non-string and invalid timestamps without throwing', () => {
  assert.deepEqual(validateProviderArtifact(artifact({ captured_at: null })).ok, false);
  assert.deepEqual(validateProviderArtifact(artifact({ captured_at: 'not-a-date' })).ok, false);
  assert.deepEqual(validateProviderArtifact(artifact({ provider_session_id: 'x'.repeat(129) })).ok, false);
});

test('provider artifact journal accepts bounded future provider ids without enumerating tools', () => {
  assert.equal(validateProviderArtifact(artifact({ tool: 'future-provider-v1' })).ok, true);
  assert.equal(validateProviderArtifact(artifact({ tool: '../future' })).ok, false);
});
