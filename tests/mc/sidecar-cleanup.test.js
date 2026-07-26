import assert from 'node:assert/strict';
import test, { describe } from 'node:test';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  reapRuntimeSidecars,
  reapZombieHosts,
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

  test('a pid-alive host that is not enumerable is a zombie, and its guards stay protected', async () => {
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

      // Never a plain removal candidate (processes are alive), never
      // silently ignored either: reported as a zombie host, with its
      // guard-bin protected while the processes live.
      assert.deepEqual(scan.candidates, []);
      assert.equal(scan.zombie_hosts.length, 1);
      assert.equal(scan.zombie_hosts[0].session_id, 'sess_pid_live');
      assert.equal(scan.zombie_hosts[0].pid, 123);
      assert.equal(scan.counts.kept.zombie, 1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('an enumerable pid-alive host is simply live, not a zombie', async () => {
    const root = mkdtempSync(join(tmpdir(), 'mc-sidecars-live-'));
    try {
      const hostDir = mkdir(join(root, 'hosts', 'sess_ok'));
      writeFileSync(join(hostDir, 'broker.pid'), '123\n');

      const scan = await scanRuntimeSidecars({
        mcDir: root,
        registry: { entries: [] },
        listSessions: async () => [{ id: 'sess_ok' }],
        isAlive: (pid) => pid === 123,
        minAgeMs: 0,
      });

      assert.deepEqual(scan.candidates, []);
      assert.deepEqual(scan.zombie_hosts, []);
      assert.equal(scan.counts.kept.live, 1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('reapZombieHosts terminates the process then removes the host dir', async () => {
    const root = mkdtempSync(join(tmpdir(), 'mc-sidecars-reap-'));
    try {
      const hostDir = mkdir(join(root, 'hosts', 'sess_zombie'));
      writeFileSync(join(hostDir, 'broker.pid'), '4242\n');
      const signals = [];
      let alive = true;
      const outcome = await reapZombieHosts([
        { kind: 'zombie-host', session_id: 'sess_zombie', path: hostDir, pid: 4242 },
      ], {
        isAlive: () => alive,
        kill: (pid, signal) => {
          signals.push([pid, signal]);
          alive = false;
        },
        sleep: async () => {},
        waitMs: 100,
      });

      assert.equal(outcome.ok, true);
      assert.deepEqual(outcome.removed.map((item) => item.session_id), ['sess_zombie']);
      assert.deepEqual(signals, [[4242, 'SIGTERM']]);
      assert.equal(existsSync(hostDir), false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('reapZombieHosts escalates to SIGKILL and reports a survivor without removing its dir', async () => {
    const root = mkdtempSync(join(tmpdir(), 'mc-sidecars-survivor-'));
    try {
      const hostDir = mkdir(join(root, 'hosts', 'sess_stuck'));
      const signals = [];
      const outcome = await reapZombieHosts([
        { kind: 'zombie-host', session_id: 'sess_stuck', path: hostDir, pid: 555 },
      ], {
        isAlive: () => true,
        kill: (pid, signal) => signals.push([pid, signal]),
        sleep: async () => {},
        waitMs: 1,
      });

      assert.equal(outcome.ok, false);
      assert.deepEqual(signals, [[555, 'SIGTERM'], [555, 'SIGKILL']]);
      assert.match(outcome.errors[0].error, /would not exit/);
      assert.equal(existsSync(hostDir), true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
