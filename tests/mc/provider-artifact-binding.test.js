import assert from 'node:assert/strict';
import test from 'node:test';
import { launchFreshSession, launchResumeSession } from '../../src/mc/commands/resume.js';
import { LOCAL_AUTH_MODES } from '../../src/mc/local-auth-mode.js';

test('fresh launch binds only a broker-confirmed provider artifact to its provider map', async () => {
  const writes = [];
  const code = await launchFreshSession({
    entry: { name: 'artifact', tool: 'codex', worktree_path: '/repo', coding_session_id: 'sess_artifact' },
    localAuthMode: LOCAL_AUTH_MODES.NATIVE,
    deps: {
      requireLocalAuthMode: () => ({ ok: true }),
      materialiseVaultBeforeLaunch: async () => ({ ok: true }),
      launchBrokerOwnedSession: async (arg) => {
        await arg.onLaunched({ codingSessionId: 'sess_artifact' });
        await arg.onExited({ providerArtifact: {
          tool: 'codex', provider_session_id: 'cx_exact', transcript_path: '/private/tmp/cx.jsonl',
          runtime_generation: '4f50f5a1-4c6b-4d6a-8b5c-152c5e6b8701',
        } });
        return { code: 0 };
      },
      upsertEntry: (patch) => { writes.push(patch); return patch; },
    },
  });
  assert.equal(code, 0);
  const bound = writes.at(-1).provider_sessions.providers.codex;
  assert.deepEqual(bound, {
    session_id: 'cx_exact', transcript_path: '/private/tmp/cx.jsonl',
    runtime_generation: '4f50f5a1-4c6b-4d6a-8b5c-152c5e6b8701', last_consumed_handoff_sequence: 0,
  });
});

test('native resume binds the new runtime generation only after broker-confirmed artifact capture', async () => {
  const oldGeneration = '2e13d39b-5c72-4b1b-9c4a-fddf77ed2419';
  const newGeneration = '4f50f5a1-4c6b-4d6a-8b5c-152c5e6b8701';
  const writes = [];
  const entry = {
    name: 'artifact-resume',
    tool: 'codex',
    worktree_path: '/repo',
    coding_session_id: 'sess_artifact',
    provider_sessions: {
      schema: 1,
      providers: {
        codex: {
          session_id: 'cx_exact',
          transcript_path: '/private/tmp/cx.jsonl',
          runtime_generation: oldGeneration,
          last_consumed_handoff_sequence: 0,
        },
      },
    },
  };
  const code = await launchResumeSession({
    entry,
    launchTool: {
      id: 'codex',
      shortName: 'codex',
      resumeArgs: (sessionId) => ['resume', sessionId],
    },
    localAuthMode: LOCAL_AUTH_MODES.NATIVE,
    deps: {
      requireLocalAuthMode: () => ({ ok: true }),
      materialiseVaultBeforeLaunch: async () => ({ ok: true }),
      launchBrokerOwnedSession: async (arg) => {
        await arg.onLaunched({
          codingSessionId: 'sess_artifact',
          runtimeGeneration: newGeneration,
        });
        assert.equal(
          writes.at(-1).provider_sessions.providers.codex.runtime_generation,
          oldGeneration,
        );
        await arg.onExited({ providerArtifact: {
          tool: 'codex',
          provider_session_id: 'cx_exact',
          transcript_path: '/private/tmp/cx.jsonl',
          runtime_generation: newGeneration,
        } });
        return { code: 0 };
      },
      upsertEntry: (patch) => { writes.push(patch); return patch; },
    },
  });
  assert.equal(code, 0);
  assert.equal(
    writes.at(-1).provider_sessions.providers.codex.runtime_generation,
    newGeneration,
  );
});
