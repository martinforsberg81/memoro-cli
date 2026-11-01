import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import {
  UNMEASURED_SECONDS, measuredSeconds, readTestTimes, recordTestTimes, sessionFiles, testTimesPath,
} from '../../src/mc/test-times.js';

test('the kept files always run and the rest run cheapest first while the estimate fits', () => {
  const times = { 'huge.test.js': 1000, 'big.test.js': 170, 'small.test.js': 10, 'mine.test.js': 900 };
  const { run, deferred } = sessionFiles(Object.keys(times), { times, keep: ['mine.test.js'], lanes: 1, seconds: 1000 });
  assert.deepEqual(run, ['mine.test.js', 'small.test.js']);
  assert.deepEqual(deferred, ['big.test.js', 'huge.test.js']);
});

test('a selection nobody has measured is bounded by the assumed cost', () => {
  const files = Array.from({ length: 100 }, (_, index) => `f${index}.test.js`);
  const { run, deferred } = sessionFiles(files, { lanes: 1, seconds: UNMEASURED_SECONDS * 3 });
  assert.equal(run.length, 3);
  assert.equal(deferred.length, 97);
});

test('there is always one file to measure, and a run that fits defers nothing', () => {
  assert.deepEqual(sessionFiles(['a.test.js'], { times: { 'a.test.js': 9999 } }), { run: ['a.test.js'], deferred: [] });
  assert.deepEqual(sessionFiles(['a.test.js', 'b.test.js']).deferred, []);
});

test('lanes divide the estimate', () => {
  const times = { 'a.test.js': 100, 'b.test.js': 100 };
  assert.equal(sessionFiles(Object.keys(times), { times, lanes: 1, seconds: 150 }).deferred.length, 1);
  assert.equal(sessionFiles(Object.keys(times), { times, lanes: 2, seconds: 150 }).deferred.length, 0);
});

test('measured seconds sum a file\'s tests, skip what will not parse, and are relative to the tree', () => {
  const text = [
    JSON.stringify({ file: '/work/tests/a.test.js', ms: 1500 }), 'noise',
    JSON.stringify({ file: '/work/tests/a.test.js', ms: 500 }), JSON.stringify({ ms: 5 }),
  ].join('\n');
  assert.deepEqual(measuredSeconds(text, '/work'), { 'tests/a.test.js': 2 });
});

test('the table moves half way to a new measurement, and an unusable run changes nothing', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'mc-test-times-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const line = (ms) => JSON.stringify({ file: '/w/a.test.js', ms });
  assert.equal(recordTestTimes({ root, repo: 'r', cwd: '/w', text: line(10_000) }), true);
  assert.deepEqual(readTestTimes({ root, repo: 'r' }), { 'a.test.js': 10 });
  recordTestTimes({ root, repo: 'r', cwd: '/w', text: line(20_000) });
  assert.deepEqual(readTestTimes({ root, repo: 'r' }), { 'a.test.js': 15 });
  assert.equal(recordTestTimes({ root, repo: 'r', cwd: '/w', text: 'nothing' }), false);
  assert.equal(JSON.parse(readFileSync(testTimesPath(root, 'r'), 'utf8'))['a.test.js'], 15);
  assert.deepEqual(readTestTimes({ root, repo: 'absent' }), {});
});
