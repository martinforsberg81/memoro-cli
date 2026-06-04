import assert from 'node:assert/strict';
import test, { describe } from 'node:test';

import {
  handleDispatchSocketPayload,
  responseLine,
} from '../../src/mc/wrap-dispatch.js';

describe('handleDispatchSocketPayload', () => {
  test('rejects invalid JSON', () => {
    let delivered = false;
    const out = handleDispatchSocketPayload('{nope', {
      deliver: () => { delivered = true; },
    });
    assert.deepEqual(out.response, { ok: false, error: 'invalid JSON' });
    assert.equal(delivered, false);
  });

  test('rejects missing or blank message', () => {
    assert.deepEqual(
      handleDispatchSocketPayload('{}').response,
      { ok: false, error: 'message required' },
    );
    assert.deepEqual(
      handleDispatchSocketPayload(JSON.stringify({ message: '   ' })).response,
      { ok: false, error: 'message required' },
    );
  });

  test('delivers a valid message verbatim and reports ok', () => {
    const delivered = [];
    const out = handleDispatchSocketPayload(JSON.stringify({ message: 'hello\nthere ' }), {
      deliver: (message) => delivered.push(message),
    });
    assert.deepEqual(delivered, ['hello\nthere ']);
    assert.deepEqual(out.response, { ok: true, message: 'hello\nthere ' });
  });
});

describe('responseLine', () => {
  test('serializes one JSON response per line', () => {
    assert.equal(responseLine({ ok: true, message: 'hi' }), '{"ok":true,"message":"hi"}\n');
  });
});
