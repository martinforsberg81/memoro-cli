/**
 * `mc work stop` says so (KP-09).
 *
 * The guard's `dead` is arithmetic and right, and it is also exactly what a
 * session looks like after PM stopped it on purpose — three knocks in one
 * night about sessions PM had just stopped (2026-08-24). The stop leaves a
 * mark in the area: who, when. The guard reads it and says "stopped by pm
 * 03:16"; the board shows it; opening the area removes it.
 */
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { stopWork } from '../../src/mc/work-stop.js';
import {
  STOP_GRACE_MS, clearStopMark, explainsStop, markStopped, readStopMark, stopMarkPath,
} from '../../src/mc/work-stop-marker.js';

function area() {
  const path = mkdtempSync(join(tmpdir(), 'mc-work-stop-'));
  return { name: 'alpha', path, worktrees: [] };
}

describe('the mark a stop leaves', () => {
  it('is written, read back, and removed', () => {
    const at = area();
    const written = markStopped(at.path, { by: 'pm', now: new Date('2026-08-24T03:16:00.000Z') });
    assert.deepEqual(written, { at: '2026-08-24T03:16:00.000Z', by: 'pm' });
    assert.deepEqual(readStopMark(at.path), written);
    clearStopMark(at.path);
    assert.equal(readStopMark(at.path), null);
    assert.equal(existsSync(stopMarkPath(at.path)), false);
  });

  it('is nothing when absent or unreadable', () => {
    const at = area();
    assert.equal(readStopMark(at.path), null);
  });

  it('explains a stop at or after the last movement, less the exit hooks, and nothing older', () => {
    const moved = Date.parse('2026-08-24T03:16:00.000Z');
    const mark = (offsetMs) => ({ at: new Date(moved + offsetMs).toISOString(), by: 'pm' });
    assert.equal(explainsStop(mark(5 * 60_000), moved), true, 'stopped after it last moved');
    assert.equal(explainsStop(mark(0), moved), true);
    assert.equal(explainsStop(mark(-STOP_GRACE_MS), moved), true, 'the hooks wrote a last line');
    assert.equal(explainsStop(mark(-STOP_GRACE_MS - 1), moved), false, 'older than that is a different stop');
    assert.equal(explainsStop(null, moved), false);
  });
});

describe('mc work stop', () => {
  const deps = (stopped) => ({
    stopBackground: () => stopped,
    toolProcesses: () => [],
    ownAncestry: () => new Set(),
  });

  it('marks the area as stopped by whoever asked, when something was stopped', () => {
    const at = area();
    const result = stopWork(at, {
      deps: deps({ kind: 'background', target: 'mc-alpha', graceful: true }),
      holder: { name: 'pm', kind: 'work-area' },
      now: new Date('2026-08-24T03:16:00.000Z'),
    });
    assert.deepEqual(result.marked, { at: '2026-08-24T03:16:00.000Z', by: 'pm' });
    assert.deepEqual(readStopMark(at.path), result.marked);
  });

  it('marks nothing when nothing was running — a later death is a death', () => {
    const at = area();
    const result = stopWork(at, { deps: deps(null), holder: { name: 'pm', kind: 'work-area' } });
    assert.equal(result.marked, null);
    assert.equal(readStopMark(at.path), null);
  });
});
