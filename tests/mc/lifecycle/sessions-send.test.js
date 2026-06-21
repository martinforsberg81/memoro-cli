import test, { describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  controlLocalBrokerSession,
  dispatchLocalBrokerSession,
} from '../../../src/bin-mc.js';

describe('mc sessions send local broker dispatch', () => {
  test('resolves local session names before dispatching', async () => {
    const requests = [];
    const result = await dispatchLocalBrokerSession('legal', 'ship it', {
      request: async (message) => {
        requests.push(message);
        if (message.type === 'sessions') {
          return { ok: true, sessions: [{ id: 'sess_a', name: 'legal', cwd: '/repo/legal' }] };
        }
        if (message.type === 'write_session') return { ok: true };
        throw new Error(`unexpected request: ${message.type}`);
      },
    });

    assert.deepEqual(result, {
      ok: true,
      id: 'sess_a',
      matched: true,
      transport: 'write_session',
    });
    assert.deepEqual(requests, [
      { type: 'sessions' },
      { type: 'write_session', id: 'sess_a', data: 'ship it\r' },
    ]);
  });

  test('matches local Codex sessions by worktree name and submits with an extra enter', async () => {
    const writes = [];
    const waits = [];
    const result = await dispatchLocalBrokerSession('scoped-session-action', 'continue', {
      wait: async (ms) => { waits.push(ms); },
      request: async (message) => {
        if (message.type === 'sessions') {
          return {
            ok: true,
            sessions: [{
              id: 'sess_b',
              tool: 'codex',
              cwd: '/Users/me/.memoro/mc/worktrees/memoro/scoped-session-action',
            }],
          };
        }
        writes.push(message);
        return { ok: true };
      },
    });

    assert.equal(result.ok, true);
    assert.equal(result.id, 'sess_b');
    assert.deepEqual(waits, [150]);
    assert.deepEqual(writes, [
      { type: 'write_session', id: 'sess_b', data: 'continue\r' },
      { type: 'write_session', id: 'sess_b', data: '\r' },
    ]);
  });

  test('falls back to dispatch_session when raw write is unavailable', async () => {
    const requests = [];
    const result = await dispatchLocalBrokerSession('sess_a', 'fallback', {
      request: async (message) => {
        requests.push(message);
        if (message.type === 'sessions') return { ok: true, sessions: [{ id: 'sess_a' }] };
        if (message.type === 'write_session') return { ok: false, error: 'unknown command' };
        if (message.type === 'dispatch_session') return { ok: true };
        throw new Error(`unexpected request: ${message.type}`);
      },
    });

    assert.equal(result.ok, true);
    assert.equal(result.transport, 'dispatch_session');
    assert.deepEqual(requests, [
      { type: 'sessions' },
      { type: 'write_session', id: 'sess_a', data: 'fallback\r' },
      { type: 'dispatch_session', id: 'sess_a', message: 'fallback' },
    ]);
  });

  test('skips local dispatch when broker inventory has no match', async () => {
    const requests = [];
    const result = await dispatchLocalBrokerSession('ghost', 'hello', {
      request: async (message) => {
        requests.push(message);
        return { ok: true, sessions: [{ id: 'sess_a', name: 'legal' }] };
      },
    });

    assert.equal(result.ok, false);
    assert.equal(result.skipped, true);
    assert.match(result.error, /not found/);
    assert.deepEqual(requests, [{ type: 'sessions' }]);
  });
});

describe('mc sessions local broker cleanup', () => {
  test('stops a local broker session by name', async () => {
    const requests = [];
    const result = await controlLocalBrokerSession('legal', {
      action: 'stop',
      signal: 'SIGHUP',
      request: async (message) => {
        requests.push(message);
        if (message.type === 'sessions') return { ok: true, sessions: [{ id: 'sess_a', name: 'legal' }] };
        if (message.type === 'stop_session') return { ok: true };
        throw new Error(`unexpected request: ${message.type}`);
      },
    });

    assert.deepEqual(result, { ok: true, id: 'sess_a', action: 'stop' });
    assert.deepEqual(requests, [
      { type: 'sessions' },
      { type: 'stop_session', id: 'sess_a', signal: 'SIGHUP' },
    ]);
  });

  test('removes a local broker session by worktree name', async () => {
    const requests = [];
    const result = await controlLocalBrokerSession('scoped-session-action', {
      action: 'remove',
      request: async (message) => {
        requests.push(message);
        if (message.type === 'sessions') {
          return {
            ok: true,
            sessions: [{
              id: 'sess_b',
              cwd: '/Users/me/.memoro/mc/worktrees/memoro/scoped-session-action',
            }],
          };
        }
        if (message.type === 'remove_session') return { ok: true, removed: true };
        throw new Error(`unexpected request: ${message.type}`);
      },
    });

    assert.deepEqual(result, {
      ok: true,
      id: 'sess_b',
      action: 'remove',
      removed: true,
    });
    assert.deepEqual(requests, [
      { type: 'sessions' },
      { type: 'remove_session', id: 'sess_b' },
    ]);
  });
});
