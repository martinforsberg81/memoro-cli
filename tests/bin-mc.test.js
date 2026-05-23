import assert from 'node:assert/strict';
import test, { describe } from 'node:test';

import {
  sanitizeTmuxName,
  shquote,
  ageSeconds,
  humanAge,
} from '../src/bin-mc.js';

describe('sanitizeTmuxName', () => {
  test('preserves a coding session id verbatim', () => {
    assert.equal(sanitizeTmuxName('sess_abc123XYZ'), 'sess_abc123XYZ');
  });

  test('replaces unsafe characters with underscore', () => {
    assert.equal(sanitizeTmuxName('weird:name/with spaces'), 'weird_name_with_spaces');
  });

  test('truncates very long ids', () => {
    const long = 'a'.repeat(200);
    assert.equal(sanitizeTmuxName(long).length, 64);
  });
});

describe('shquote', () => {
  test('passes safe identifiers through unquoted', () => {
    assert.equal(shquote('claude'), 'claude');
    assert.equal(shquote('--tool'), '--tool');
    assert.equal(shquote('MEMORO_MC_PARENT=1'), 'MEMORO_MC_PARENT=1');
    assert.equal(shquote('/usr/bin/env'), '/usr/bin/env');
  });

  test('single-quotes arguments containing spaces or special chars', () => {
    assert.equal(shquote('hello world'), `'hello world'`);
    assert.equal(shquote('$HOME'), `'$HOME'`);
    assert.equal(shquote('a;b'), `'a;b'`);
  });

  test('escapes embedded single quotes', () => {
    assert.equal(shquote("it's fine"), `'it'\\''s fine'`);
  });
});

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
