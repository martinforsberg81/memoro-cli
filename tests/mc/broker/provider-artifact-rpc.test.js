import assert from 'node:assert/strict';
import test from 'node:test';
import { BrokerRuntime } from '../../../src/mc/broker/runtime.js';
import { deriveHandoffControllerRoot } from '../../../src/mc/handoff-controller-capability.js';

const generation = '4f50f5a1-4c6b-4d6a-8b5c-152c5e6b8701';
const controllerToken = 'provider-artifact-controller-token';

test('broker binds a Claude SessionStart artifact to its exact live generation only', () => {
  const cwd = process.cwd();
  let onData; let onExit;
  const runtime = new BrokerRuntime({
    ptyFactory: { spawn: () => ({ pid: 1, onData: (fn) => { onData = fn; }, onExit: (fn) => { onExit = fn; }, write() {}, resize() {}, kill() {} }) },
    controllerBindings: [{
      session_id: 'sess_exact',
      session_controller_capability: deriveHandoffControllerRoot({
        token: controllerToken,
        codingSessionId: 'sess_exact',
      }),
    }],
    launchResolver: () => ({ ok: true, id: 'claude-code', shortName: 'claude', spec: { bin: 'claude', args: () => [] } }),
    managedProviderResolver: ({ launch }) => ({ ok: true, launch }),
    lifecycleWriter: () => {},
    validateClaudeArtifact: () => ({ ok: true, workspace: cwd, transcriptPath: '/claude/projects/-repo/cl_exact.jsonl' }),
    providerArtifactWriter: ({ artifact }) => ({ ok: true, duplicate: false, artifact }),
  });
  assert.equal(runtime.handle({
    type: 'launch_session',
    session: {
      id: 'sess_exact',
      cwd,
      tool: 'claude-code',
      runtime_generation: generation,
      session_controller_capability: deriveHandoffControllerRoot({
        token: controllerToken,
        codingSessionId: 'sess_exact',
      }),
      sidecars: {
        enabled: false,
        token: controllerToken,
      },
    },
  }).ok, true);
  const captured = runtime.handle({
    type: 'capture_provider_artifact',
    id: 'sess_exact',
    runtime_generation: generation,
    tool: 'claude-code',
    cwd,
    provider_session_id: 'cl_exact',
    transcript_path: '/ignored',
  });
  assert.equal(captured.ok, true);
  assert.equal(captured.artifact.runtime_generation, generation);
  assert.equal('transcript_path' in captured.artifact, false);
  assert.equal('provider_session_id' in captured.artifact, false);
  assert.equal(runtime.handle({
    type: 'capture_provider_artifact',
    id: 'sess_exact',
    runtime_generation: generation,
    tool: 'codex',
    cwd,
    provider_session_id: 'cx_wrong',
    transcript_path: '/ignored',
  }).ok, false);
  assert.equal(runtime.handle({
    type: 'capture_provider_artifact',
    id: 'sess_exact',
    runtime_generation: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    tool: 'claude-code',
    cwd,
    provider_session_id: 'cl_exact',
    transcript_path: '/ignored',
  }).reason, 'provider-artifact-generation-mismatch');
  void onData; void onExit;
});

test('broker accepts exact Codex SessionStart evidence without scanning provider storage', () => {
  const cwd = process.cwd();
  let written = null;
  const runtime = new BrokerRuntime({
    ptyFactory: { spawn: () => ({ pid: 1, onData() {}, onExit() {}, write() {}, resize() {}, kill() {} }) },
    controllerBindings: [{
      session_id: 'sess_codex_exact',
      session_controller_capability: deriveHandoffControllerRoot({
        token: controllerToken,
        codingSessionId: 'sess_codex_exact',
      }),
    }],
    launchResolver: () => ({ ok: true, id: 'codex', shortName: 'codex', spec: { bin: 'codex', args: () => [] } }),
    managedProviderResolver: ({ launch }) => ({ ok: true, launch }),
    lifecycleWriter: () => {},
    validateCodexArtifact: () => ({ ok: true, workspace: cwd, transcriptPath: '/codex/exact.jsonl' }),
    providerArtifactWriter: ({ artifact }) => {
      written = artifact;
      return { ok: true, duplicate: false, artifact };
    },
  });
  assert.equal(runtime.handle({
    type: 'launch_session',
    session: {
      id: 'sess_codex_exact',
      cwd,
      tool: 'codex',
      runtime_generation: generation,
      session_controller_capability: deriveHandoffControllerRoot({
        token: controllerToken,
        codingSessionId: 'sess_codex_exact',
      }),
      sidecars: {
        enabled: false,
        token: controllerToken,
      },
    },
  }).ok, true);
  const captured = runtime.handle({
    type: 'capture_provider_artifact',
    id: 'sess_codex_exact',
    runtime_generation: generation,
    tool: 'codex',
    cwd,
    provider_session_id: 'cx_exact',
    transcript_path: '/codex/exact.jsonl',
  });
  assert.equal(captured.ok, true);
  assert.equal(written.provider_session_id, 'cx_exact');
  assert.equal(written.transcript_path, '/codex/exact.jsonl');
  assert.equal('transcript_path' in runtime.listSessions()[0], false);
});
