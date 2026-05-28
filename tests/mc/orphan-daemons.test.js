/**
 * Pure-helper tests for §9j orphan daemon detection.
 *
 * Covers the canonical Unix definition we settled on: a heartbeat-loop
 * whose ppid == 1 has been reparented to init, which means its owning
 * Claude / Codex / Gemini process has died. That's the orphan signal.
 *
 * Buckets exercised:
 *   - stale (dead pid)          → safe to unlink pidfile, no SIGTERM
 *   - stale (unreadable file)   → same outcome
 *   - orphan (alive, ppid=1)    → SIGTERM eligible iff mtime > minAge
 *   - orphan (too fresh)        → stays in `live` until it ages
 *   - live (alive, real parent) → ignored
 *
 * Every external syscall is injected — no real ps / kill / unlink
 * executions in this suite.
 */
import test, { describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  scanDaemons,
  reapOrphans,
  parseLlmSessionId,
} from '../../src/mc/orphan-daemons.js';

function fixture() {
  // Five pidfiles simulating each branch of the scanner.
  const NOW = 10_000_000;
  const MIN_AGE = 5 * 60 * 1000;
  return {
    NOW,
    MIN_AGE,
    pidFiles: [
      '/tmp/heartbeat-aaa.pid',          // dead pid → stale
      '/tmp/heartbeat-bbb.pid',          // alive + ppid=1 + old → orphan
      '/tmp/heartbeat-ccc.pid',          // alive + ppid=1 + fresh → live (too new)
      '/tmp/heartbeat-ddd.pid',          // alive + ppid=42  → live (real parent)
      '/tmp/heartbeat-eee.pid',          // unreadable → stale (unreadable)
    ],
    readPidFile(f) {
      if (f.endsWith('aaa.pid')) return { pid: 1001, mtimeMs: NOW - 10 * 60 * 1000 };
      if (f.endsWith('bbb.pid')) return { pid: 1002, mtimeMs: NOW - 10 * 60 * 1000 };
      if (f.endsWith('ccc.pid')) return { pid: 1003, mtimeMs: NOW - 30 * 1000 };
      if (f.endsWith('ddd.pid')) return { pid: 1004, mtimeMs: NOW - 10 * 60 * 1000 };
      return null; // eee → unreadable
    },
    isAlive(pid) {
      return pid !== 1001; // 1001 is dead
    },
    getPpid(pid) {
      if (pid === 1002) return 1;     // reparented
      if (pid === 1003) return 1;     // reparented but too fresh
      if (pid === 1004) return 42;    // real parent
      return null;
    },
  };
}

describe('scanDaemons (§9j)', () => {
  test('buckets each pidfile by alive/reparented/age', () => {
    const fx = fixture();
    const scan = scanDaemons({
      pidDir: '/tmp',
      listPidFiles: () => fx.pidFiles,
      readPidFile: fx.readPidFile,
      isAlive: fx.isAlive,
      getPpid: fx.getPpid,
      minAgeMs: fx.MIN_AGE,
      now: fx.NOW,
    });

    assert.equal(scan.stale.length, 2, 'aaa (dead) + eee (unreadable)');
    assert.equal(scan.orphan.length, 1, 'bbb only');
    assert.equal(scan.live.length, 2, 'ccc (fresh) + ddd (real parent)');

    const orphan = scan.orphan[0];
    assert.equal(orphan.pid, 1002);
    assert.equal(orphan.ppid, 1);
    assert.equal(orphan.llmSessionId, 'bbb');
    assert.ok(orphan.ageMs >= fx.MIN_AGE);

    const staleReasons = scan.stale.map((s) => s.reason).sort();
    assert.deepEqual(staleReasons, ['dead-pid', 'unreadable']);
  });

  test('respects minAgeMs — fresh reparented daemons stay live', () => {
    const fx = fixture();
    // With minAge=0 the fresh reparented one flips to orphan.
    const scan = scanDaemons({
      pidDir: '/tmp',
      listPidFiles: () => fx.pidFiles,
      readPidFile: fx.readPidFile,
      isAlive: fx.isAlive,
      getPpid: fx.getPpid,
      minAgeMs: 0,
      now: fx.NOW,
    });
    assert.equal(scan.orphan.length, 2, 'bbb + ccc (no longer protected by minAge)');
    assert.equal(scan.live.length, 1, 'ddd only');
  });

  test('empty pid dir → all-empty result', () => {
    const scan = scanDaemons({
      listPidFiles: () => [],
      readPidFile: () => null,
      isAlive: () => true,
      getPpid: () => null,
    });
    assert.deepEqual(scan, { stale: [], orphan: [], live: [] });
  });
});

describe('reapOrphans (§9j)', () => {
  test('SIGTERMs orphans and unlinks stale pidfiles', () => {
    const fx = fixture();
    const scan = scanDaemons({
      pidDir: '/tmp',
      listPidFiles: () => fx.pidFiles,
      readPidFile: fx.readPidFile,
      isAlive: fx.isAlive,
      getPpid: fx.getPpid,
      minAgeMs: fx.MIN_AGE,
      now: fx.NOW,
    });
    const killed = [];
    const unlinked = [];
    const outcome = reapOrphans(scan, {
      kill: (pid) => { killed.push(pid); return true; },
      unlinkFile: (file) => { unlinked.push(file); return true; },
    });

    assert.deepEqual(killed, [1002], 'only the aged orphan');
    assert.equal(unlinked.length, 2, 'both stale pidfiles unlinked');
    assert.ok(outcome.reaped.every((r) => r.signaled));
    assert.ok(outcome.unlinked.every((u) => u.removed));
  });

  test('failed kill is reflected per-entry', () => {
    const fx = fixture();
    const scan = scanDaemons({
      pidDir: '/tmp',
      listPidFiles: () => fx.pidFiles,
      readPidFile: fx.readPidFile,
      isAlive: fx.isAlive,
      getPpid: fx.getPpid,
      minAgeMs: fx.MIN_AGE,
      now: fx.NOW,
    });
    const outcome = reapOrphans(scan, {
      kill: () => false,
      unlinkFile: () => false,
    });
    assert.ok(outcome.reaped.every((r) => r.signaled === false));
    assert.ok(outcome.unlinked.every((u) => u.removed === false));
  });
});

describe('parseLlmSessionId', () => {
  test('extracts the sanitised session id from heartbeat-<id>.pid', () => {
    assert.equal(parseLlmSessionId('/foo/bar/heartbeat-abc123.pid'), 'abc123');
    assert.equal(parseLlmSessionId('heartbeat-sess_x-1_2.pid'), 'sess_x-1_2');
    assert.equal(parseLlmSessionId('not-a-heartbeat.pid'), null);
  });
});
