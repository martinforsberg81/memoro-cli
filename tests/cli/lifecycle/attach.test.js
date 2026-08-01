import assert from 'node:assert/strict';
import test, { describe } from 'node:test';

import { parseArgs, run } from '../../../src/cli/attach.js';

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

describe('mc attach command', () => {
  test('starts broker before attaching', async () => {
    const sequence = [];
    let attached = null;
    const code = await run(['sess_a'], {
      ensureBrokerRunning: async () => {
        sequence.push('ensure');
        return { ok: true, broker: { pid: 42 } };
      },
      attachBrokerSession: async (opts) => {
        sequence.push('attach');
        attached = opts;
        return 0;
      },
      resolveSessionControllerCapability: async () => ({
        ok: true,
        capability: 'b'.repeat(64),
      }),
      stderr: { write: () => {} },
    });

    assert.equal(code, 0);
    assert.deepEqual(sequence, ['ensure', 'attach']);
    assert.deepEqual(attached, {
      id: 'sess_a',
      controllerCapability: 'b'.repeat(64),
    });
  });

  test('does not attach when broker start fails', async () => {
    let stderr = '';
    const code = await run(['sess_a'], {
      ensureBrokerRunning: async () => ({ ok: false, error: 'offline' }),
      attachBrokerSession: async () => assert.fail('must not attach'),
      stderr: { write: (s) => { stderr += s; } },
    });

    assert.equal(code, 1);
    assert.match(stderr, /broker start failed/);
  });
});
