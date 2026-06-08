import assert from 'node:assert/strict';
import test, { describe } from 'node:test';

import { parseArgs } from '../../../src/mc/commands/attach.js';

describe('mc attach parseArgs', () => {
  test('parses a session id', () => {
    assert.deepEqual(parseArgs(['sess_a']), { id: 'sess_a', help: false });
  });

  test('parses help and rejects extra args', () => {
    assert.deepEqual(parseArgs(['--help']), { id: null, help: true });
    assert.match(parseArgs(['sess_a', 'extra']).error, /unexpected arg/);
    assert.match(parseArgs(['--bad']).error, /unknown flag/);
  });

  test('rejects --read-only', () => {
    assert.match(parseArgs(['sess_a', '--read-only']).error, /unknown flag/);
  });
});
