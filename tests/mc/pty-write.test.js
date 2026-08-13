/**
 * Coverage for `writeToPty`, carried over from `tests/bin-mc.test.js`.
 *
 * See the header of `session-intro.test.js` for why that file was removed.
 * This unit is live: `src/runtime/broker/pty-session.js` writes through it, and
 * it owns the delayed-extra-Enter behaviour that TUIs need in order to submit
 * a message rather than leave it sitting in the composer.
 */
import assert from 'node:assert/strict';
import test, { describe } from 'node:test';

import { writeToPty } from '../../src/mc/pty-write.js';

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
