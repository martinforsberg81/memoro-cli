/**
 * The time of each test a change touches (`mc gate`): what the reporter writes,
 * which tests a diff reaches, and the line the verdict prints for each.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import timesReporter from '../../src/mc/test-times-reporter.mjs';
import { changedRanges, measuredSeconds, testsMeasured, touchedTests } from '../../src/mc/test-times.js';
import { gateLines, timedTestLines, TIMED_LINES } from '../../src/mc/gate-local.js';

const cwd = '/w';
const lines = (entries) => `${entries.map((entry) => JSON.stringify(entry)).join('\n')}\n`;

/** The reporter's output for a list of node events. */
async function reported(events) {
  const out = [];
  for await (const chunk of timesReporter((async function* () { yield* events; })())) out.push(chunk);
  return out.join('');
}

describe('the reporter writes each test, and the file times as before', () => {
  it('a top-level test ends with its own line and the file line; a nested test has only its own line', async () => {
    const text = await reported([
      { type: 'test:start', data: { file: '/w/a.test.js', nesting: 0, name: 'top', line: 3 } },
      { type: 'test:start', data: { file: '/w/a.test.js', nesting: 1, name: 'inner', line: 5 } },
      { type: 'test:pass', data: { file: '/w/a.test.js', nesting: 1, name: 'inner', line: 5, details: { duration_ms: 40 } } },
      { type: 'test:pass', data: { file: '/w/a.test.js', nesting: 0, name: 'top', line: 3, details: { duration_ms: 1500 } } },
    ]);
    assert.deepEqual(text.trim().split('\n').map((line) => JSON.parse(line)), [
      { file: '/w/a.test.js', started: true },
      { file: '/w/a.test.js', test: { name: 'inner', line: 5, ms: 40 } },
      { file: '/w/a.test.js', test: { name: 'top', line: 3, ms: 1500 } },
      { file: '/w/a.test.js', done: true, ms: 1500 },
    ]);
  });

  it('a describe block is a suite: its tests are named, the block is not', async () => {
    const text = await reported([
      { type: 'test:pass', data: { file: '/w/a.test.js', nesting: 1, name: 'inner', line: 5, details: { duration_ms: 40, type: 'test' } } },
      { type: 'test:pass', data: { file: '/w/a.test.js', nesting: 0, name: 'suite', line: 4, details: { duration_ms: 41, type: 'suite' } } },
    ]);
    assert.deepEqual(testsMeasured(text, cwd).map((test) => test.name), ['inner']);
  });

  it('a test node gave no time for is named without one', async () => {
    const text = await reported([{ type: 'test:fail', data: { file: '/w/a.test.js', nesting: 0, name: 'x', line: 2, details: {} } }]);
    assert.deepEqual(testsMeasured(text, cwd), [{ file: 'a.test.js', name: 'x', line: 2, seconds: null }]);
  });
});

describe('what the times file says', () => {
  it('a test line adds nothing to the seconds of its file', () => {
    const text = lines([
      { file: '/w/a.js', test: { name: 'inner', line: 5, ms: 40 } },
      { file: '/w/a.js', done: true, ms: 1500 },
    ]);
    assert.deepEqual(measuredSeconds(text, cwd), { 'a.js': 1.5 });
  });

  it('testsMeasured names every test, repository-relative, and skips what is not a test line', () => {
    const text = `${lines([
      { file: '/w/tests/a.test.js', test: { name: 'one', line: 4, ms: 12.5 } },
      { file: '/w/tests/a.test.js', test: { name: 'two', line: 9, ms: 3 } },
      { file: '/w/tests/a.test.js', test: { name: 'no line' } },
      { file: '/w/tests/a.test.js', started: true },
    ])}not json\n`;
    assert.deepEqual(testsMeasured(text, cwd), [
      { file: 'tests/a.test.js', name: 'one', line: 4, seconds: 0.0125 },
      { file: 'tests/a.test.js', name: 'two', line: 9, seconds: 0.003 },
    ]);
  });
});

describe('which lines a diff changes', () => {
  it('each hunk gives its new-side lines; a deletion marks the line it lands on', () => {
    const diff = [
      'diff --git a/t.test.js b/t.test.js',
      '@@ -4 +4 @@',
      '@@ -10,2 +12,3 @@',
      '@@ -20,2 +22,0 @@',
      '@@ -0,0 +1,40 @@',
    ].join('\n');
    assert.deepEqual(changedRanges(diff), [[4, 4], [12, 14], [22, 23], [1, 40]]);
  });

  it('no diff, no ranges', () => {
    assert.deepEqual(changedRanges(''), []);
    assert.deepEqual(changedRanges(null), []);
  });
});

describe('which tests a change touches', () => {
  const tests = [
    { file: 'tests/a.test.js', name: 'first', line: 3, seconds: 0.1 },
    { file: 'tests/a.test.js', name: 'second', line: 10, seconds: 2 },
    { file: 'tests/a.test.js', name: 'third', line: 20, seconds: 0.5 },
    { file: 'tests/b.test.js', name: 'elsewhere', line: 2, seconds: 9 },
  ];

  it('a test is touched when a changed line falls in it, down to the line before the next test', () => {
    const names = touchedTests(tests, { 'tests/a.test.js': [[12, 12]] }).map((test) => test.name);
    assert.deepEqual(names, ['second']);
  });

  it('a change above the first test touches nothing in its file; a change at the next test line touches that test', () => {
    assert.deepEqual(touchedTests(tests, { 'tests/a.test.js': [[1, 2]] }), []);
    assert.deepEqual(touchedTests(tests, { 'tests/a.test.js': [[20, 20]] }).map((test) => test.name), ['third']);
  });

  it('a new file counts whole, and a file the change does not touch contributes nothing', () => {
    assert.deepEqual(touchedTests(tests, { 'tests/a.test.js': null }).map((test) => test.name), ['first', 'second', 'third']);
    assert.deepEqual(touchedTests(tests, {}), []);
  });

  it('a test node gave no time for is not printed', () => {
    const untimed = [{ file: 'tests/a.test.js', name: 'untimed', line: 3, seconds: null }];
    assert.deepEqual(touchedTests(untimed, { 'tests/a.test.js': null }), []);
  });
});

describe('the lines the verdict prints for them', () => {
  it('one line each, slowest first, in the form the session quotes', () => {
    const lines = timedTestLines([
      { file: 'tests/a.test.js', name: 'quick', line: 3, seconds: 0.0421 },
      { file: 'tests/a.test.js', name: 'slow', line: 9, seconds: 1.2 },
    ]);
    assert.deepEqual(lines, [
      'test tests/a.test.js › slow — 1.200 s',
      'test tests/a.test.js › quick — 0.042 s',
    ]);
  });

  it('no more than the limit, then a count of the rest', () => {
    const many = Array.from({ length: TIMED_LINES + 3 }, (_, i) => ({ file: 'a.test.js', name: `t${i}`, line: i + 1, seconds: i + 1 }));
    const lines = timedTestLines(many);
    assert.equal(lines.length, TIMED_LINES + 1);
    assert.match(lines.at(-1), /^… and 3 more timed tests/u);
  });

  it('nothing touched prints nothing', () => {
    assert.deepEqual(timedTestLines([]), []);
  });

  it('a green verdict says its timed tests above the line that names the whole output', () => {
    const text = gateLines({ ok: true, counts: { tests: 3, fail: 0 }, gates: [], failures: [], more: 0 }, {
      command: 'node --test a.test.js', seconds: 2, logPath: '/s/g.log', timed: ['test a.test.js › x — 0.100 s'],
    });
    assert.equal(text, 'GREEN — node --test a.test.js — 3 tests, 0 failed — 2s\ntest a.test.js › x — 0.100 s\nwhole output: /s/g.log');
  });
});
