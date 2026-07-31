import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import {
  buildSessionHeartbeatPayload,
  publishLocalSessionPresence,
  repairExitedSessionPresence,
} from '../../src/mc/session-presence.js';

const GENERATION = '4f50f5a1-4c6b-4d6a-8b5c-152c5e6b8701';

describe('session presence', () => {
  test('broker-local publishing reads device identity locally and keeps it out of the payload', async () => {
    const calls = [];
    const payload = buildSessionHeartbeatPayload({
      codingSessionId: 'sess_presence',
      runtimeGeneration: GENERATION,
      presenceState: 'terminal',
      machineId: 'machine',
      sourceIdentity: {
        source_id: 'local:machine',
        source_kind: 'local',
        source_name: 'machine',
        cloud_session_id: null,
      },
      source: 'codex',
      repo: 'acme/widgets',
      branch: 'main',
      at: '2026-07-30T08:00:00.000Z',
    });
    const ok = await publishLocalSessionPresence({
      payload,
      argv: null,
      maxAttempts: 1,
      deps: {
        getSecret: async () => 'device-token-sentinel',
        readConfig: async () => ({ apiUrl: 'https://memoro.test' }),
        getApiUrl: () => assert.fail('broker publishing must not read argv or environment overrides'),
        memoroFetch: async (apiUrl, path, options) => {
          calls.push({ apiUrl, path, options });
          return { ok: true };
        },
      },
    });

    assert.equal(ok, true);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].apiUrl, 'https://memoro.test');
    assert.equal(calls[0].path, '/api/sessions/heartbeat');
    assert.equal(calls[0].options.token, 'device-token-sentinel');
    assert.equal(calls[0].options.body.presence_state, 'terminal');
    assert.doesNotMatch(JSON.stringify(calls[0].options.body), /device-token-sentinel/);
  });

  test('repairs a generation-less legacy row with exact exited-generation metadata', async () => {
    let published = null;
    const result = await repairExitedSessionPresence({
      active: {
        coding_session_id: 'sess_presence',
        runtime_generation: null,
        machine_id: 'machine',
        source_id: 'local:machine',
        source_kind: 'local',
        source: 'codex',
        repo: 'acme/widgets',
        branch: 'sess/presence',
        label: 'presence',
      },
      runtimeGeneration: GENERATION,
      now: () => Date.parse('2026-07-30T08:00:00.000Z'),
      deps: {
        publishLocalSessionPresence: async (request) => {
          published = request;
          return true;
        },
      },
    });

    assert.deepEqual(result, {
      ok: true,
      repairedGeneration: GENERATION,
      legacy: true,
    });
    assert.equal(published.payload.presence_state, 'terminal');
    assert.equal(published.payload.runtime_generation, GENERATION);
    assert.equal(published.payload.source_id, 'local:machine');
    assert.equal(published.payload.source_name, 'machine');
    assert.equal(published.payload.at, '2026-07-30T08:00:00.000Z');
  });

  test('never repairs a server row owned by a different generation', async () => {
    let published = false;
    const result = await repairExitedSessionPresence({
      active: {
        coding_session_id: 'sess_presence',
        runtime_generation: '9937ac60-46ce-42dd-9302-6533f1c6c38c',
      },
      runtimeGeneration: GENERATION,
      deps: {
        publishLocalSessionPresence: async () => {
          published = true;
          return true;
        },
      },
    });

    assert.equal(result.ok, false);
    assert.equal(result.reason, 'presence-repair-generation-conflict');
    assert.equal(published, false);
  });
});
