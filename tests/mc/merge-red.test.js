import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { loadRedPath, mergeRedPath, removeRedDetail, writeRedDetail } from '../../src/mc/merge-red.js';

test('a red only under load keeps its failures under a name a landing does not remove', () => {
  const root = mkdtempSync(join(tmpdir(), 'merge-red-'));
  try {
    const now = new Date('2026-10-19T20:00:00.000Z');
    const report = {
      ok: false, stopped_at: 'red-under-load', reason: 'tests/b.test.js red in the round, green alone',
      red_files: ['tests/b.test.js'], red_tests: [{ file: 'tests/b.test.js', name: 'b', error: 'timed out' }],
    };
    const path = writeRedDetail({ root, repo: 'memoro', pr: 7, report, now });
    assert.equal(path, loadRedPath(root, 'memoro', 7, 'red-under-load', now));
    assert.match(readFileSync(path, 'utf8'), /tests\/b\.test\.js/u);
    removeRedDetail({ root, repo: 'memoro', pr: 7 });
    assert.ok(existsSync(path), 'the landing removes the red file, not this one');
    assert.equal(writeRedDetail({ root, repo: 'memoro', pr: 7, report: { ok: false, stopped_at: 'busy' }, now }), null);
    assert.equal(writeRedDetail({ root, repo: 'memoro', pr: 7, report: { ok: false, stopped_at: 'red', reason: 'r' }, now }), mergeRedPath(root, 'memoro', 7));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
