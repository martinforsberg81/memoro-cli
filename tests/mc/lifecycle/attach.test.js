import assert from 'node:assert/strict';
import test, { describe } from 'node:test';

import { parseArgs } from '../../../src/mc/commands/attach.js';

describe('mc attach parseArgs', () => {
  test('parses a session id', () => {
    assert.deepEqual(parseArgs(['sess_a']), { id: 'sess_a', help: false, writer: true });
  });

  test('parses help and rejects extra args', () => {
    assert.deepEqual(parseArgs(['--help']), { id: null, help: true, writer: true });
    assert.match(parseArgs(['sess_a', 'extra']).error, /unexpected arg/);
    assert.match(parseArgs(['--bad']).error, /unknown flag/);
  });

  test('parses --read-only', () => {
    assert.deepEqual(parseArgs(['sess_a', '--read-only']), {
      id: 'sess_a',
      help: false,
      writer: false,
    });
  });
});
