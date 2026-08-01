import assert from 'node:assert/strict';
import test from 'node:test';
import { BrokerRuntime } from '../../../src/runtime/broker/runtime.js';
import { deriveHandoffControllerRoot } from '../../../src/mc/handoff-controller-capability.js';

const generation = '4f50f5a1-4c6b-4d6a-8b5c-152c5e6b8701';
const controllerToken = 'provider-artifact-controller-token';

function makeTestInterlock() {
  return {
    acquireProvider: () => ({
      ok: true,
      lease: {
        release: () => ({ ok: true }),
      },
    }),
  };
}

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
    c1Interlock: makeTestInterlock(),
    lifecycleWriter: () => {},
    providerArtifactValidator: ({ tool }) => (
      tool === 'claude-code'
        ? { ok: true, workspace: cwd, transcriptPath: '/claude/projects/-repo/cl_exact.jsonl' }
        : { ok: false, reason: 'provider-artifact-tool-unsupported' }
    ),
    providerArtifactWriter: ({ artifact }) => ({ ok: true, duplicate: false, artifact }),
  });
  const launched = runtime.handle({
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
      },
    },
  });
  assert.equal(launched.ok, true, launched.reason || launched.error);
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

test('broker captures exact Codex evidence from broker-owned output observation', () => {
  const cwd = process.cwd();
  let written = null;
  let onData = null;
  const runtime = new BrokerRuntime({
    ptyFactory: { spawn: () => ({
      pid: 1,
      onData(fn) { onData = fn; },
      onExit() {},
      write() {},
      resize() {},
      kill() {},
    }) },
    controllerBindings: [{
      session_id: 'sess_codex_exact',
      session_controller_capability: deriveHandoffControllerRoot({
        token: controllerToken,
        codingSessionId: 'sess_codex_exact',
      }),
    }],
    launchResolver: () => ({ ok: true, id: 'codex', shortName: 'codex', spec: { bin: 'codex', args: () => [] } }),
    managedProviderResolver: ({ launch }) => ({ ok: true, launch }),
    c1Interlock: makeTestInterlock(),
    lifecycleWriter: () => {},
    providerArtifactObserver: ({ tool }) => (
      tool === 'codex'
        ? {
            ok: true,
            evidence: {
              cwd,
              providerSessionId: 'cx_exact',
              transcriptPath: '/codex/exact.jsonl',
            },
          }
        : { ok: false, reason: 'provider-artifact-observation-unsupported' }
    ),
    providerArtifactValidator: ({ tool }) => (
      tool === 'codex'
        ? { ok: true, workspace: cwd, transcriptPath: '/codex/exact.jsonl' }
        : { ok: false, reason: 'provider-artifact-tool-unsupported' }
    ),
    providerArtifactWriter: ({ artifact }) => {
      written = artifact;
      return { ok: true, duplicate: false, artifact };
    },
  });
  const launched = runtime.handle({
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
      },
    },
  });
  assert.equal(launched.ok, true, launched.reason || launched.error);
  onData('codex ready');
  assert.equal(written.provider_session_id, 'cx_exact');
  assert.equal(written.transcript_path, '/codex/exact.jsonl');
  assert.equal('transcript_path' in runtime.listSessions()[0], false);
});
