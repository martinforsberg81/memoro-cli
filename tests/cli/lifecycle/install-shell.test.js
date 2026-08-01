/**
 * Smoke tests for `mc install-shell`.
 *
 * Primary purpose: catch syntax errors in the shell-wrapper template
 * literal at test time, not when a user actually runs the binary.
 * (A bare backtick inside the String.raw template literal terminates
 * the literal early, breaking module parse — and the rest of the
 * test suite never imports install-shell.js so the error went
 * undetected in CI on the original change.)
 */
import test, { describe } from 'node:test';
import assert from 'node:assert/strict';

import { run } from '../../../src/cli/install-shell.js';

describe('install-shell module', () => {
  test('imports without throwing (catches template-literal syntax errors)', () => {
    assert.equal(typeof run, 'function');
  });

  test('dry-run completes with rc=0 and does not throw', async () => {
    const origLog = console.log;
    console.log = () => {};
    try {
      const rc = await run(['--dry-run', '--shell', 'zsh']);
      assert.equal(rc, 0);
    } finally {
      console.log = origLog;
    }
  });

  test('rejects unknown flags with rc=2', async () => {
    const origErr = console.error;
    console.error = () => {};
    try {
      const rc = await run(['--no-such-flag']);
      assert.equal(rc, 2);
    } finally {
      console.error = origErr;
    }
  });
});
