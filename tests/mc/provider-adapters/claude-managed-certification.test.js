import assert from 'node:assert/strict';
import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  inspectManagedClaudeCertificationSync,
  managedClaudeC1SourceClosureDigest,
  writeManagedClaudeCertificationSync,
} from '../../../src/mc/provider-adapters/claude-managed-certification.js';

test('managed Claude certification binds the exact C1 source and artifact substrate', () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'mc-claude-cert-')));
  chmodSync(root, 0o700);
  try {
    const written = writeManagedClaudeCertificationSync({
      root,
      checkedAt: '2026-07-29T10:00:00.000Z',
    });
    assert.equal(written.ok, true);
    assert.equal(
      written.receipt.source_closure_sha256,
      managedClaudeC1SourceClosureDigest(),
    );
    const inspected = inspectManagedClaudeCertificationSync({ root });
    assert.equal(inspected.ok, true);
    assert.equal(inspected.receipt.status, 'passed');

    const changed = JSON.parse(readFileSync(written.path, 'utf8'));
    changed.srt_tree_sha256 = '0'.repeat(64);
    writeFileSync(written.path, `${JSON.stringify(changed)}\n`, { mode: 0o600 });
    assert.equal(
      inspectManagedClaudeCertificationSync({ root }).reason,
      'managed-claude-certification-stale',
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
