import assert from 'node:assert/strict';
import test, { describe } from 'node:test';

import {
  brokerSessionMatchesEntry,
  removeBrokerSessionForEntry,
} from '../../../src/runtime/broker/session-cleanup.js';

const controllerCapability = 'b'.repeat(64);

describe('broker session identity matching', () => {
  test('a comparable coding ID mismatch rejects weaker cwd and label matches', () => {
    assert.equal(brokerSessionMatchesEntry({
      coding_session_id: 'sess_other',
      cwd: '/repo/target',
      name: 'target',
    }, {
      coding_session_id: 'sess_target',
      worktree_path: '/repo/target',
      name: 'target',
    }), false);
  });

  test('an exact coding ID wins even when cwd and label differ', () => {
    assert.equal(brokerSessionMatchesEntry({
      coding_session_id: 'sess_target',
      cwd: '/repo/other',
      name: 'other',
    }, {
      coding_session_id: 'sess_target',
      worktree_path: '/repo/target',
      name: 'target',
    }), true);
  });

  test('a comparable worktree mismatch rejects a weaker label match', () => {
    assert.equal(brokerSessionMatchesEntry({
      cwd: '/repo/other',
      name: 'target',
    }, {
      worktree_path: '/repo/target',
      name: 'target',
    }), false);
  });

  test('label fallback applies only when no stronger pair is comparable', () => {
    assert.equal(brokerSessionMatchesEntry({
      name: 'target',
    }, {
      coding_session_id: 'sess_target',
      name: 'target',
    }), true);
  });

  test('modern registry identity disables destructive label fallback', () => {
    assert.equal(brokerSessionMatchesEntry({
      name: 'target',
    }, {
      session_id: 'mcs_aaaaaaaaaaaaaaaaaaaaaaaa',
      repository_id: 'repo_bbbbbbbbbbbbbbbbbbbbbbbb',
      name: 'target',
    }), false);
  });

  test('same label with a different coding ID and repo is not removed', async () => {
    const requests = [];
    const result = await removeBrokerSessionForEntry({
      name: 'target',
      coding_session_id: 'sess_target',
      worktree_path: '/repo/target',
    }, {
      requestBroker: async (message) => {
        requests.push(message);
        if (message.type === 'sessions') {
          return {
            ok: true,
            sessions: [{
              id: 'sess_other',
              coding_session_id: 'sess_other',
              name: 'target',
              cwd: '/repo/other',
            }],
          };
        }
        return { ok: true };
      },
    });

    assert.equal(result.ok, false);
    assert.equal(result.reason, 'not-found');
    assert.equal(requests.some((message) => message.type === 'remove_session'), false);
  });

  test('removing the last session on a dedicated host retires the host daemon', async () => {
    const hostRequests = [];
    let removed = false;
    const result = await removeBrokerSessionForEntry({
      name: 'target',
      coding_session_id: 'sess_target',
      worktree_path: '/repo/target',
    }, {
      controllerCapability,
      requestBroker: async (message, opts = {}) => {
        if (opts.socketPath) hostRequests.push(message.type);
        if (message.type === 'sessions') {
          return {
            ok: true,
            sessions: removed ? [] : [{
              id: 'sess_target',
              coding_session_id: 'sess_target',
              name: 'target',
              cwd: '/repo/target',
              broker_socket_path: '/tmp/hosts/sess_target/broker.sock',
            }],
          };
        }
        if (message.type === 'remove_session') {
          removed = true;
          return { ok: true, removed: true };
        }
        if (message.type === 'stop') return { ok: true };
        // status after stop: the daemon is gone.
        if (message.type === 'status') return { ok: false };
        return { ok: true };
      },
    });

    assert.equal(result.ok, true);
    assert.equal(result.host_stopped, true);
    assert.deepEqual(hostRequests, ['remove_session', 'sessions', 'stop', 'status']);
  });

  test('a host with other sessions left is not stopped', async () => {
    const hostRequests = [];
    const result = await removeBrokerSessionForEntry({
      name: 'target',
      coding_session_id: 'sess_target',
      worktree_path: '/repo/target',
    }, {
      controllerCapability,
      requestBroker: async (message, opts = {}) => {
        if (opts.socketPath) hostRequests.push(message.type);
        if (message.type === 'sessions') {
          return {
            ok: true,
            sessions: [{
              id: 'sess_target',
              coding_session_id: 'sess_target',
              name: 'target',
              cwd: '/repo/target',
              broker_socket_path: '/tmp/hosts/sess_target/broker.sock',
            }, {
              id: 'sess_second',
              coding_session_id: 'sess_second',
              name: 'second',
              cwd: '/repo/second',
              broker_socket_path: '/tmp/hosts/sess_target/broker.sock',
            }],
          };
        }
        if (message.type === 'remove_session') return { ok: true, removed: true };
        return { ok: true };
      },
    });

    assert.equal(result.ok, true);
    assert.equal(result.host_stopped, false);
    assert.equal(hostRequests.includes('stop'), false);
  });

  test('exact coding ID is removed despite weaker field mismatches', async () => {
    const requests = [];
    const result = await removeBrokerSessionForEntry({
      name: 'target',
      coding_session_id: 'sess_target',
      worktree_path: '/repo/target',
    }, {
      controllerCapability,
      requestBroker: async (message) => {
        requests.push(message);
        if (message.type === 'sessions') {
          return {
            ok: true,
            sessions: [{
              id: 'pty_target',
              coding_session_id: 'sess_target',
              name: 'other',
              cwd: '/repo/other',
            }],
          };
        }
        return {
          ok: true,
          removed: true,
          credential_cleanup: 'confirmed',
        };
      },
    });

    assert.equal(result.ok, true);
    assert.equal(result.id, 'pty_target');
    assert.equal(result.credential_cleanup, 'confirmed');
    assert.deepEqual(
      requests.find((message) => message.type === 'remove_session'),
      {
        type: 'remove_session',
        id: 'pty_target',
        session_controller_capability: controllerCapability,
      },
    );
  });
});
