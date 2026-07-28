import assert from 'node:assert/strict';
import test from 'node:test';

import { captureProviderArtifact } from '../../src/commands/provider-artifact.js';

const generation = '4f50f5a1-4c6b-4d6a-8b5c-152c5e6b8701';

test('provider SessionStart bridge sends exact broker generation for Claude and Codex', async () => {
  for (const tool of ['claude-code', 'codex']) {
    const requests = [];
    const code = await captureProviderArtifact(['--tool', tool], {
      env: {
        MEMORO_MC_PARENT: '1',
        MC_CODING_SESSION_ID: 'sess_exact',
        MC_RUNTIME_GENERATION: generation,
        MC_PROVIDER_ARTIFACT_SOCKET: '/private/broker.sock',
      },
      readEvent: async () => ({
        hook_event_name: 'SessionStart',
        session_id: `${tool}-native`,
        transcript_path: `/private/${tool}.jsonl`,
        cwd: '/repo',
      }),
      request: async (message, options) => {
        requests.push({ message, options });
        return { ok: true };
      },
    });
    assert.equal(code, 0);
    assert.deepEqual(requests, [{
      message: {
        type: 'capture_provider_artifact',
        id: 'sess_exact',
        runtime_generation: generation,
        tool,
        cwd: '/repo',
        provider_session_id: `${tool}-native`,
        transcript_path: `/private/${tool}.jsonl`,
      },
      options: { socketPath: '/private/broker.sock' },
    }]);
  }
});

test('provider SessionStart bridge is inert outside a broker generation', async () => {
  let read = false;
  const code = await captureProviderArtifact(['--tool', 'codex'], {
    env: {
      MEMORO_MC_PARENT: '1',
      MC_CODING_SESSION_ID: 'sess_exact',
    },
    readEvent: async () => {
      read = true;
      return {};
    },
    request: async () => {
      throw new Error('must not request');
    },
  });
  assert.equal(code, 0);
  assert.equal(read, false);
});

test('provider bridge rejects non-SessionStart input', async () => {
  const code = await captureProviderArtifact(['--tool', 'claude-code'], {
    env: {
      MEMORO_MC_PARENT: '1',
      MC_CODING_SESSION_ID: 'sess_exact',
      MC_RUNTIME_GENERATION: generation,
    },
    readEvent: async () => ({
      hook_event_name: 'Stop',
      session_id: 'native',
      transcript_path: '/private/provider.jsonl',
      cwd: '/repo',
    }),
  });
  assert.equal(code, 1);
});
