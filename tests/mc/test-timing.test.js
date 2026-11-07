/**
 * The time of each test a change touches (`mc gate`): what the reporter writes,
 * which tests a diff reaches, and the line the verdict prints for each.
 */
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import timesReporter from '../../src/mc/test-times-reporter.mjs';
import { changedRanges, measuredSeconds, readTooSlow, recordTooSlow, SLOW_LINES, SLOW_TEST_MS, slowTestLines, slowTests, testsMeasured, tooSlowPath, touchedTests } from '../../src/mc/test-times.js';
import { gateLines, timedTestLines, TIMED_LINES } from '../../src/mc/gate-local.js';

const cwd = '/w';
const lines = (entries) => `${entries.map((entry) => JSON.stringify(entry)).join('\n')}\n`;
const ended = { failed: false, timeout: null };

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

  it('a test node gave no time for is named without one, and a failed test says so', async () => {
    const text = await reported([{ type: 'test:fail', data: { file: '/w/a.test.js', nesting: 0, name: 'x', line: 2, details: {} } }]);
    assert.deepEqual(testsMeasured(text, cwd), [{ file: 'a.test.js', name: 'x', line: 2, seconds: null, failed: true, timeout: null }]);
  });

  it('a test node cut at its limit carries the limit; any other failure does not', async () => {
    const cut = { failureType: 'testTimeoutFailure', code: 'ERR_TEST_FAILURE', message: 'test timed out after 1000ms' };
    const broke = { failureType: 'testCodeFailure', code: 'ERR_TEST_FAILURE', message: 'timed out after 1000ms waiting for the server' };
    const text = await reported([
      { type: 'test:fail', data: { file: '/w/a.test.js', nesting: 1, name: 'slow', line: 4, details: { duration_ms: 1003, error: cut } } },
      { type: 'test:fail', data: { file: '/w/a.test.js', nesting: 1, name: 'broken', line: 9, details: { duration_ms: 12, error: broke } } },
    ]);
    assert.deepEqual(testsMeasured(text, cwd), [
      { file: 'a.test.js', name: 'slow', line: 4, seconds: 1.003, failed: true, timeout: 1000 },
      { file: 'a.test.js', name: 'broken', line: 9, seconds: 0.012, failed: true, timeout: null },
    ]);
  });

  it('a skipped or todo test ran nothing and gets no line', async () => {
    const text = await reported([
      { type: 'test:pass', data: { file: '/w/a.test.js', nesting: 0, name: 'skipped', line: 2, skip: true, details: { duration_ms: 1 } } },
      { type: 'test:pass', data: { file: '/w/a.test.js', nesting: 0, name: 'todo', line: 3, todo: 'later', details: { duration_ms: 1 } } },
      { type: 'test:pass', data: { file: '/w/a.test.js', nesting: 0, name: 'ran', line: 4, details: { duration_ms: 1 } } },
    ]);
    assert.deepEqual(testsMeasured(text, cwd).map((test) => test.name), ['ran']);
  });
});

describe('the too-slow file', () => {
  const root = () => mkdtempSync(join(tmpdir(), 'mc-too-slow-'));
  const slow = (name, timeout = 1000) => ({ file: 'tests/a.test.js', name, line: 1, seconds: timeout / 1000, failed: true, timeout });
  const green = (name, seconds = 0.2) => ({ file: 'tests/a.test.js', name, line: 1, seconds, failed: false, timeout: null });
  const red = (name) => ({ file: 'tests/a.test.js', name, line: 1, seconds: 0.1, failed: true, timeout: null });

  it('a test cut at its limit gets one row with file, name, when, where and the limit; the same test again keeps its row', () => {
    const dir = root();
    try {
      const first = new Date('2026-11-03T10:00:00Z');
      const rows = recordTooSlow({ root: dir, repo: 'r', where: 'gate', tests: [slow('one'), green('fine')], now: first });
      assert.deepEqual(rows, [{ file: 'tests/a.test.js', name: 'one', first_seen: first.toISOString(), last_seen: first.toISOString(), where: 'gate', limit_ms: 1000 }]);
      const text = readFileSync(tooSlowPath(dir, 'r'), 'utf8');
      assert.equal(text, `file\ttest\tfirst_seen\tlast_seen\twhere\tlimit_ms\ntests/a.test.js\tone\t${first.toISOString()}\t${first.toISOString()}\tgate\t1000\n`);

      const later = new Date('2026-11-03T11:00:00Z');
      recordTooSlow({ root: dir, repo: 'r', where: '#12', tests: [slow('one', 2000)], now: later });
      assert.deepEqual(readTooSlow({ root: dir, repo: 'r' }), [
        { file: 'tests/a.test.js', name: 'one', first_seen: first.toISOString(), last_seen: later.toISOString(), where: '#12', limit_ms: 2000 },
      ]);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('a test that passes under its limit is removed; one that fails otherwise, or is not run, stays', () => {
    const dir = root();
    try {
      recordTooSlow({ root: dir, repo: 'r', tests: [slow('one'), slow('two'), slow('three')] });
      recordTooSlow({ root: dir, repo: 'r', tests: [green('one'), red('two')] });
      assert.deepEqual(readTooSlow({ root: dir, repo: 'r' }).map((row) => row.name), ['three', 'two']);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('a round with nothing cut and nothing to remove writes no file', () => {
    const dir = root();
    try {
      assert.equal(recordTooSlow({ root: dir, repo: 'r', tests: [green('fine')] }), null);
      assert.throws(() => readFileSync(tooSlowPath(dir, 'r')), { code: 'ENOENT' });
      assert.deepEqual(readTooSlow({ root: dir, repo: 'r' }), []);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('a passed test over the 1 s indicator gets a slow row at 1000, kept while it stays over and removed once under', () => {
    const dir = root();
    try {
      const first = new Date('2026-11-07T10:00:00Z');
      const later = new Date('2026-11-07T11:00:00Z');
      const rows = recordTooSlow({ root: dir, repo: 'r', where: 'gate', tests: [green('slow', 1.4), green('quick', 0.2)], now: first });
      assert.deepEqual(rows, [{ file: 'tests/a.test.js', name: 'slow', first_seen: first.toISOString(), last_seen: first.toISOString(), where: 'gate', limit_ms: SLOW_TEST_MS }]);
      assert.equal(SLOW_TEST_MS, 1000);
      recordTooSlow({ root: dir, repo: 'r', where: '#7', tests: [green('slow', 1.1)], now: later });
      assert.deepEqual(readTooSlow({ root: dir, repo: 'r' }), [
        { file: 'tests/a.test.js', name: 'slow', first_seen: first.toISOString(), last_seen: later.toISOString(), where: '#7', limit_ms: 1000 },
      ]);
      recordTooSlow({ root: dir, repo: 'r', tests: [green('slow', 0.9)] });
      assert.deepEqual(readTooSlow({ root: dir, repo: 'r' }), []);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('a cut row and a slow row stand side by side, each judged by its own limit', () => {
    const dir = root();
    try {
      recordTooSlow({ root: dir, repo: 'r', tests: [slow('cut', 30_000), green('slow', 1.5)] });
      assert.deepEqual(readTooSlow({ root: dir, repo: 'r' }).map((row) => [row.name, row.limit_ms]), [['cut', 30_000], ['slow', 1000]]);
      // The cut test passes at 5 s: under its 30 s limit, so its cut row goes, and it is now a slow row.
      recordTooSlow({ root: dir, repo: 'r', tests: [green('cut', 5), green('slow', 1.2)] });
      assert.deepEqual(readTooSlow({ root: dir, repo: 'r' }).map((row) => [row.name, row.limit_ms]), [['cut', 1000], ['slow', 1000]]);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('a file written before slow rows existed is read unchanged, and a quick pass still removes its cut row', () => {
    const dir = root();
    try {
      const old = 'file\ttest\tfirst_seen\tlast_seen\twhere\tlimit_ms\ntests/a.test.js\tone\t2026-11-03T10:00:00.000Z\t2026-11-03T11:00:00.000Z\t#12\t30000\n';
      mkdirSync(join(dir, 'runner', 'too-slow'), { recursive: true });
      writeFileSync(tooSlowPath(dir, 'r'), old);
      assert.deepEqual(readTooSlow({ root: dir, repo: 'r' }), [
        { file: 'tests/a.test.js', name: 'one', first_seen: '2026-11-03T10:00:00.000Z', last_seen: '2026-11-03T11:00:00.000Z', where: '#12', limit_ms: 30_000 },
      ]);
      assert.equal(recordTooSlow({ root: dir, repo: 'r', tests: [green('other', 0.1)] }), null);
      assert.equal(readFileSync(tooSlowPath(dir, 'r'), 'utf8'), old, 'nothing changed, nothing written');
      recordTooSlow({ root: dir, repo: 'r', tests: [green('one', 0.3)] });
      assert.deepEqual(readTooSlow({ root: dir, repo: 'r' }), []);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('a file that cannot be written costs the record, not the round', () => {
    const dir = root();
    try {
      // A file where the directory should be: the write fails.
      writeFileSync(join(dir, 'runner'), '');
      assert.equal(recordTooSlow({ root: dir, repo: 'r', tests: [slow('one')] }), null);
    } finally { rmSync(dir, { recursive: true, force: true }); }
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
      { file: 'tests/a.test.js', name: 'one', line: 4, seconds: 0.0125, ...ended },
      { file: 'tests/a.test.js', name: 'two', line: 9, seconds: 0.003, ...ended },
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

describe('the slow-test indicator', () => {
  const passed = (name, seconds, file = 'tests/a.test.js') => ({ file, name, line: 1, seconds, failed: false, timeout: null });

  it('only a passed test over 1 s is slow: not a quick one, a failed one, a cut one or an untimed one', () => {
    assert.deepEqual(slowTests([
      passed('quick', 0.2), passed('slow', 1.4), passed('at the line', 1),
      { ...passed('failed', 2), failed: true }, { ...passed('cut', 30), failed: true, timeout: 30_000 }, passed('untimed', null),
    ]), [{ file: 'tests/a.test.js', name: 'slow', seconds: 1.4 }]);
  });

  it('one line for the slow test, with file, name and seconds, under a heading that says it is not red', () => {
    assert.deepEqual(slowTestLines(slowTests([passed('slow one', 1.4), passed('quick one', 0.2)])), [
      '1 test over the 1 s slow-test indicator — not red; rebuild a new or changed one, or say in the PR why its cost is warranted:',
      'slow tests/a.test.js › slow one — 1.400 s',
    ]);
  });

  it('25 slow tests: the 20 slowest named, slowest first, and a count of the rest', () => {
    const many = Array.from({ length: 25 }, (_, i) => passed(`t${i}`, 1 + (i + 1) / 100));
    const lines = slowTestLines(slowTests(many));
    assert.equal(SLOW_LINES, 20);
    assert.equal(lines.length, 1 + 20 + 1);
    assert.match(lines[0], /^25 tests over the 1 s slow-test indicator — not red/u);
    assert.equal(lines[1], 'slow tests/a.test.js › t24 — 1.250 s');
    assert.equal(lines[20], 'slow tests/a.test.js › t5 — 1.060 s');
    assert.equal(lines[21], '… and 5 more slow tests');
  });

  it('no test over 1 s prints nothing', () => {
    assert.deepEqual(slowTestLines(slowTests([passed('quick', 0.2)])), []);
    assert.deepEqual(slowTestLines(undefined), []);
  });
});
