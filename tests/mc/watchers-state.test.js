/**
 * The watchers on the board — the last silent link (KP-08 point 1).
 */
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { renderLines } from '../../src/mc/status-render.js';
import { watchStatePath } from '../../src/mc/watch-paths.js';
import { watcherWord, watchersState } from '../../src/mc/watchers-state.js';

describe('watchersState', () => {
  it('a fresh home: all four never started', () => {
    const root = mkdtempSync(join(tmpdir(), 'mc-watchers-'));
    try {
      const state = watchersState({ root });
      // The main-watch joined the row (D-0190/D-0199, 2026-08-24).
      assert.deepEqual(Object.keys(state).sort(), ['main', 'pm', 'repo', 'sessions']);
      for (const name of ['pm', 'sessions', 'repo', 'main']) assert.equal(watcherWord(state[name]), 'never-started', name);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('a pid file whose process is gone is NOT RUNNING — stopped without telling anyone', () => {
    const root = mkdtempSync(join(tmpdir(), 'mc-watchers-'));
    try {
      mkdirSync(join(root, 'watch'), { recursive: true });
      writeFileSync(watchStatePath('pm', root), JSON.stringify({ schema: 'mc-watch', version: 1, target: 'pm', pid: 2147483000, started_at: '2026-08-22T20:00:00Z', interval_ms: 1800000 }));
      const state = watchersState({ root });
      assert.equal(state.pm.abandoned, true);
      assert.equal(watcherWord(state.pm), 'not-running');
      assert.equal(watcherWord(state.sessions), 'never-started');
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('the words: alive, stale, not-running, never-started, unknown', () => {
    assert.equal(watcherWord({ running: true, stale: false }), 'alive');
    assert.equal(watcherWord({ running: true, stale: true }), 'stale');
    assert.equal(watcherWord({ running: false, abandoned: true }), 'not-running');
    assert.equal(watcherWord({ running: false, abandoned: false }), 'never-started');
    assert.equal(watcherWord(null), 'unknown');
  });
});

describe('the watch row on the page', () => {
  const page = (watchers) => renderLines({ areas: [], summary: { areas: 0, waiting: 0, working: 0 }, watchers }, { columns: 160, now: 60 * 60000 }).join('\n');
  it('says alive with the last round, stale, not running and never started — each in its own words', () => {
    const text = page({
      pm: { running: true, stale: false, last_write_age_ms: 3 * 60000, abandoned: false },
      sessions: { running: false, stale: null, last_write_age_ms: null, abandoned: true },
      repo: { running: false, stale: null, last_write_age_ms: null, abandoned: false },
    });
    assert.match(text, /watch {2}watch pm: alive, last round 3m {2}· {2}watch sessions: NOT RUNNING — stopped without telling anyone {2}· {2}repo watch: never started/u);
    assert.match(page({ pm: { running: true, stale: true, last_write_age_ms: 95 * 60000 } }), /watch pm: alive but stale — no round in 2h/u);
  });
  it('and nothing when the report carries no watchers', () => {
    assert.doesNotMatch(page(undefined), /watch pm/u);
  });
});
