import assert from 'node:assert/strict';
import test, { describe } from 'node:test';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  reapRuntimeSidecars,
  scanRuntimeSidecars,
} from '../../src/mc/sidecar-cleanup.js';

function mkdir(path) {
  mkdirSync(path, { recursive: true });
  return path;
}

describe('runtime sidecar cleanup', () => {
  test('candidates exclude live and registry-referenced sidecars', async () => {
    const root = mkdtempSync(join(tmpdir(), 'mc-sidecars-'));
    try {
      mkdir(join(root, 'hosts', 'sess_live'));
      mkdir(join(root, 'hosts', 'sess_registered'));
      mkdir(join(root, 'hosts', 'sess_stale_host'));
      mkdir(join(root, 'guard-bin', 'sess_live'));
      mkdir(join(root, 'guard-bin', 'sess_registered'));
      mkdir(join(root, 'guard-bin', 'sess_stale_guard'));

      const scan = await scanRuntimeSidecars({
        mcDir: root,
        registry: {
          entries: [{ name: 'kept', coding_session_id: 'sess_registered' }],
        },
        listSessions: async () => [{ id: 'sess_live' }],
        minAgeMs: 0,
      });

      assert.deepEqual(scan.candidates.map((item) => [item.kind, item.session_id]).sort(), [
        ['guard-bin', 'sess_stale_guard'],
        ['host', 'sess_stale_host'],
      ]);
      assert.equal(scan.counts.kept.live, 2);
      assert.equal(scan.counts.kept.registered, 2);

      const outcome = reapRuntimeSidecars(scan);
      assert.equal(outcome.ok, true);
      assert.equal(existsSync(join(root, 'hosts', 'sess_stale_host')), false);
      assert.equal(existsSync(join(root, 'guard-bin', 'sess_stale_guard')), false);
      assert.equal(existsSync(join(root, 'hosts', 'sess_live')), true);
      assert.equal(existsSync(join(root, 'guard-bin', 'sess_registered')), true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('a live host broker pid preserves matching host and guard sidecars', async () => {
    const root = mkdtempSync(join(tmpdir(), 'mc-sidecars-pid-'));
    try {
      const hostDir = mkdir(join(root, 'hosts', 'sess_pid_live'));
      mkdir(join(root, 'guard-bin', 'sess_pid_live'));
      writeFileSync(join(hostDir, 'broker.pid'), '123\n');

      const scan = await scanRuntimeSidecars({
        mcDir: root,
        registry: { entries: [] },
        listSessions: async () => [],
        isAlive: (pid) => pid === 123,
        minAgeMs: 0,
      });

      assert.deepEqual(scan.candidates, []);
      assert.equal(scan.counts.kept.live, 2);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
