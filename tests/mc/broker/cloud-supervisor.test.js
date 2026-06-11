import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { describe } from 'node:test';

import {
  ensureCloudBrokerConnected,
  isProcessAlive,
  resolveMcBinPath,
} from '../../../src/mc/broker/cloud-supervisor.js';

describe('ensureCloudBrokerConnected', () => {
  test('returns existing live connector from pid file without spawning', () => {
    let spawned = false;
    const res = ensureCloudBrokerConnected({
      pidPath: '/tmp/mc-cloud.pid',
      logPath: '/tmp/mc-cloud.log',
      readFile: () => '123',
      isAlive: (pid) => pid === 123,
      spawnConnector: () => {
        spawned = true;
        return { ok: true, pid: 456 };
      },
    });

    assert.equal(res.ok, true);
    assert.equal(res.alreadyRunning, true);
    assert.equal(res.pid, 123);
    assert.equal(spawned, false);
  });

  test('removes stale pid file and records spawned connector pid', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mc-cloud-supervisor-'));
    try {
      const pidPath = join(dir, 'broker-cloud.pid');
      const logPath = join(dir, 'broker-cloud.log');
      const removed = [];
      const writes = [];
      const res = ensureCloudBrokerConnected({
        pidPath,
        logPath,
        readFile: () => '123',
        removeFile: (path) => { removed.push(path); },
        writeFile: (path, value, opts) => { writes.push({ path, value, opts }); },
        isAlive: () => false,
        spawnConnector: () => ({ ok: true, pid: 456 }),
        now: () => Date.parse('2026-06-11T08:00:00.000Z'),
      });

      assert.equal(res.ok, true);
      assert.equal(res.started, true);
      assert.equal(res.pid, 456);
      assert.deepEqual(removed, [pidPath]);
      assert.deepEqual(writes, [{ path: pidPath, value: '456', opts: { mode: 0o600 } }]);
      assert.equal(res.started_at, '2026-06-11T08:00:00.000Z');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('isProcessAlive', () => {
  test('rejects invalid pids without probing the process table', () => {
    assert.equal(isProcessAlive(0), false);
    assert.equal(isProcessAlive(-1), false);
    assert.equal(isProcessAlive(Number.NaN), false);
  });
});

describe('resolveMcBinPath', () => {
  test('falls back to the module-relative mc binary when argv has no script path', () => {
    assert.match(resolveMcBinPath(['node']), /src\/bin-mc\.js$/);
  });

  test('uses the current CLI script path when present', () => {
    assert.equal(resolveMcBinPath(['node', '/tmp/mc']), '/tmp/mc');
  });
});
