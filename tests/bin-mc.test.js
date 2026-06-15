import assert from 'node:assert/strict';
import test, { describe } from 'node:test';

import {
  ageSeconds,
  humanAge,
  renderIntro,
  formatStatus,
  extractExcerpt,
  validateLabel,
  resolveStartupMessageForLaunch,
  shouldRefuseBareMcInPrimaryWorktree,
  resolveSessionIdentifier,
} from '../src/bin-mc.js';
import { writeToPty } from '../src/mc/pty-write.js';

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

  test('mentions portable coordinator actions + cli help', () => {
    const plain = stripAnsi(renderIntro(ctx));
    assert.match(plain, /terminal/);
    assert.match(plain, /mc sessions watch/);
    assert.match(plain, /mc --help/);
    assert.match(plain, /LLM session/);
    assert.match(plain, /\/mc map/);
    assert.doesNotMatch(plain, /\/memoro-map/);
    assert.doesNotMatch(plain, /\/memoro-coordinator/);
  });

  test('keeps the same primary actions when launching Claude Code', () => {
    const plain = stripAnsi(renderIntro({ ...ctx, tool: 'Claude Code' }));
    assert.match(plain, /mc sessions watch/);
    assert.match(plain, /\/mc map/);
    assert.doesNotMatch(plain, /\/memoro-coordinator/);
  });

  test('uses the same /mc map convention for Codex launches', () => {
    const plain = stripAnsi(renderIntro({ ...ctx, tool: 'Codex CLI' }));
    assert.match(plain, /\/mc map/);
    assert.doesNotMatch(plain, /\/memoro-map/);
    assert.match(plain, /mc sessions watch/);
    assert.doesNotMatch(plain, /\/memoro-coordinator/);
  });

  test('begins and ends with blank lines for breathing room', () => {
    const out = renderIntro(ctx);
    assert.ok(out.startsWith('\n'));
    assert.ok(out.endsWith('\n\n'));
  });
});

describe('validateLabel', () => {
  test('accepts simple alphanumeric labels', () => {
    assert.equal(validateLabel('audit').ok, true);
    assert.equal(validateLabel('UI').ok, true);
    assert.equal(validateLabel('feat_42').ok, true);
    assert.equal(validateLabel('a-b-c').ok, true);
    assert.equal(validateLabel('x').ok, true);
  });

  test('rejects empty / missing', () => {
    assert.equal(validateLabel('').ok, false);
    assert.equal(validateLabel(null).ok, false);
    assert.equal(validateLabel(undefined).ok, false);
  });

  test('rejects labels starting with a dash (looks like a flag)', () => {
    assert.equal(validateLabel('-audit').ok, false);
  });

  test('rejects forbidden characters', () => {
    assert.equal(validateLabel('with space').ok, false);
    assert.equal(validateLabel('slash/in/it').ok, false);
    assert.equal(validateLabel('semi;colon').ok, false);
    assert.equal(validateLabel('emoji🙂').ok, false);
  });

  test('rejects labels over 32 chars', () => {
    assert.equal(validateLabel('x'.repeat(33)).ok, false);
    assert.equal(validateLabel('x'.repeat(32)).ok, true);
  });
});

describe('shouldRefuseBareMcInPrimaryWorktree', () => {
  test('refuses bare mc at the primary worktree root', () => {
    assert.equal(shouldRefuseBareMcInPrimaryWorktree({
      cwd: '/repo',
      primary: '/repo',
      env: {},
    }), true);
  });

  test('refuses bare mc in a subdirectory of the primary worktree', () => {
    assert.equal(shouldRefuseBareMcInPrimaryWorktree({
      cwd: '/repo/src',
      primary: '/repo',
      env: {},
    }), true);
  });

  test('allows named session reexecs and separate worktrees', () => {
    assert.equal(shouldRefuseBareMcInPrimaryWorktree({
      cwd: '/repo',
      primary: '/repo',
      env: { MC_SESSION_NAME: 'data' },
    }), false);
    assert.equal(shouldRefuseBareMcInPrimaryWorktree({
      cwd: '/Users/me/.memoro/mc/worktrees/repo/data',
      primary: '/repo',
      env: {},
    }), false);
  });
});

describe('resolveSessionIdentifier', () => {
  const make = (id, label, received_at) => ({
    coding_session_id: id, label, received_at,
  });

  test('returns null when nothing matches', () => {
    const r = resolveSessionIdentifier([], 'anything');
    assert.equal(r.id, null);
  });

  test('direct id match takes priority', () => {
    const sessions = [
      make('sess_aaaaaa', 'audit', '2026-05-24T00:00:00Z'),
      make('sess_bbbbbb', null, '2026-05-24T00:00:01Z'),
    ];
    const r = resolveSessionIdentifier(sessions, 'sess_aaaaaa');
    assert.equal(r.id, 'sess_aaaaaa');
    assert.equal(r.matchedBy, 'id');
  });

  test('label match resolves to id', () => {
    const sessions = [
      make('sess_aaaaaa', 'audit', '2026-05-24T00:00:00Z'),
      make('sess_bbbbbb', 'ui',    '2026-05-24T00:00:01Z'),
    ];
    const r = resolveSessionIdentifier(sessions, 'ui');
    assert.equal(r.id, 'sess_bbbbbb');
    assert.equal(r.matchedBy, 'label');
  });

  test('label collision returns most-recent + flags collision count', () => {
    const sessions = [
      make('sess_old', 'audit', '2026-05-24T00:00:00Z'),
      make('sess_new', 'audit', '2026-05-24T01:00:00Z'),
      make('sess_mid', 'audit', '2026-05-24T00:30:00Z'),
    ];
    const r = resolveSessionIdentifier(sessions, 'audit');
    assert.equal(r.id, 'sess_new');
    assert.equal(r.matchedBy, 'label');
    assert.equal(r.collisions, 3);
  });

  test('null identifier returns null', () => {
    const r = resolveSessionIdentifier([make('sess_x', 'audit', '2026-05-24T00:00:00Z')], null);
    assert.equal(r.id, null);
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

  test('can send delayed extra enters for TUIs that require it', () => {
    const writes = [];
    const timers = [];
    const fakePty = { write: (s) => writes.push(s) };
    writeToPty(fakePty, 'hello', {
      submitEnterCount: 2,
      submitEnterDelayMs: 42,
      setTimeoutFn: (fn, ms) => {
        timers.push({ fn, ms });
        return timers.length;
      },
    });
    assert.deepEqual(writes, ['hello\r']);
    assert.equal(timers.length, 1);
    assert.equal(timers[0].ms, 42);
    timers[0].fn();
    assert.deepEqual(writes, ['hello\r', '\r']);
  });
});

describe('resolveStartupMessageForLaunch', () => {
  test('does not duplicate messages already delivered via launch args or argv prompt', () => {
    assert.equal(resolveStartupMessageForLaunch({
      delivery: 'launch-args',
      groundingLaunchMessage: 'grounding',
      fallbackStartupMessage: 'fallback',
    }), null);
    assert.equal(resolveStartupMessageForLaunch({
      delivery: 'argv-prompt',
      groundingLaunchMessage: 'grounding',
      fallbackStartupMessage: 'fallback',
    }), null);
  });

  test('deferred-pty sends full grounding through the PTY', () => {
    assert.equal(resolveStartupMessageForLaunch({
      delivery: 'deferred-pty',
      groundingLaunchMessage: 'grounding',
      fallbackStartupMessage: 'fallback',
    }), 'grounding');
  });

  test('unknown delivery keeps the fallback-only startup prompt', () => {
    assert.equal(resolveStartupMessageForLaunch({
      delivery: null,
      groundingLaunchMessage: 'grounding',
      fallbackStartupMessage: 'fallback',
    }), 'fallback');
  });
});
