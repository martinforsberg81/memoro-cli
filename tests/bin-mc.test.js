import assert from 'node:assert/strict';
import test, { describe } from 'node:test';

import {
  ageSeconds,
  humanAge,
  writeToPty,
} from '../src/bin-mc.js';

describe('ageSeconds', () => {
  test('returns null for missing / invalid input', () => {
    assert.equal(ageSeconds(null), null);
    assert.equal(ageSeconds(''), null);
    assert.equal(ageSeconds('not-a-date'), null);
  });

  test('returns non-negative seconds for past timestamps', () => {
    const tenSecondsAgo = new Date(Date.now() - 10_000).toISOString();
    const age = ageSeconds(tenSecondsAgo);
    assert.ok(age >= 9 && age <= 12, `unexpected age: ${age}`);
  });

  test('clamps future timestamps to 0', () => {
    const future = new Date(Date.now() + 10_000).toISOString();
    assert.equal(ageSeconds(future), 0);
  });
});

describe('humanAge', () => {
  test('formats seconds', () => {
    assert.equal(humanAge(0), '0s ago');
    assert.equal(humanAge(45), '45s ago');
  });

  test('formats minutes', () => {
    assert.equal(humanAge(60), '1m ago');
    assert.equal(humanAge(125), '2m ago');
  });

  test('formats hours', () => {
    assert.equal(humanAge(3600), '1h ago');
    assert.equal(humanAge(7200), '2h ago');
  });

  test('formats days', () => {
    assert.equal(humanAge(86400), '1d ago');
    assert.equal(humanAge(172800), '2d ago');
  });
});

describe('writeToPty', () => {
  test('writes message + carriage return to the pty', () => {
    const writes = [];
    const fakePty = { write: (s) => writes.push(s) };
    writeToPty(fakePty, 'hello');
    assert.deepEqual(writes, ['hello\r']);
  });

  test('preserves multi-line messages and trailing whitespace', () => {
    const writes = [];
    const fakePty = { write: (s) => writes.push(s) };
    writeToPty(fakePty, 'line 1\nline 2');
    assert.deepEqual(writes, ['line 1\nline 2\r']);
  });
});
