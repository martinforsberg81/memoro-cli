import assert from 'node:assert/strict';
import test, { describe } from 'node:test';

import { attachAutomaticSessionProjection } from '../../src/commands/session.js';

describe('terminal session upload projection', () => {
  test('adds source-aware metadata and a bounded terminal projection', () => {
    const payload = {
      source: 'codex',
      session_id: 'codex_1',
      coding_session_id: 'sess_upload1',
      cleaned_conversation: [],
    };
    const projected = attachAutomaticSessionProjection(payload, {
      parsed: {
        messages: [{
          role: 'assistant',
          content: 'Implemented the fix. Tests pass.',
          at: '2026-07-21T08:00:00.000Z',
        }],
      },
      sessionCwd: '/repo',
      machineId: 'laptop',
      env: {},
    });

    assert.equal(projected.source_id, 'local:laptop');
    assert.equal(projected.source_kind, 'local');
    assert.equal(projected.session_projection.status, 'completed');
    assert.equal(Object.hasOwn(projected.session_projection, 'raw_output'), false);
  });

  test('does not add a projection when the upload lacks mc session identity', () => {
    const payload = attachAutomaticSessionProjection({ source: 'codex' }, {
      parsed: {},
      machineId: 'laptop',
      env: {},
      projectionTracker: {
        transcript: () => { throw new Error('must not run'); },
      },
    });
    assert.equal(payload.source_id, 'local:laptop');
    assert.equal(Object.hasOwn(payload, 'session_projection'), false);
  });
});
