import test, { describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  controlLocalBrokerSession,
  dispatchLocalBrokerSession,
  renderSessionsListForList,
} from '../../../src/bin-mc.js';
import {
  mergeActiveCodingSessions,
  normalizeLocalBrokerSessionForList,
} from '../../../src/mc/session-list.js';

const controllerCapability = 'b'.repeat(64);

describe('mc sessions list local broker view', () => {
  test('normalizes live local broker sessions for sessions list', () => {
    const session = normalizeLocalBrokerSessionForList({
      id: 'sess_local',
      name: 'trip-v2',
      tool: 'codex',
      repo: 'memoro',
      branch: 'sess/trip-v2',
      cwd: '/Users/me/.memoro/mc/worktrees/memoro/trip-v2',
      last_output_at: '2026-06-21T07:32:09.000Z',
      session_state: 'live',
      attachable: true,
    });

    assert.equal(session.coding_session_id, 'sess_local');
    assert.equal(session.label, 'trip-v2');
    assert.equal(session.source, 'codex');
    assert.equal(session.machine_id, 'local');
    assert.equal(session._mc_list_origin, 'local-broker');
  });

  test('local broker sessions are included and deduplicate cloud sessions', () => {
    const local = normalizeLocalBrokerSessionForList({
      id: 'sess_same',
      name: 'native',
      tool: 'codex',
      repo: 'memoro',
      branch: 'sess/native',
      session_state: 'live',
      attachable: true,
    });

    const sessions = mergeActiveCodingSessions({
      localSessions: [local],
      cloudSessions: [{
        coding_session_id: 'sess_same',
        label: 'native-cloud',
        source: 'codex',
      }],
    });

    assert.equal(sessions.length, 1);
    assert.equal(sessions[0].label, 'native');
    assert.equal(sessions[0]._mc_list_origin, 'local-broker');
  });

  test('sparse busy-host rows preserve richer cloud display metadata', () => {
    const local = normalizeLocalBrokerSessionForList({
      id: 'sess_same',
      source: 'local-broker',
      session_state: 'live',
      attachable: true,
      host_busy: true,
    });

    const sessions = mergeActiveCodingSessions({
      localSessions: [local],
      cloudSessions: [{
        coding_session_id: 'sess_same',
        label: 'native-cloud',
        source: 'codex',
        repo: 'memoro',
        branch: 'sess/native-cloud',
      }],
    });

    assert.equal(sessions.length, 1);
    assert.equal(sessions[0].label, 'native-cloud');
    assert.equal(sessions[0].source, 'codex');
    assert.equal(sessions[0].repo, 'memoro');
    assert.equal(sessions[0].branch, 'sess/native-cloud');
    assert.equal(sessions[0].host_busy, true);
  });

  test('renders sessions list with the shared numbered table formatting', () => {
    const session = normalizeLocalBrokerSessionForList({
      id: 'sess_trip',
      name: 'trip-v2',
      tool: 'codex',
      repo: 'memoro',
      branch: 'fix/trip-detail-next-polish',
      last_output_at: new Date(Date.now() - 6 * 60_000).toISOString(),
      session_state: 'live',
      attachable: true,
    });

    const out = renderSessionsListForList([session]);

    assert.match(out, /^mc sessions:\n\nActive sessions/m);
    assert.match(out, /1\. trip-v2\s+active\s+codex\s+memoro\s+fix\/trip-detail-next-polish\s+idle 6m\s+id=sess_trip/);
    assert.doesNotMatch(out, /^\[trip-v2\]/m);
  });
});

describe('mc sessions send local broker dispatch', () => {
  test('resolves local session names before dispatching', async () => {
    const requests = [];
    const result = await dispatchLocalBrokerSession('legal', 'ship it', {
      controllerCapability,
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
      {
        type: 'write_session',
        id: 'sess_a',
        data: 'ship it\r',
        session_controller_capability: controllerCapability,
      },
    ]);
  });

  test('matches local Codex sessions by worktree name and submits with an extra enter', async () => {
    const writes = [];
    const waits = [];
    const result = await dispatchLocalBrokerSession('scoped-session-action', 'continue', {
      controllerCapability,
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
      {
        type: 'write_session',
        id: 'sess_b',
        data: 'continue\r',
        session_controller_capability: controllerCapability,
      },
      {
        type: 'write_session',
        id: 'sess_b',
        data: '\r',
        session_controller_capability: controllerCapability,
      },
    ]);
  });

  test('falls back to dispatch_session when raw write is unavailable', async () => {
    const requests = [];
    const result = await dispatchLocalBrokerSession('sess_a', 'fallback', {
      controllerCapability,
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
      {
        type: 'write_session',
        id: 'sess_a',
        data: 'fallback\r',
        session_controller_capability: controllerCapability,
      },
      {
        type: 'dispatch_session',
        id: 'sess_a',
        message: 'fallback',
        session_controller_capability: controllerCapability,
      },
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
      controllerCapability,
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
      {
        type: 'stop_session',
        id: 'sess_a',
        signal: 'SIGHUP',
        session_controller_capability: controllerCapability,
      },
    ]);
  });

  test('removes a local broker session by worktree name', async () => {
    const requests = [];
    const result = await controlLocalBrokerSession('scoped-session-action', {
      action: 'remove',
      controllerCapability,
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
      {
        type: 'remove_session',
        id: 'sess_b',
        session_controller_capability: controllerCapability,
      },
    ]);
  });
});
