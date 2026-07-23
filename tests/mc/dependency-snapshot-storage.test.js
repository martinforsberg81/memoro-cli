import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  reapDependencySnapshots,
  scanDependencySnapshots,
} from '../../src/mc/dependency-snapshot-storage.js';

describe('dependency snapshot storage', () => {
  test('inventories snapshots and removes only old unlocked mc cache entries', () => {
    const root = mkdtempSync(join(tmpdir(), 'mc-snapshot-storage-'));
    const mcDir = join(root, 'mc');
    const npmRoot = join(mcDir, 'dependency-snapshots', 'v1', 'npm');
    const locksRoot = join(mcDir, 'dependency-snapshots', 'v1', 'locks');
    const readyDigest = 'a'.repeat(64);
    const lockedDigest = 'b'.repeat(64);
    const invalidDigest = 'c'.repeat(64);
    const temporary = `${'d'.repeat(64)}.tmp-test`;
    mkdirSync(locksRoot, { recursive: true });
    writeSnapshot(npmRoot, readyDigest, { ready: true });
    writeSnapshot(npmRoot, lockedDigest, { ready: true });
    writeSnapshot(npmRoot, invalidDigest, { ready: false });
    mkdirSync(join(npmRoot, temporary), { recursive: true });
    writeFileSync(join(locksRoot, `${lockedDigest}.lock`), '{}');
    mkdirSync(join(npmRoot, 'unrelated'), { recursive: true });

    try {
      const scan = scanDependencySnapshots({ mcDir, minAgeMs: 0 });
      assert.deepEqual(scan.counts, {
        total: 4,
        ready: 2,
        invalid: 1,
        temporary: 1,
        locked: 1,
        candidates: 3,
      });
      assert.equal(scan.reclaimable_bytes > 0, true);
      assert.deepEqual(scan.candidates.map((item) => item.state).sort(), ['invalid', 'ready', 'temporary']);

      const outcome = reapDependencySnapshots(scan);
      assert.equal(outcome.ok, true);
      assert.equal(outcome.removed.length, 3);
      assert.equal(existsSync(join(npmRoot, readyDigest)), false);
      assert.equal(existsSync(join(npmRoot, invalidDigest)), false);
      assert.equal(existsSync(join(npmRoot, temporary)), false);
      assert.equal(existsSync(join(npmRoot, lockedDigest)), true);
      assert.equal(existsSync(join(npmRoot, 'unrelated')), true);
      assert.equal(existsSync(join(locksRoot, `${readyDigest}.lock`)), false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('keeps recent snapshots by default', () => {
    const root = mkdtempSync(join(tmpdir(), 'mc-snapshot-recent-'));
    const mcDir = join(root, 'mc');
    const digest = 'e'.repeat(64);
    try {
      writeSnapshot(join(mcDir, 'dependency-snapshots', 'v1', 'npm'), digest, { ready: true });
      const scan = scanDependencySnapshots({ mcDir });
      assert.equal(scan.counts.ready, 1);
      assert.equal(scan.counts.candidates, 0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

function writeSnapshot(root, digest, { ready }) {
  const path = join(root, digest);
  mkdirSync(path, { recursive: true });
  if (ready) mkdirSync(join(path, 'node_modules'), { recursive: true });
  writeFileSync(join(path, 'metadata.json'), JSON.stringify({
    schema_version: 1,
    fingerprint: `sha256:${digest}`,
    created_at: new Date().toISOString(),
  }));
}
