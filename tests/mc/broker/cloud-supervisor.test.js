import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { describe } from 'node:test';

import {
  brokerConnectArgs,
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

  test('forceRestart stops an existing live connector before spawning', () => {
    const stopped = [];
    const removed = [];
    const writes = [];
    const res = ensureCloudBrokerConnected({
      pidPath: '/tmp/mc-cloud.pid',
      logPath: '/tmp/mc-cloud.log',
      readFile: () => '123',
      removeFile: (path) => { removed.push(path); },
      writeFile: (path, value, opts) => { writes.push({ path, value, opts }); },
      isAlive: (pid) => pid === 123,
      stopConnector: (spawned) => { stopped.push(spawned.pid); },
      spawnConnector: () => ({ ok: true, pid: 456 }),
      forceRestart: true,
    });

    assert.equal(res.ok, true);
    assert.equal(res.started, true);
    assert.equal(res.restarted, true);
    assert.equal(res.previous_pid, 123);
    assert.equal(res.pid, 456);
    assert.deepEqual(stopped, [123]);
    assert.deepEqual(removed, ['/tmp/mc-cloud.pid']);
    assert.deepEqual(writes, [{ path: '/tmp/mc-cloud.pid', value: '456', opts: { mode: 0o600 } }]);
  });

  test('passes source identity to a newly spawned connector', () => {
    let spawnOpts = null;
    const res = ensureCloudBrokerConnected({
      pidPath: '/tmp/mc-cloud.pid',
      logPath: '/tmp/mc-cloud.log',
      readFile: () => { throw new Error('missing'); },
      writeFile: () => {},
      isAlive: () => false,
      sourceId: 'cloud:cld_123456',
      sourceKind: 'cloud',
      sourceName: 'Memoro Cloud',
      cloudSessionId: 'cld_123456',
      spawnConnector: (opts) => {
        spawnOpts = opts;
        return { ok: true, pid: 456 };
      },
    });

    assert.equal(res.ok, true);
    assert.equal(spawnOpts.sourceId, 'cloud:cld_123456');
    assert.equal(spawnOpts.sourceKind, 'cloud');
    assert.equal(spawnOpts.sourceName, 'Memoro Cloud');
    assert.equal(spawnOpts.cloudSessionId, 'cld_123456');
  });

  test('stops spawned connector when pid registration fails', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mc-cloud-supervisor-'));
    try {
      const pidPath = join(dir, 'broker-cloud.pid');
      const logPath = join(dir, 'broker-cloud.log');
      let stopped = 0;
      const res = ensureCloudBrokerConnected({
        pidPath,
        logPath,
        readFile: () => { throw new Error('missing'); },
        writeFile: () => { throw new Error('permission denied'); },
        isAlive: () => false,
        spawnConnector: () => ({ ok: true, pid: 456, stop: () => { stopped += 1; } }),
      });

      assert.equal(res.ok, false);
      assert.match(res.error, /pid write failed/);
      assert.equal(stopped, 1);
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

describe('brokerConnectArgs', () => {
  test('renders source identity flags for cloud brokers', () => {
    assert.deepEqual(brokerConnectArgs({
      sourceId: 'cloud:cld_123456',
      sourceKind: 'cloud',
      sourceName: 'Memoro Cloud',
      cloudSessionId: 'cld_123456',
    }), [
      'broker',
      'connect',
      '--source-id',
      'cloud:cld_123456',
      '--source-kind',
      'cloud',
      '--source-name',
      'Memoro Cloud',
      '--cloud-session-id',
      'cld_123456',
    ]);
  });

  test('marks runtime broker connections without putting a credential in argv', () => {
    const args = brokerConnectArgs({
      sourceId: 'cloud:cld_123456',
      cloudSessionId: 'cld_123456',
      cloudRuntime: true,
    });

    assert.ok(args.includes('--cloud-runtime'));
    assert.equal(JSON.stringify(args).includes('token'), false);
    assert.equal(JSON.stringify(args).includes('secret'), false);
  });

  test('carries the runtime authorization binding to the foreground broker query', () => {
    const args = brokerConnectArgs({
      sourceId: 'cloud:cld_123456',
      cloudSessionId: 'cld_123456',
      cloudRuntime: true,
      runtimeGeneration: 'rtg_0123456789abcdef',
      authorizationDigest: 'a'.repeat(64),
    });

    assert.deepEqual(args.slice(-4), [
      '--runtime-generation', 'rtg_0123456789abcdef',
      '--authorization-digest', 'a'.repeat(64),
    ]);
  });
});
