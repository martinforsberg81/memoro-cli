import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildProviderArtifactHookRequest,
} from '../../src/mc/provider-artifact-hook-runner.js';

const env = {
  MEMORO_MC_PARENT: '1',
  MC_CODING_SESSION_ID: 'sess_exact1',
  MC_RUNTIME_GENERATION: '4f50f5a1-4c6b-4d6a-8b5c-152c5e6b8701',
  MC_PROVIDER_ARTIFACT_SOCKET: '/private/broker.sock',
};
const event = {
  hook_event_name: 'SessionStart',
  session_id: '019dbb46-5772-7493-a627-f8ae48954a64',
  transcript_path: '/private/codex.jsonl',
  cwd: '/private/worktree',
};

test('minimal hook runner builds only the exact bounded provider artifact RPC', () => {
  assert.deepEqual(buildProviderArtifactHookRequest({ tool: 'codex', env, event }), {
    socketPath: '/private/broker.sock',
    message: {
      type: 'capture_provider_artifact',
      id: 'sess_exact1',
      runtime_generation: '4f50f5a1-4c6b-4d6a-8b5c-152c5e6b8701',
      tool: 'codex',
      cwd: '/private/worktree',
      provider_session_id: '019dbb46-5772-7493-a627-f8ae48954a64',
      transcript_path: '/private/codex.jsonl',
    },
  });
});

test('minimal hook runner rejects stale, malformed, or non-hook evidence', () => {
  assert.equal(buildProviderArtifactHookRequest({
    tool: 'codex',
    env: { ...env, MC_RUNTIME_GENERATION: 'stale' },
    event,
  }), null);
  assert.equal(buildProviderArtifactHookRequest({
    tool: 'codex',
    env,
    event: { ...event, hook_event_name: 'Stop' },
  }), null);
  assert.equal(buildProviderArtifactHookRequest({
    tool: 'codex',
    env,
    event: { ...event, transcript_path: 'relative.jsonl' },
  }), null);
});
