import assert from 'node:assert/strict';
import test from 'node:test';
import {
  appendManagedGenerationReceiptSync,
  beginManagedGenerationSync,
  buildManagedGenerationIntent,
  inspectManagedSessionSync,
} from '../../src/mc/managed-generation-journal.js';
import { reconcileManagedSession } from '../../src/mc/managed-session-reconciler.js';

const generation = '4f50f5a1-4c6b-4d6a-8b5c-152c5e6b8701';
const time = '2026-07-29T12:00:00.000Z';
const digest = 'a'.repeat(64);

function fixture(phases = []) {
  const started = beginManagedGenerationSyncFixture();
  const receipts = {};
  for (const [phase, data] of phases) {
    receipts[phase] = { phase, data };
  }
  const phase = phases.at(-1)?.[0] || 'intent';
  const generationValue = {
    sequence: 1,
    coding_session_id: 'sess_reconcile',
    runtime_generation: generation,
    intent: started.intent,
    receipts,
    phase,
    terminal: ['ready', 'aborted'].includes(phase),
  };
  return {
    generation: generationValue,
    session: {
      kind: 'present',
      generations: [generationValue],
      active: generationValue.terminal ? null : generationValue,
    },
  };
}

function beginManagedGenerationSyncFixture() {
  return {
    intent: buildManagedGenerationIntent({
      codingSessionId: 'sess_reconcile',
      runtimeGeneration: generation,
      sequence: 1,
      mode: 'fresh',
      tool: 'codex',
      resumeProviderSessionId: null,
      recordedAt: time,
    }),
  };
}

const domainReady = ['domain-ready', {
  domain_generation: '687c338a-1ed4-4c20-9828-1f9a39d37067',
  manifest_digest: digest,
}];

test('reconciler attaches only the exact durable managed generation', async () => {
  const { session } = fixture([
    domainReady,
    ['broker-accepted', {}],
    ['live', {}],
  ]);
  const attached = await reconcileManagedSession({
    entry: { coding_session_id: 'sess_reconcile' },
    inspectLocalPresence: async () => ({
      verdict: 'live',
      runtime_generation: generation,
      session: { managed_provider: true },
    }),
    deps: { inspectManagedSession: () => session },
  });
  assert.equal(attached.action, 'attach');

  const mismatch = await reconcileManagedSession({
    entry: { coding_session_id: 'sess_reconcile' },
    inspectLocalPresence: async () => ({
      verdict: 'live',
      runtime_generation: generation,
      session: { managed_provider: false },
    }),
    deps: { inspectManagedSession: () => session },
  });
  assert.equal(mismatch.action, 'blocked');
  assert.equal(mismatch.reason, 'managed-live-runtime-binding-mismatch');
});

test('reconciler aborts a domain that durably never reached broker acceptance', async () => {
  const { session } = fixture([domainReady]);
  const writes = [];
  const result = await reconcileManagedSession({
    entry: { coding_session_id: 'sess_reconcile' },
    inspectLocalPresence: async () => ({ verdict: 'unknown' }),
    deps: {
      inspectManagedSession: () => session,
      inspectPreparedDomain: () => ({
        ok: true,
        descriptor: {
          generation: domainReady[1].domain_generation,
          manifest_sha256: domainReady[1].manifest_digest,
        },
      }),
      abortCredentialDomain: () => ({ ok: true }),
      appendManagedReceipt: (receipt) => {
        writes.push(receipt);
        return { ok: true };
      },
    },
  });
  assert.equal(result.action, 'start');
  assert.deepEqual(writes.map((write) => write.phase), ['aborted']);
});

test('reconciler records abort after domain cleanup won the crash race', async () => {
  const { session } = fixture([domainReady]);
  const writes = [];
  const result = await reconcileManagedSession({
    entry: { coding_session_id: 'sess_reconcile' },
    inspectLocalPresence: async () => ({ verdict: 'absent' }),
    deps: {
      inspectManagedSession: () => session,
      inspectPreparedDomain: () => ({ ok: false, reason: 'domain-missing' }),
      confirmCredentialDomainAbsent: () => ({ ok: true, absent: true }),
      appendManagedReceipt: (receipt) => {
        writes.push(receipt);
        return { ok: true };
      },
    },
  });
  assert.equal(result.action, 'start');
  assert.deepEqual(writes.map((write) => write.phase), ['aborted']);
});

test('reconciler never deletes an unjournaled legacy or orphan domain', async () => {
  const descriptor = {
    generation: domainReady[1].domain_generation,
    manifest_sha256: domainReady[1].manifest_digest,
  };
  const aborts = [];
  const result = await reconcileManagedSession({
    entry: { coding_session_id: 'sess_reconcile' },
    inspectLocalPresence: async () => ({ verdict: 'absent' }),
    deps: {
      inspectManagedSession: () => ({
        kind: 'absent',
        generations: [],
        active: null,
      }),
      inspectCredentialDomainPresence: () => ({
        kind: 'present',
        descriptor,
      }),
      abortCredentialDomain: (input) => {
        aborts.push(input);
        return { ok: true };
      },
    },
  });
  assert.equal(result.action, 'blocked');
  assert.equal(result.reason, 'managed-legacy-or-orphan-domain-unconfirmed');
  assert.deepEqual(aborts, []);
});

test('reconciler safely aborts an intent before any broker acceptance', async () => {
  const { session } = fixture([]);
  const writes = [];
  const result = await reconcileManagedSession({
    entry: { coding_session_id: 'sess_reconcile' },
    inspectLocalPresence: async () => ({ verdict: 'absent' }),
    deps: {
      inspectManagedSession: () => session,
      inspectCredentialDomainPresence: () => ({ kind: 'absent' }),
      appendManagedReceipt: (receipt) => {
        writes.push(receipt);
        return { ok: true };
      },
    },
  });
  assert.equal(result.action, 'start');
  assert.deepEqual(writes.map((write) => write.phase), ['aborted']);
});

test('reconciler aborts only the exact domain generation bound to an intent', async () => {
  const { session } = fixture([]);
  const aborts = [];
  const writes = [];
  const descriptor = { generation };
  const result = await reconcileManagedSession({
    entry: { coding_session_id: 'sess_reconcile' },
    inspectLocalPresence: async () => ({ verdict: 'absent' }),
    deps: {
      inspectManagedSession: () => session,
      inspectCredentialDomainPresence: () => ({
        kind: 'present',
        descriptor,
      }),
      abortCredentialDomain: (input) => {
        aborts.push(input);
        return { ok: true };
      },
      appendManagedReceipt: (receipt) => {
        writes.push(receipt);
        return { ok: true };
      },
    },
  });
  assert.equal(result.action, 'start');
  assert.deepEqual(aborts, [{ descriptor }]);
  assert.deepEqual(writes.map((write) => write.phase), ['aborted']);
});

test('reconciler does not delete a domain that is not bound to the active intent', async () => {
  const { session } = fixture([]);
  let aborted = false;
  const result = await reconcileManagedSession({
    entry: { coding_session_id: 'sess_reconcile' },
    inspectLocalPresence: async () => ({ verdict: 'absent' }),
    deps: {
      inspectManagedSession: () => session,
      inspectCredentialDomainPresence: () => ({
        kind: 'present',
        descriptor: {
          generation: '687c338a-1ed4-4c20-9828-1f9a39d37067',
        },
      }),
      abortCredentialDomain: () => {
        aborted = true;
        return { ok: true };
      },
    },
  });
  assert.equal(result.action, 'blocked');
  assert.equal(result.reason, 'managed-intent-domain-binding-mismatch');
  assert.equal(aborted, false);
});

test('reconciler completes ready after cleanup won the crash race', async () => {
  const providerData = {
    provider_session_id: 'provider_1',
    artifact_digest: digest,
    tool: 'codex',
    transcript_path: '/private/tmp/rollout.jsonl',
    captured_at: time,
  };
  const archiveData = {
    provider_session_id: 'provider_1',
    archive_digest: digest,
  };
  const { session } = fixture([
    domainReady,
    ['broker-accepted', {}],
    ['live', {}],
    ['provider-artifact', providerData],
    ['exited', { exit_code: 0, signal: null }],
    ['custody-persisted', { record_digest: digest }],
    ['archive-ready', archiveData],
  ]);
  const writes = [];
  const result = await reconcileManagedSession({
    entry: { coding_session_id: 'sess_reconcile' },
    inspectLocalPresence: async () => ({ verdict: 'exited' }),
    deps: {
      inspectManagedSession: () => session,
      inspectPreparedDomain: () => ({ ok: false, reason: 'domain-missing' }),
      confirmCredentialDomainAbsent: () => ({ ok: true, absent: true }),
      appendManagedReceipt: (receipt) => {
        writes.push(receipt);
        return { ok: true };
      },
    },
  });
  assert.equal(result.action, 'resume');
  assert.equal(result.providerSessionId, 'provider_1');
  assert.deepEqual(writes.map((write) => write.phase), ['domain-cleaned', 'ready']);
});

test('reconciler finalizes an exited generation with adapter-proven provider absence', async () => {
  const built = fixture([
    domainReady,
    ['broker-accepted', {}],
    ['live', {}],
    ['exited', { exit_code: 0, signal: null }],
  ]);
  const completed = {
    ...built.generation,
    phase: 'ready',
    terminal: true,
    receipts: {
      ...built.generation.receipts,
      'provider-absent': {
        data: { evidence_digest: digest, tool: 'codex' },
      },
      'custody-persisted': { data: { record_digest: digest } },
      'domain-cleaned': {
        data: { domain_generation: domainReady[1].domain_generation },
      },
      ready: {
        data: { provider_session_id: null, archive_digest: null },
      },
    },
  };
  let closeInput = null;
  const result = await reconcileManagedSession({
    entry: { coding_session_id: 'sess_reconcile' },
    inspectLocalPresence: async () => ({ verdict: 'exited' }),
    root: '/private/mc',
    deps: {
      inspectManagedSession: () => built.session,
      inspectPreparedDomain: () => ({
        ok: true,
        descriptor: {
          generation: domainReady[1].domain_generation,
          manifest_sha256: domainReady[1].manifest_digest,
        },
      }),
      closeCredentialDomain: async (input) => {
        closeInput = input;
        return { ok: true };
      },
      inspectManagedGeneration: () => ({ kind: 'present', ...completed }),
    },
  });
  assert.equal(result.action, 'start');
  assert.equal(closeInput.providerArtifact, null);
  assert.equal(closeInput.root, '/private/mc');
});

test('real receipt state is the only authority for the next action', async () => {
  const writes = [];
  const started = beginManagedGenerationSyncFixture();
  const realGeneration = fixture([
    domainReady,
    ['broker-accepted', {}],
    ['live', {}],
  ]).generation;
  const result = await reconcileManagedSession({
    entry: { coding_session_id: 'sess_reconcile' },
    inspectLocalPresence: async () => ({ verdict: 'unreachable' }),
    deps: {
      inspectManagedSession: () => ({
        kind: 'present',
        generations: [realGeneration],
        active: realGeneration,
      }),
      appendManagedReceipt: (receipt) => writes.push(receipt),
    },
  });
  assert.equal(result.action, 'blocked');
  assert.equal(result.reason, 'managed-live-runtime-unreachable');
  assert.equal(writes.length, 0);
  assert.equal(started.intent.runtime_generation, generation);
  assert.equal(typeof inspectManagedSessionSync, 'function');
  assert.equal(typeof appendManagedGenerationReceiptSync, 'function');
});

test('reconciler recovers the exact accepted generation after its bound host dies', async () => {
  const priorRuntimeGeneration = '687c338a-1ed4-4c20-9828-1f9a39d37067';
  const providerSessionId = 'provider_1';
  const intent = buildManagedGenerationIntent({
    codingSessionId: 'sess_reconcile',
    runtimeGeneration: generation,
    sequence: 2,
    mode: 'resume',
    tool: 'codex',
    resumeProviderSessionId: providerSessionId,
    recordedAt: '2026-07-31T04:00:00.000Z',
  });
  const active = {
    sequence: 2,
    coding_session_id: 'sess_reconcile',
    runtime_generation: generation,
    intent,
    receipts: {
      'domain-ready': {
        recorded_at: '2026-07-31T04:00:06.000Z',
        data: domainReady[1],
      },
      'broker-accepted': {
        recorded_at: '2026-07-31T04:00:08.000Z',
        data: {},
      },
      live: {
        recorded_at: '2026-07-31T04:00:09.000Z',
        data: {},
      },
    },
    phase: 'live',
    terminal: false,
  };
  const prior = {
    sequence: 1,
    coding_session_id: 'sess_reconcile',
    runtime_generation: priorRuntimeGeneration,
    intent: buildManagedGenerationIntent({
      codingSessionId: 'sess_reconcile',
      runtimeGeneration: priorRuntimeGeneration,
      sequence: 1,
      mode: 'fresh',
      tool: 'codex',
      resumeProviderSessionId: null,
      recordedAt: '2026-07-31T03:50:00.000Z',
    }),
    receipts: {
      ready: {
        recorded_at: '2026-07-31T03:59:00.000Z',
        data: {
          provider_session_id: providerSessionId,
          archive_digest: digest,
        },
      },
    },
    phase: 'ready',
    terminal: true,
  };
  const providerData = {
    provider_session_id: providerSessionId,
    artifact_digest: digest,
    tool: 'codex',
    transcript_path: '/private/provider/session.jsonl',
    captured_at: '2026-07-31T04:01:00.000Z',
  };
  const exited = {
    ...active,
    receipts: {
      ...active.receipts,
      'provider-artifact': { data: providerData },
      exited: { data: { exit_code: null, signal: null } },
    },
    phase: 'exited',
  };
  const completed = {
    ...exited,
    receipts: {
      ...exited.receipts,
      'custody-persisted': { data: { record_digest: digest } },
      'archive-ready': {
        data: {
          provider_session_id: providerSessionId,
          archive_digest: digest,
        },
      },
      'domain-cleaned': {
        data: { domain_generation: domainReady[1].domain_generation },
      },
      ready: {
        data: {
          provider_session_id: providerSessionId,
          archive_digest: digest,
        },
      },
    },
    phase: 'ready',
    terminal: true,
  };
  const writes = [];
  let generationInspections = 0;
  let closeInput = null;
  const result = await reconcileManagedSession({
    entry: {
      coding_session_id: 'sess_reconcile',
      tool: 'codex',
      worktree_path: '/repo',
    },
    inspectLocalPresence: async () => ({
      verdict: 'exited',
      runtime_generation: priorRuntimeGeneration,
      session: null,
      lifecycle: {
        verdict: 'exited',
        record: {
          coding_session_id: 'sess_reconcile',
          runtime_generation: priorRuntimeGeneration,
          state: 'exited',
          observed_at: '2026-07-31T03:58:00.000Z',
          exit_code: 0,
        },
      },
      host_runtime: {
        verdict: 'exited',
        reason: 'host-process-exited',
        pid: 2468,
        host_manifest: {
          session_id: 'sess_reconcile',
          broker_pid: 2468,
          updated_at: '2026-07-31T04:00:00.000Z',
        },
      },
      reason: 'host-process-exited',
    }),
    deps: {
      inspectManagedSession: () => ({
        kind: 'present',
        generations: [prior, active],
        active,
      }),
      inspectPreparedDomain: () => ({
        ok: true,
        descriptor: {
          generation: domainReady[1].domain_generation,
          manifest_sha256: domainReady[1].manifest_digest,
        },
      }),
      managedProviderArtifactContextForLaunch: ({ input }) => {
        assert.deepEqual(input.argv, ['resume', providerSessionId]);
        return { sessions_dir: '/private/provider' };
      },
      observeManagedProviderArtifact: () => ({
        ok: true,
        evidence: {
          cwd: '/repo',
          providerSessionId,
          transcriptPath: '/private/provider/session.jsonl',
        },
      }),
      validateManagedProviderArtifact: () => ({
        ok: true,
        workspace: '/repo',
        transcriptPath: '/private/provider/session.jsonl',
      }),
      appendManagedReceipt: (receipt) => {
        writes.push(receipt);
        return { ok: true };
      },
      inspectManagedGeneration: () => {
        generationInspections += 1;
        return generationInspections === 1
          ? { kind: 'present', ...exited }
          : { kind: 'present', ...completed };
      },
      closeCredentialDomain: async (input) => {
        closeInput = input;
        return { ok: true };
      },
    },
  });

  assert.equal(result.action, 'resume');
  assert.equal(result.providerSessionId, providerSessionId);
  assert.deepEqual(writes.map((write) => write.phase), [
    'provider-artifact',
    'exited',
  ]);
  assert.equal(closeInput.providerArtifact.provider_session_id, providerSessionId);
  assert.equal(closeInput.providerArtifact.runtime_generation, generation);
});

test('reconciler does not recover a dead host whose manifest is outside the launch window', async () => {
  const built = fixture([
    domainReady,
    ['broker-accepted', {}],
    ['live', {}],
  ]);
  built.generation.intent.recorded_at = '2026-07-31T04:00:00.000Z';
  built.generation.receipts['broker-accepted'].recorded_at = '2026-07-31T04:00:08.000Z';
  const writes = [];
  const result = await reconcileManagedSession({
    entry: {
      coding_session_id: 'sess_reconcile',
      tool: 'codex',
      worktree_path: '/repo',
    },
    inspectLocalPresence: async () => ({
      verdict: 'exited',
      session: null,
      runtime_generation: null,
      host_runtime: {
        verdict: 'exited',
        reason: 'host-process-exited',
        pid: 2468,
        host_manifest: {
          session_id: 'sess_reconcile',
          broker_pid: 2468,
          updated_at: '2026-07-31T03:00:00.000Z',
        },
      },
    }),
    deps: {
      inspectManagedSession: () => built.session,
      appendManagedReceipt: (receipt) => writes.push(receipt),
    },
  });

  assert.equal(result.action, 'blocked');
  assert.equal(result.reason, 'managed-accepted-generation-outcome-unconfirmed');
  assert.deepEqual(writes, []);
});
