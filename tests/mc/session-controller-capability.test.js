import assert from 'node:assert/strict';
import test from 'node:test';

import {
  deriveHandoffControllerRoot,
} from '../../src/mc/handoff-controller-capability.js';
import {
  resolveSessionControllerCapability,
} from '../../src/mc/session-controller-capability.js';

test('controller resolver consumes Memoro authority without returning the token', async () => {
  const token = 'memoro-controller-token-canary';
  const result = await resolveSessionControllerCapability({
    codingSessionId: 'sess_controller1',
    deps: {
      readConfig: async () => ({ apiUrl: 'https://memoro.test' }),
      getApiUrl: () => null,
      resolveBootstrapIdentity: async () => ({ token }),
    },
  });

  assert.deepEqual(result, {
    ok: true,
    capability: deriveHandoffControllerRoot({
      token,
      codingSessionId: 'sess_controller1',
    }),
  });
  assert.doesNotMatch(JSON.stringify(result), /memoro-controller-token-canary/);
});

test('controller resolver fails closed without a coding id or Memoro authority', async () => {
  assert.equal(
    (await resolveSessionControllerCapability({ codingSessionId: '' })).ok,
    false,
  );
  const result = await resolveSessionControllerCapability({
    codingSessionId: 'sess_controller1',
    deps: {
      readConfig: async () => ({ apiUrl: 'https://memoro.test' }),
      getApiUrl: () => null,
      resolveBootstrapIdentity: async () => null,
    },
  });
  assert.deepEqual(result, {
    ok: false,
    reason: 'session-controller-capability-unavailable',
  });
});
