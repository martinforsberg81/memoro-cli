/**
 * Red, and since when.
 *
 * The guarantees under test: a test red in two runs is named with the
 * timestamp of the *first* of them; a test that goes green and breaks again is
 * dated to when it broke again, not to the first time it was ever seen; a test
 * that passes in the latest run is gone from the report entirely; and a run
 * that produced no suite result is never mistaken for a run that found nothing
 * — not in the reading, and not in the streak.
 */
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, it } from 'node:test';

import {
  HISTORY_LIMIT, nightlyHistoryPath, nightlyReading, readNightlyHistory, recordNightlyRun,
} from '../../src/mc/nightly-history.js';
import { nightlyTick } from '../../src/mc/nightly-loop.js';
import { gateLockPath } from '../../src/mc/gate-lock.js';

const REPO = '/repos/memoro';
const home = () => mkdtempSync(join(tmpdir(), 'mc-nightly-history-'));

const DAY = 24 * 60 * 60 * 1000;
const START = Date.parse('2026-09-01T03:00:00Z');
const day = (n) => new Date(START + n * DAY).toISOString();

/** One measured run: it reached its summary, and these names were red. */
function measured(n, red, { commit = `${n}`.repeat(40).slice(0, 40), tests = 17_982 } = {}) {
  return {
    repo: 'memoro', path: REPO, started_at: day(n), duration_ms: 302_300,
    commit, verdict: red.length ? 'red' : 'green', stopped_at: red.length ? 'red' : null,
    reason: null, red, tests,
  };
}

/** One run that produced no suite result at all. */
function stopped(n, stopped_at = 'busy', reason = 'another gate round is running') {
  return {
    repo: 'memoro', path: REPO, started_at: day(n), duration_ms: 9000,
    commit: null, verdict: 'stopped', stopped_at, reason, red: null, tests: null,
  };
}

function store(root, ...runs) {
  for (const run of runs) recordNightlyRun(run, { root });
}

describe('since when', () => {
  it('names a test red in two runs with the first run that saw it', () => {
    const root = home();
    try {
      store(root, measured(0, ['data-bus event names']), measured(1, ['data-bus event names']));
      const reading = nightlyReading(REPO, { root });

      assert.equal(reading.runs, 2);
      assert.equal(reading.measured.at, day(1), 'the reading is about the latest run');
      assert.equal(reading.red.length, 1);
      assert.equal(reading.red[0].name, 'data-bus event names');
      // The whole point: the *first* run that saw it, not the most recent.
      assert.equal(reading.red[0].since, day(0));
      assert.equal(reading.red[0].since_commit, '0'.repeat(40));
      assert.equal(reading.red[0].runs, 2);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('a test that went green and broke again is dated to when it broke again', () => {
    const root = home();
    try {
      // Monday red, Tuesday green, Wednesday red — red since Wednesday. The
      // wrong reading (earliest occurrence anywhere) says Monday, and looks
      // identical to the right one on every history where nothing ever passed.
      store(root, measured(0, ['flaky']), measured(1, []), measured(2, ['flaky']));
      const reading = nightlyReading(REPO, { root });

      assert.equal(reading.red[0].since, day(2));
      assert.equal(reading.red[0].runs, 1);
      assert.equal(reading.red[0].bounded, false, 'a green run before it is not the edge of the history');
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('a test that passes in the latest run is gone from the report', () => {
    const root = home();
    try {
      store(root, measured(0, ['fixed', 'still red']), measured(1, ['still red']));
      const reading = nightlyReading(REPO, { root });

      assert.deepEqual(reading.red.map((red) => red.name), ['still red']);
      assert.equal(reading.measured.red, 1);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('one run says so, rather than dating everything to the day it shipped', () => {
    const root = home();
    try {
      store(root, measured(0, ['data-bus event names']));
      const [red] = nightlyReading(REPO, { root }).red;
      assert.equal(red.runs, 1);
      assert.equal(red.bounded, true, 'there is nothing before it to disagree');
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('a streak that reaches the oldest run kept is a floor, not a date', () => {
    const root = home();
    try {
      store(root, measured(0, ['old']), measured(1, ['old']), measured(2, ['old']));
      const [red] = nightlyReading(REPO, { root }).red;
      assert.equal(red.since, day(0));
      assert.equal(red.runs, 3);
      assert.equal(red.bounded, true);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('the oldest standing red comes first, whatever order the names are in', () => {
    const root = home();
    try {
      store(root, measured(0, ['zeta']), measured(1, ['zeta']), measured(2, ['alpha', 'zeta']));
      const reading = nightlyReading(REPO, { root });
      assert.deepEqual(reading.red.map((red) => red.name), ['zeta', 'alpha']);
      assert.equal(reading.red[0].since, day(0));
      assert.equal(reading.red[1].since, day(2));
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('a third, older run pasted into the store by hand moves the date back', () => {
    const root = home();
    try {
      store(root, measured(1, ['data-bus event names']), measured(2, ['data-bus event names']));
      assert.equal(nightlyReading(REPO, { root }).red[0].since, day(1));

      // Martin's second check, and the reason the store is sorted by its
      // timestamps rather than by its file order: an entry a person adds by
      // hand is added at the end and is usually the oldest one.
      const path = nightlyHistoryPath(REPO, root);
      const raw = JSON.parse(readFileSync(path, 'utf8'));
      raw.runs.push({
        at: day(0), duration_ms: 1, commit: 'f'.repeat(40), outcome: 'failed',
        stopped_at: 'red', reason: null, tests: 17_982, red: ['data-bus event names'],
      });
      writeFileSync(path, JSON.stringify(raw));

      const moved = nightlyReading(REPO, { root });
      assert.equal(moved.red[0].since, day(0));
      assert.equal(moved.red[0].runs, 3);
      assert.equal(moved.measured.at, day(2), 'the newest run is still the newest');
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});

describe('a run that could not measure', () => {
  it('is not a run that found nothing', () => {
    const root = home();
    try {
      store(root, measured(0, ['data-bus event names']), stopped(1));
      const reading = nightlyReading(REPO, { root });

      // The last attempt measured nothing; the last measurement still stands.
      assert.equal(reading.last.outcome, 'incomplete');
      assert.equal(reading.last.stopped_at, 'busy');
      assert.equal(reading.last.red, null, 'a run that never ran must not carry an empty red set');
      assert.equal(reading.measured.at, day(0));
      assert.equal(reading.measured.outcome, 'failed');
      assert.deepEqual(reading.red.map((red) => red.name), ['data-bus event names']);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('breaks no streak and starts none — it is evidence of nothing', () => {
    const root = home();
    try {
      store(root, measured(0, ['standing']), stopped(1), stopped(2, 'threw', 'git fetch failed'), measured(3, ['standing']));
      const [red] = nightlyReading(REPO, { root }).red;
      assert.equal(red.since, day(0), 'two stopped runs read as a green day');
      assert.equal(red.runs, 2, 'a run that measured nothing was counted as a run that saw it red');
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('a history of nothing but stopped runs reports no measurement at all', () => {
    const root = home();
    try {
      store(root, stopped(0), stopped(1));
      const reading = nightlyReading(REPO, { root });
      assert.equal(reading.runs, 2);
      assert.equal(reading.measured, null);
      assert.deepEqual(reading.red, []);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});

describe('the store', () => {
  it('keeps a bounded history, oldest dropped', () => {
    const root = home();
    try {
      for (let n = 0; n < HISTORY_LIMIT + 4; n += 1) store(root, measured(n, ['old']));
      const { runs } = readNightlyHistory(REPO, { root });
      assert.equal(runs.length, HISTORY_LIMIT);
      assert.equal(runs[0].at, day(4), 'the oldest runs were not dropped');
      assert.equal(runs.at(-1).at, day(HISTORY_LIMIT + 3));
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('stores names and nothing else — no output, no stack traces', () => {
    const root = home();
    try {
      store(root, measured(0, ['data-bus event names']));
      const raw = JSON.parse(readFileSync(nightlyHistoryPath(REPO, root), 'utf8'));
      assert.deepEqual(Object.keys(raw.runs[0]).sort(), [
        'at', 'commit', 'duration_ms', 'outcome', 'reason', 'red', 'stopped_at', 'tests',
      ]);
      assert.equal(raw.path, REPO);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('a store that is absent, unreadable or from another version reads as no runs', () => {
    const root = home();
    try {
      assert.deepEqual(nightlyReading(REPO, { root }), { runs: 0, last: null, measured: null, red: [] });
      mkdirSync(dirname(nightlyHistoryPath(REPO, root)), { recursive: true });
      writeFileSync(nightlyHistoryPath(REPO, root), 'half a fi');
      assert.equal(nightlyReading(REPO, { root }).runs, 0);
      writeFileSync(nightlyHistoryPath(REPO, root), JSON.stringify({ schema: 'mc-nightly-history', version: 99, runs: [{ at: day(0), red: [] }] }));
      assert.equal(nightlyReading(REPO, { root }).runs, 0);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('two repositories keep two histories', () => {
    const root = home();
    try {
      store(root, measured(0, ['memoro red']));
      recordNightlyRun({ ...measured(0, ['cli red']), repo: 'memoro-cli', path: '/repos/memoro-cli' }, { root });
      assert.deepEqual(nightlyReading(REPO, { root }).red.map((r) => r.name), ['memoro red']);
      assert.deepEqual(nightlyReading('/repos/memoro-cli', { root }).red.map((r) => r.name), ['cli red']);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});

describe('the tick writes it', () => {
  it('one entry per repository measured, with the names and the commit', async () => {
    const root = home();
    try {
      await nightlyTick({
        root,
        repos: [{ name: 'memoro', path: REPO }],
        round: () => ({
          full: true, verdict: 'red', stopped_at: 'red', reason: 'red',
          started_at: day(0), duration_ms: 302_300,
          base: { ref: 'origin/main', commit: 'c'.repeat(40) },
          candidate: { commit: 'c'.repeat(40), red: ['data-bus event names'], totals: { tests: 17_982, finished: true } },
        }),
      });
      const reading = nightlyReading(REPO, { root });
      assert.equal(reading.runs, 1);
      assert.equal(reading.measured.outcome, 'failed');
      assert.equal(reading.measured.commit, 'c'.repeat(40));
      assert.deepEqual(reading.red.map((red) => red.name), ['data-bus event names']);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('and one for the tick that skipped, so a week behind merge rounds is visible', async () => {
    const root = home();
    try {
      store(root, measured(0, ['data-bus event names']));
      writeFileSync(gateLockPath(root), JSON.stringify({
        pid: process.pid, repo: 'memoro', pr: 11082, since: day(1),
      }));
      await nightlyTick({ root, repos: [{ name: 'memoro', path: REPO }], round: () => { throw new Error('the tick ran a round'); } });

      const reading = nightlyReading(REPO, { root });
      assert.equal(reading.runs, 2);
      assert.equal(reading.last.outcome, 'incomplete');
      assert.equal(reading.last.stopped_at, 'busy');
      assert.match(reading.last.reason, /another gate round is running/u);
      // And the reading it could not replace still stands, still dated.
      assert.equal(reading.measured.at, day(0));
      assert.equal(reading.red[0].since, day(0));
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});
