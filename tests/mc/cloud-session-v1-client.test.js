import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  fetchCloudSessionProjections,
  projectCloudSession,
} from '../../src/mc/cloud-session-v1-client.js';

test('reads cloud-owned sessions only from the V1 source endpoint', async () => {
  const calls = [];
  const result = await fetchCloudSessionProjections({
    deps: {
      apiUrl: 'https://memoro.example',
      token: 'opaque-token',
      memoroFetch: async (...args) => {
        calls.push(args);
        return {
          ok: true,
          sessions: [{
            source_id: 'memoro-cloud',
            mc_session_id: 'mcs_000000000000000000000001',
            name: 'cloud-alpha',
            objective: null,
            lifecycle: 'open',
            updated_at: '2026-08-03T10:00:00.000Z',
          }],
        };
      },
    },
  });

  assert.equal(result.ok, true);
  assert.equal(result.sessions.length, 1);
  assert.equal(result.sessions[0].source_kind, 'cloud');
  assert.equal(result.sessions[0].workspace_path, null);
  assert.equal(result.sessions[0].runtime_state, 'unknown');
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], 'https://memoro.example');
  assert.equal(calls[0][1], '/api/mc/v1/sources/memoro-cloud/sessions?limit=1000');
  assert.deepEqual(calls[0][2], { token: 'opaque-token' });
});

test('missing cloud authority is a warning and never invokes a fallback endpoint', async () => {
  let calls = 0;
  const result = await fetchCloudSessionProjections({
    deps: {
      apiUrl: 'https://memoro.example',
      token: null,
      memoroFetch: async () => { calls += 1; },
    },
  });
  assert.equal(result.ok, false);
  assert.deepEqual(result.sessions, []);
  assert.match(result.warning, /not logged in/iu);
  assert.equal(calls, 0);
});

test('a keychain read failure cannot hide machine-local sessions', async () => {
  let calls = 0;
  const result = await fetchCloudSessionProjections({
    deps: {
      apiUrl: 'https://memoro.example',
      getSecret: async () => { throw new Error('host keychain detail'); },
      memoroFetch: async () => { calls += 1; },
    },
  });
  assert.equal(result.ok, false);
  assert.deepEqual(result.sessions, []);
  assert.match(result.warning, /credentials could not be read/iu);
  assert.equal(result.warning.includes('host keychain detail'), false);
  assert.equal(calls, 0);
});

test('rejects rows that are not owned by the canonical cloud source', () => {
  assert.equal(projectCloudSession({
    source_id: 'machine_other',
    mc_session_id: 'mcs_000000000000000000000001',
    name: 'forged',
  }), null);
});
