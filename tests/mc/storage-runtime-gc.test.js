import test, { afterEach, describe } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  acquireStorageLock,
  maybeRunAutomaticRuntimeGc,
  readStorageGcState,
  storageLockPath,
  writeStorageGcState,
} from '../../src/mc/storage-runtime-gc.js';

describe('automatic storage runtime gc', () => {
  let root = null;

  afterEach(() => {
    if (root) rmSync(root, { recursive: true, force: true });
    root = null;
  });

  test('runs runtime cleanup once and records throttle state', async () => {
    root = mkdtempSync(join(tmpdir(), 'mc-runtime-gc-'));
    let scanned = false;
    let reaped = false;

    const result = await maybeRunAutomaticRuntimeGc({
      mcDir: root,
      now: Date.parse('2026-07-18T10:00:00.000Z'),
      policy: { runtimeMinAgeMs: 123, runtimeGcThrottleMs: 0, lockStaleMs: 60_000 },
      scanRuntime: async ({ mcDir, minAgeMs }) => {
        scanned = true;
        assert.equal(mcDir, root);
        assert.equal(minAgeMs, 123);
        return {
          counts: { sidecar_candidates: 1 },
          daemons: { orphan: [], stale: [], live: [] },
          sidecars: { candidates: [{ path: join(root, 'hosts', 'old') }], counts: {} },
        };
      },
      reapRuntime: (scan) => {
        reaped = true;
        return { ok: true, counts: scan.counts, daemons: {}, sidecars: {} };
      },
    });

    assert.equal(result.ran, true);
    assert.equal(result.ok, true);
    assert.equal(scanned, true);
    assert.equal(reaped, true);
    assert.equal(existsSync(storageLockPath(root)), false);

    const state = readStorageGcState(root);
    assert.equal(state.last_runtime_gc_ok, true);
    assert.equal(state.last_runtime_gc_finished_at, '2026-07-18T10:00:00.000Z');
  });

  test('skips when the last run is still inside the throttle window', async () => {
    root = mkdtempSync(join(tmpdir(), 'mc-runtime-gc-'));
    writeStorageGcState(root, {
      last_runtime_gc_finished_at: '2026-07-18T10:00:00.000Z',
    });
    let scanned = false;

    const result = await maybeRunAutomaticRuntimeGc({
      mcDir: root,
      now: Date.parse('2026-07-18T10:05:00.000Z'),
      policy: { runtimeMinAgeMs: 0, runtimeGcThrottleMs: 10 * 60_000, lockStaleMs: 60_000 },
      scanRuntime: async () => {
        scanned = true;
        return {};
      },
      reapRuntime: () => ({ ok: true }),
    });

    assert.equal(result.ran, false);
    assert.equal(result.skipped, 'throttled');
    assert.equal(result.next_eligible_at, '2026-07-18T10:10:00.000Z');
    assert.equal(scanned, false);
  });

  test('skips when another process holds the storage lock', async () => {
    root = mkdtempSync(join(tmpdir(), 'mc-runtime-gc-'));
    const lock = acquireStorageLock(root, {
      now: Date.parse('2026-07-18T10:00:00.000Z'),
      staleMs: 60_000,
    });
    assert.equal(lock.acquired, true);

    try {
      let scanned = false;
      const result = await maybeRunAutomaticRuntimeGc({
        mcDir: root,
        now: Date.parse('2026-07-18T10:00:01.000Z'),
        policy: { runtimeMinAgeMs: 0, runtimeGcThrottleMs: 0, lockStaleMs: 60_000 },
        scanRuntime: async () => {
          scanned = true;
          return {};
        },
        reapRuntime: () => ({ ok: true }),
      });

      assert.equal(result.ran, false);
      assert.equal(result.skipped, 'locked');
      assert.equal(scanned, false);
    } finally {
      lock.release();
    }
  });
});
