/**
 * Coverage for `renderIntro`, carried over from `tests/bin-mc.test.js`.
 *
 * That file imported eleven helpers from `src/bin-mc.js` back when that module
 * was the whole product. Nine of them no longer exist anywhere in `src/`, so
 * the file could not even be imported — one missing named binding is a
 * SyntaxError that fails the module before a single test runs. It was removed;
 * the two units that still exist kept their tests, here and in
 * `pty-write.test.js`.
 *
 * What is asserted here is the intro's structure: identity line, session id,
 * and the blank lines around it. The old file also asserted that the intro
 * offers `mc sessions watch` — a command listed as removed in
 * `docs/mc-command-matrix.md`, describing a broker that no longer exists.
 * Those assertions are deliberately not carried over: they would lock in
 * user-facing copy that advertises something unrunnable, and make removing the
 * broker path harder rather than safer. The copy itself still needs fixing in
 * `src/mc/session-intro.js`.
 */
import assert from 'node:assert/strict';
import test, { describe } from 'node:test';

import { renderIntro } from '../../src/mc/session-intro.js';

// Strip ANSI escape sequences so we can match on visible text.
const stripAnsi = (s) => s.replace(/\x1b\[[0-9;]*m/gu, '');

describe('renderIntro', () => {
  const ctx = {
    version: '0.4.1',
    codingSessionId: 'sess_abc123XYZ',
    repo: 'memoro',
    branch: 'main',
  };

  test('includes mc + version + repo + branch on the headline', () => {
    const plain = stripAnsi(renderIntro(ctx));
    assert.match(plain, /\bmc\b/u);
    assert.match(plain, /0\.4\.1/u);
    assert.match(plain, /memoro/u);
    assert.match(plain, /\(main\)/u);
  });

  test('shows the session id', () => {
    const plain = stripAnsi(renderIntro(ctx));
    assert.match(plain, /sess_abc123XYZ/u);
  });

  test('points at the cli reference and the coding profile', () => {
    const plain = stripAnsi(renderIntro(ctx));
    assert.match(plain, /mc --help/u);
    assert.match(plain, /mc coding-profile read/u);
  });

  test('never offers the map or coordinator commands that were removed', () => {
    const plain = stripAnsi(renderIntro(ctx));
    assert.doesNotMatch(plain, /\/mc map/u);
    assert.doesNotMatch(plain, /\/memoro-map/u);
    assert.doesNotMatch(plain, /\/memoro-coordinator/u);
  });

  test('keeps the same primary actions whichever tool is launching', () => {
    for (const tool of ['Claude Code', 'Codex CLI']) {
      const plain = stripAnsi(renderIntro({ ...ctx, tool }));
      assert.match(plain, /mc coding-profile read/u);
      assert.doesNotMatch(plain, /\/memoro-coordinator/u);
    }
  });

  test('begins and ends with blank lines for breathing room', () => {
    const out = renderIntro(ctx);
    assert.ok(out.startsWith('\n'));
    assert.ok(out.endsWith('\n\n'));
  });
});
