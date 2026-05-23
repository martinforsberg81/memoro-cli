import assert from 'node:assert/strict';
import test, { describe } from 'node:test';

import {
  ageSeconds,
  humanAge,
  writeToPty,
  renderIntro,
  formatStatus,
  extractExcerpt,
} from '../src/bin-mc.js';

// Strip ANSI escape sequences so we can match on visible text.
const stripAnsi = (s) => s.replace(/\x1b\[[0-9;]*m/g, '');

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

describe('renderIntro', () => {
  const ctx = {
    version: '0.4.1',
    codingSessionId: 'sess_abc123XYZ',
    repo: 'memoro',
    branch: 'main',
  };

  test('includes mc + version + repo + branch on the headline', () => {
    const plain = stripAnsi(renderIntro(ctx));
    assert.match(plain, /\bmc\b/);
    assert.match(plain, /0\.4\.1/);
    assert.match(plain, /memoro/);
    assert.match(plain, /\(main\)/);
  });

  test('shows the session id', () => {
    const plain = stripAnsi(renderIntro(ctx));
    assert.match(plain, /sess_abc123XYZ/);
  });

  test('mentions the coordinator slash command + cli help', () => {
    const plain = stripAnsi(renderIntro(ctx));
    assert.match(plain, /\/memoro-coordinator/);
    assert.match(plain, /mc --help/);
  });

  test('begins and ends with blank lines for breathing room', () => {
    const out = renderIntro(ctx);
    assert.ok(out.startsWith('\n'));
    assert.ok(out.endsWith('\n\n'));
  });
});

describe('extractExcerpt', () => {
  test('returns empty for null / empty input', () => {
    assert.equal(extractExcerpt(''), '');
    assert.equal(extractExcerpt(null), '');
    assert.equal(extractExcerpt(undefined), '');
  });

  test('passes plain text through unchanged', () => {
    const out = extractExcerpt('Hello, world.');
    assert.equal(out, 'Hello, world.');
  });

  test('strips SGR color sequences', () => {
    const input = '\x1b[1;31mERROR\x1b[0m: something broke';
    assert.equal(extractExcerpt(input), 'ERROR: something broke');
  });

  test('strips cursor-positioning CSI sequences', () => {
    const input = '\x1b[H\x1b[2JHow should I proceed?\n  1. Update\n  2. Hold';
    assert.equal(extractExcerpt(input), 'How should I proceed?\n  1. Update\n  2. Hold');
  });

  test('strips OSC (window title) sequences', () => {
    const input = '\x1b]0;some title\x07hello';
    assert.equal(extractExcerpt(input), 'hello');
  });

  test('drops non-printable control bytes but preserves newlines + tabs', () => {
    const input = 'line 1\n\tindented\rline 2';
    assert.equal(extractExcerpt(input), 'line 1\n\tindented' + 'line 2');
  });

  test('collapses 3+ blank lines into 2', () => {
    const input = 'top\n\n\n\n\nbottom';
    assert.equal(extractExcerpt(input), 'top\n\nbottom');
  });

  test('returns the trailing `max` chars when input is long', () => {
    const longText = 'X'.repeat(2000) + ' END OF LONG TEXT';
    const out = extractExcerpt(longText, 50);
    assert.equal(out.length <= 50, true);
    assert.ok(out.endsWith('END OF LONG TEXT'));
  });

  test('Claude prompt menu example survives ANSI stripping', () => {
    // Simulates a Claude TUI redraw with color + cursor positioning around a
    // menu — the kind of output the coordinator needs to spot as paused.
    const input =
      '\x1b[H\x1b[2J' +
      '\x1b[36m❯ \x1b[0mHow should I proceed?\n\n' +
      '\x1b[1m  1. Update Gemini Flash only (Recommended)\x1b[0m\n' +
      '  2. Update Gemini + dig into Sonnet\n' +
      '  3. Hold — let me look first\n' +
      '\x1b[2K';  // erase-line at end (TUI cleanup)
    const out = extractExcerpt(input);
    assert.match(out, /How should I proceed\?/);
    assert.match(out, /1\. Update Gemini Flash only/);
    assert.match(out, /3\. Hold/);
    // No raw escape sequences leaked
    assert.equal(out.includes('\x1b['), false);
  });
});

describe('formatStatus', () => {
  test('treats < 5s as ACTIVE', () => {
    assert.equal(formatStatus(0), 'ACTIVE');
    assert.equal(formatStatus(4), 'ACTIVE');
  });

  test('formats idle seconds for < 1 min', () => {
    assert.equal(formatStatus(5), 'idle 5s');
    assert.equal(formatStatus(45), 'idle 45s');
  });

  test('formats idle minutes for < 1 h', () => {
    assert.equal(formatStatus(60), 'idle 1m');
    assert.equal(formatStatus(125), 'idle 2m');
  });

  test('formats idle hours beyond that', () => {
    assert.equal(formatStatus(3600), 'idle 1h');
    assert.equal(formatStatus(7200), 'idle 2h');
  });

  test('returns "unknown" for missing or invalid input', () => {
    assert.equal(formatStatus(undefined), 'unknown');
    assert.equal(formatStatus(null), 'unknown');
    assert.equal(formatStatus(-1), 'unknown');
    assert.equal(formatStatus('5'), 'unknown');
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
