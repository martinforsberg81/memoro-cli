/**
 * What a run that has not ended says about its files (`runProgress`): a file
 * with a top-level test that started and did not end is unfinished, and a file
 * whose tests all ended is finished, with the seconds it took.
 */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { fileOutcomes, measuredSeconds, outputCut, progressTracker, runOutcomes, runProgress } from '../../src/mc/test-times.js';

const lines = (entries) => `${entries.map((entry) => JSON.stringify(entry)).join('\n')}\n`;

/** One run's times file, written from `entries`, read as the gate reads it. */
function withRun(entries, check) {
  const dir = mkdtempSync(join(tmpdir(), 'mc-progress-run-'));
  try {
    const path = join(dir, 'times.jsonl');
    writeFileSync(path, lines(entries));
    return check(path);
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

/** What the gate says of the asked files, from one run's progress and outcomes: `outputCut` and `fileOutcomes`. */
const verdict = (asked, progress, outcomes) => ({
  cut: outputCut(asked, { progress }),
  outcomes: fileOutcomes(asked, { progress, outcomes }).map((one) => one.outcome),
});

const judge = (entries, asked) => withRun(entries, (path) => verdict(asked, runProgress([path]), runOutcomes([path])));

describe('what a run that has not ended says about its files', () => {
  it('a file with a test that started and did not end is unfinished; the others are finished, slowest first', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mc-progress-'));
    try {
      const path = join(dir, 'times.jsonl');
      writeFileSync(path, `${lines([
        { file: '/w/tests/a.test.js', started: true },
        { file: '/w/tests/a.test.js', done: true, ms: 1200 },
        { file: '/w/tests/b.test.js', started: true },
        { file: '/w/tests/b.test.js', started: true },
        { file: '/w/tests/b.test.js', done: true, ms: 40 },
        { file: '/w/tests/c.test.js', started: true },
        { file: '/w/tests/c.test.js', done: true, ms: 3000 },
      ])}not json\n`);
      const progress = runProgress([path, join(dir, 'never-written.jsonl')]);
      assert.deepEqual(progress.unfinished, ['/w/tests/b.test.js']);
      assert.deepEqual(progress.finished, [
        { file: '/w/tests/c.test.js', seconds: 3 },
        { file: '/w/tests/a.test.js', seconds: 1.2 },
      ]);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('a file nobody started is in neither list: the caller knows which files it asked for', () => {
    assert.deepEqual(runProgress([]), { unfinished: [], finished: [], ended: [] });
  });

  it('the start lines add no seconds to the measured times', () => {
    const text = lines([{ file: '/w/a.js', started: true }, { file: '/w/a.js', done: true, ms: 500 }, { file: '/w/b.js', done: true }]);
    assert.deepEqual(measuredSeconds(text, '/w'), { 'a.js': 0.5 });
  });
});

it('completed reporter snapshots survive deletion and retain earlier batch timings', () => {
  const dir = mkdtempSync(join(tmpdir(), 'mc-progress-completed-'));
  try {
    const tracker = progressTracker();
    const earlier = join(dir, 'earlier.jsonl');
    const later = join(dir, 'later.jsonl');
    tracker.track(earlier);
    writeFileSync(earlier, lines([
      { file: '/w/slow.test.js', started: true },
      { file: '/w/slow.test.js', done: true, ms: 12000 },
    ]));
    tracker.complete(earlier);
    tracker.complete(earlier); // Completion is idempotent.
    rmSync(earlier);
    tracker.track(later);
    writeFileSync(later, lines([
      { file: '/w/fast.test.js', started: true },
      { file: '/w/fast.test.js', done: true, ms: 200 },
      { file: '/w/hang.test.js', started: true },
    ]));
    assert.deepEqual(tracker.read(), {
      unfinished: ['/w/hang.test.js'],
      finished: [{ file: '/w/slow.test.js', seconds: 12 }, { file: '/w/fast.test.js', seconds: 0.2 }],
      ended: [],
    });
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

it('a later unfinished rerun is not hidden by an earlier completed run of the same file', () => {
  const dir = mkdtempSync(join(tmpdir(), 'mc-progress-rerun-'));
  try {
    const tracker = progressTracker();
    const path = join(dir, 'times.jsonl');
    tracker.track(path);
    writeFileSync(path, lines([{ file: '/w/a.test.js', started: true }, { file: '/w/a.test.js', done: true, ms: 400 }]));
    tracker.complete(path);
    rmSync(path);
    tracker.track(path);
    writeFileSync(path, lines([{ file: '/w/a.test.js', started: true }]));
    assert.deepEqual(tracker.read(), { unfinished: ['/w/a.test.js'], finished: [], ended: [] });
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

it('outcomes().ended follows read().ended: a rerun that wrote no ended line leaves its file unended in both, and an ok file whose latest run ended stays in both', () => {
  const dir = mkdtempSync(join(tmpdir(), 'mc-progress-outcomes-ended-'));
  try {
    const tracker = progressTracker();
    const first = join(dir, 'first.jsonl');
    const rerun = join(dir, 'rerun.jsonl');
    tracker.track(first);
    writeFileSync(first, lines([
      { file: '/w/tests/a.test.js', ended: true, ok: true },
      { file: '/w/tests/b.test.js', ended: true, ok: true },
    ]));
    tracker.complete(first);
    rmSync(first);
    tracker.track(rerun);
    writeFileSync(rerun, lines([{ file: '/w/tests/a.test.js', started: true }]));
    assert.deepEqual(tracker.read().ended, ['/w/tests/b.test.js']);
    assert.deepEqual(tracker.outcomes().ended, ['/w/tests/b.test.js']);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

describe('whether an asked file is whole: its own ended line, and no top-level test left started', () => {
  it('(a) an asked file whose lines all balance but which wrote no ended line is cut, and unfinished', () => {
    assert.deepEqual(judge([
      { file: '/w/tests/a.test.js', started: true },
      { file: '/w/tests/a.test.js', done: true, ms: 40 },
    ], ['tests/a.test.js']), { cut: ['tests/a.test.js'], outcomes: ['unfinished'] });
  });

  it('(b) an asked file that wrote an ok ended line is whole and passed, beside balanced lines of a helper it calls', () => {
    assert.deepEqual(judge([
      { file: '/w/tests/_helper.js', started: true },
      { file: '/w/tests/_helper.js', done: true, ms: 40 },
      { file: '/w/tests/one.test.js', ended: true, ok: true },
    ], ['tests/one.test.js']), { cut: [], outcomes: ['passed'] });
  });

  it('(b) an asked file that wrote a failed ended line is whole and failed', () => {
    assert.deepEqual(judge([
      { file: '/w/tests/one.test.js', started: true },
      { file: '/w/tests/one.test.js', done: true, ms: 40 },
      { file: '/w/tests/one.test.js', ended: true, ok: false },
    ], ['tests/one.test.js']), { cut: [], outcomes: ['failed'] });
  });

  it('(c) an asked file that nothing named is cut, and not-started; a balanced file that was not asked is not cut', () => {
    assert.deepEqual(judge([
      { file: '/w/tests/other.test.js', started: true },
      { file: '/w/tests/other.test.js', done: true, ms: 1 },
    ], ['tests/a.test.js']), { cut: ['tests/a.test.js'], outcomes: ['not-started'] });
  });

  it('(d) with no file asked, outputCut is the unfinished paths, as before; with asked files, an unfinished path not asked is still cut', () => {
    withRun([
      { file: '/w/tests/a.test.js', started: true },
      { file: '/w/tests/a.test.js', done: true, ms: 1 },
      { file: '/w/tests/hang.test.js', started: true },
    ], (path) => {
      const progress = runProgress([path]);
      assert.deepEqual(outputCut([], { progress }), ['/w/tests/hang.test.js']);
      assert.deepEqual(outputCut(['tests/a.test.js'], { progress }), ['tests/a.test.js', '/w/tests/hang.test.js']);
    });
    withRun([
      { file: '/w/tests/a.test.js', started: true },
      { file: '/w/tests/a.test.js', done: true, ms: 1 },
      { file: '/w/tests/a.test.js', ended: true, ok: true },
    ], (path) => assert.deepEqual(outputCut([], { progress: runProgress([path]) }), []));
  });

  it('(e) the tracker carries ended files across completed runs, so the asked-file rule holds through it', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mc-progress-ended-'));
    try {
      const tracker = progressTracker();
      const first = join(dir, 'first.jsonl');
      const second = join(dir, 'second.jsonl');
      tracker.track(first);
      writeFileSync(first, lines([
        { file: '/w/tests/one.test.js', ended: true, ok: true },
        { file: '/w/tests/bal.test.js', started: true },
        { file: '/w/tests/bal.test.js', done: true, ms: 5 },
      ]));
      tracker.complete(first);
      rmSync(first);
      tracker.track(second);
      writeFileSync(second, lines([
        { file: '/w/tests/_helper.js', started: true },
        { file: '/w/tests/_helper.js', done: true, ms: 9 },
      ]));
      assert.deepEqual(tracker.read().ended, ['/w/tests/one.test.js']);
      assert.deepEqual(verdict(['tests/one.test.js', 'tests/bal.test.js'], tracker.read(), tracker.outcomes()),
        { cut: ['tests/bal.test.js'], outcomes: ['passed', 'unfinished'] });
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('(e) an earlier run that ended a file does not whole a later rerun of it that wrote no ended line', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mc-progress-rerun-ended-'));
    try {
      const tracker = progressTracker();
      const first = join(dir, 'first.jsonl');
      const second = join(dir, 'second.jsonl');
      tracker.track(first);
      writeFileSync(first, lines([{ file: '/w/tests/one.test.js', ended: true, ok: true }]));
      tracker.complete(first);
      rmSync(first);
      tracker.track(second);
      writeFileSync(second, lines([
        { file: '/w/tests/one.test.js', started: true },
        { file: '/w/tests/one.test.js', done: true, ms: 5 },
      ]));
      assert.deepEqual(verdict(['tests/one.test.js'], tracker.read(), tracker.outcomes()),
        { cut: ['tests/one.test.js'], outcomes: ['unfinished'] });
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});
