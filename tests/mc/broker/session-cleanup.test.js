import assert from 'node:assert/strict';
import test, { describe } from 'node:test';

import {
  brokerSessionMatchesEntry,
  removeBrokerSessionForEntry,
} from '../../../src/mc/broker/session-cleanup.js';

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

  test('exact coding ID is removed despite weaker field mismatches', async () => {
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
              id: 'pty_target',
              coding_session_id: 'sess_target',
              name: 'other',
              cwd: '/repo/other',
            }],
          };
        }
        return { ok: true, removed: true };
      },
    });

    assert.equal(result.ok, true);
    assert.equal(result.id, 'pty_target');
    assert.deepEqual(
      requests.find((message) => message.type === 'remove_session'),
      { type: 'remove_session', id: 'pty_target' },
    );
  });
});
