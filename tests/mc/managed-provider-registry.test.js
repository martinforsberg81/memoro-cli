import assert from 'node:assert/strict';
import test from 'node:test';

import {
  MANAGED_PROVIDER_ADAPTER_SCHEMA,
  abortManagedCredentialDomain,
  closeManagedCredentialDomain,
  createManagedProviderRegistry,
  finalizeManagedCredentialDomain,
  inspectManagedProviderHandoffSource,
  inspectManagedProviderReadiness,
  managedProviderAdapterForTool,
  managedProviderArtifactContextForLaunch,
  observeManagedProviderArtifact,
  prepareManagedCredentialDomain,
  resolveManagedProviderLaunch,
  validateManagedProviderArtifact,
} from '../../src/mc/managed-provider-registry.js';
import {
  buildManagedGenerationIntent,
  managedTransactionFromIntent,
} from '../../src/mc/managed-generation-journal.js';

function fixtureAdapter({
  toolId = 'future-cli',
  providerAdapterId = 'future-managed-v1',
  calls = [],
} = {}) {
  return {
    schema: MANAGED_PROVIDER_ADAPTER_SCHEMA,
    tool_id: toolId,
    provider_adapter_id: providerAdapterId,
    prepareCredentialDomain: (input) => {
      calls.push(['prepare', input]);
      return { ok: true, descriptor: descriptor(providerAdapterId) };
    },
    resolveLaunch: (input) => {
      calls.push(['resolve', input]);
      return { ok: true, launch: input.launch, descriptor: input.input.credential_domain };
    },
    closeCredentialDomain: (input) => {
      calls.push(['close', input]);
      return { ok: true };
    },
    abortCredentialDomain: (input) => {
      calls.push(['abort', input]);
      return { ok: true };
    },
    inspectCredentialDomainPresence: () => ({ kind: 'absent' }),
    inspectPreparedCredentialDomain: () => ({ ok: false, reason: 'absent' }),
    confirmCredentialDomainAbsent: () => ({ ok: true, absent: true }),
    inspectReadiness: () => ({
      schema: 'mc-managed-provider-readiness/v1',
      ok: true,
      tool_id: toolId,
      provider_adapter_id: providerAdapterId,
      reason: null,
      hint: null,
    }),
    inspectProviderAbsence: () => ({
      schema: 'mc-managed-provider-absence/v1',
      ok: true,
      tool_id: toolId,
      provider_adapter_id: providerAdapterId,
      evidence_digest: 'a'.repeat(64),
      reason: null,
    }),
    credentialBoundaryEvidence: () => null,
    importLegacyRecovery: () => ({ ok: true, attempted: false }),
    captureProviderArtifactContext: (input) => {
      calls.push(['artifact-context', input]);
      return { root: '/provider/session-state' };
    },
    observeProviderArtifact: (input) => {
      calls.push(['artifact-observe', input]);
      return { ok: false, reason: 'provider-artifact-not-observed' };
    },
    validateProviderArtifact: (input) => {
      calls.push(['artifact-validate', input]);
      return input.context?.root === '/provider/session-state'
        ? {
            ok: true,
            workspace: '/repo',
            transcriptPath: '/provider/session-state/exact.jsonl',
          }
        : { ok: false, reason: 'artifact-context-mismatch' };
    },
  };
}

function descriptor(providerAdapterId = 'future-managed-v1') {
  return {
    schema: 'future-domain/v1',
    provider_adapter: providerAdapterId,
  };
}

test('managed core routes an arbitrary provider through one strict adapter contract', async () => {
  const calls = [];
  const registry = createManagedProviderRegistry([fixtureAdapter({ calls })]);

  const prepared = await prepareManagedCredentialDomain({
    providerRegistry: registry,
    tool: 'future-cli',
    codingSessionId: 'sess_future',
  });
  assert.equal(prepared.ok, true);
  assert.equal(calls[0][0], 'prepare');
  assert.equal(calls[0][1].tool, 'future-cli');
  assert.equal((await inspectManagedProviderReadiness({
    providerRegistry: registry,
    tool: 'future-cli',
  })).ok, true);

  const launch = { id: 'future-cli', shortName: 'future' };
  const resolved = resolveManagedProviderLaunch({
    providerRegistry: registry,
    launch,
    input: { credential_domain: prepared.descriptor, env: {} },
  });
  assert.equal(resolved.ok, true);
  assert.equal(calls[1][0], 'resolve');

  assert.equal((await closeManagedCredentialDomain({
    providerRegistry: registry,
    descriptor: prepared.descriptor,
  })).ok, true);
  assert.equal(abortManagedCredentialDomain({
    providerRegistry: registry,
    descriptor: prepared.descriptor,
  }).ok, true);
  const artifactContext = managedProviderArtifactContextForLaunch({
    providerRegistry: registry,
    tool: 'future-cli',
    provider: { descriptor: prepared.descriptor },
  });
  assert.deepEqual(artifactContext, { root: '/provider/session-state' });
  assert.equal(observeManagedProviderArtifact({
    providerRegistry: registry,
    tool: 'future-cli',
    context: artifactContext,
    cwd: '/repo',
  }).reason, 'provider-artifact-not-observed');
  const artifact = validateManagedProviderArtifact({
    providerRegistry: registry,
    tool: 'future-cli',
    evidence: { providerSessionId: 'provider-native-id' },
    context: artifactContext,
  });
  assert.equal(artifact.ok, true);
  assert.deepEqual(calls.map(([operation]) => operation), [
    'prepare',
    'resolve',
    'close',
    'abort',
    'artifact-context',
    'artifact-observe',
    'artifact-validate',
  ]);
});

test('central finalization requires adapter proof before publishing provider absence', async () => {
  const calls = [];
  const registry = createManagedProviderRegistry([fixtureAdapter({ calls })]);
  const intent = buildManagedGenerationIntent({
    codingSessionId: 'sess_future',
    runtimeGeneration: '687c338a-1ed4-4c20-9828-1f9a39d37067',
    sequence: 1,
    mode: 'fresh',
    tool: 'future-cli',
    resumeProviderSessionId: null,
    recordedAt: '2026-07-29T12:00:00.000Z',
  });
  const receipts = [];
  const result = await finalizeManagedCredentialDomain({
    providerRegistry: registry,
    descriptor: descriptor(),
    providerArtifact: null,
    managedTransaction: managedTransactionFromIntent(intent),
    root: '/private/mc',
    deps: {
      inspectManagedGeneration: () => ({
        kind: 'present',
        intent,
        receipts: {
          exited: { data: { exit_code: 0, signal: null } },
        },
      }),
      appendManagedReceipt: (receipt) => {
        receipts.push(receipt);
        return { ok: true };
      },
    },
  });
  assert.equal(result.ok, true);
  assert.deepEqual(receipts.map((receipt) => [receipt.phase, receipt.data]), [[
    'provider-absent',
    {
      evidence_digest: 'a'.repeat(64),
      tool: 'future-cli',
    },
  ]]);
  assert.equal(calls.at(-1)[0], 'close');
  assert.equal(calls.at(-1)[1].providerArtifact, null);
});

test('managed handoff source proof is terminal, path-free, and adapter-bound', () => {
  const adapter = fixtureAdapter({});
  const registry = createManagedProviderRegistry([adapter]);
  const runtimeGeneration = '687c338a-1ed4-4c20-9828-1f9a39d37067';
  const result = inspectManagedProviderHandoffSource({
    providerRegistry: registry,
    tool: 'future-cli',
    codingSessionId: 'sess_future',
    providerSessionId: 'provider-native-id',
    runtimeGeneration,
    root: '/private/mc',
    deps: {
      inspectManagedGeneration: () => ({
        kind: 'present',
        phase: 'ready',
        terminal: true,
        coding_session_id: 'sess_future',
        runtime_generation: runtimeGeneration,
        intent: { data: { tool: 'future-cli' } },
        receipts: {
          'provider-artifact': {
            data: {
              tool: 'future-cli',
              provider_session_id: 'provider-native-id',
              transcript_path: '/private/provider/transcript.jsonl',
            },
          },
          'archive-ready': {
            data: {
              provider_session_id: 'provider-native-id',
              archive_digest: 'b'.repeat(64),
            },
          },
          ready: {
            data: {
              provider_session_id: 'provider-native-id',
              archive_digest: 'b'.repeat(64),
            },
          },
        },
      }),
    },
  });

  assert.deepEqual(result, {
    schema: 'mc-managed-provider-handoff-source/v1',
    ok: true,
    tool_id: 'future-cli',
    provider_adapter_id: 'future-managed-v1',
    coding_session_id: 'sess_future',
    provider_session_id: 'provider-native-id',
    runtime_generation: runtimeGeneration,
    archive_digest: 'b'.repeat(64),
    reason: null,
  });
  assert.doesNotMatch(JSON.stringify(result), /transcript|\/private\//u);

  const incomplete = inspectManagedProviderHandoffSource({
    providerRegistry: registry,
    tool: 'future-cli',
    codingSessionId: 'sess_future',
    providerSessionId: 'provider-native-id',
    runtimeGeneration,
    deps: {
      inspectManagedGeneration: () => ({
        kind: 'present',
        phase: 'exited',
        terminal: false,
        receipts: {},
      }),
    },
  });
  assert.equal(incomplete.ok, false);
  assert.equal(incomplete.reason, 'managed-handoff-source-artifact-unconfirmed');
});

test('registry rejects duplicate, incomplete, and cross-provider bindings', async () => {
  const adapter = fixtureAdapter({});
  assert.throws(
    () => createManagedProviderRegistry([adapter, adapter]),
    /duplicated/,
  );
  assert.throws(
    () => createManagedProviderRegistry([{ ...adapter, closeCredentialDomain: null }]),
    /contract is invalid/,
  );
  const {
    captureProviderArtifactContext: _captureProviderArtifactContext,
    ...partialAdapter
  } = adapter;
  assert.throws(
    () => createManagedProviderRegistry([partialAdapter]),
    /contract is invalid/,
  );

  const registry = createManagedProviderRegistry([adapter]);
  assert.equal((await prepareManagedCredentialDomain({
    providerRegistry: registry,
    tool: 'unknown-cli',
  })).reason, 'managed-provider-tool-unsupported');
  assert.equal((await inspectManagedProviderReadiness({
    providerRegistry: registry,
    tool: 'unknown-cli',
  })).reason, 'managed-provider-tool-unsupported');
  assert.equal(resolveManagedProviderLaunch({
    providerRegistry: registry,
    launch: { id: 'other-cli' },
    input: { credential_domain: descriptor() },
  }).reason, 'managed-provider-adapter-unsupported');
  assert.equal(resolveManagedProviderLaunch({
    providerRegistry: registry,
    launch: { id: 'future-cli' },
    input: { credential_domain: descriptor('forged-managed-v1') },
  }).reason, 'managed-provider-adapter-unsupported');
});

test('public registry metadata is data-only and contains no implementation authority', () => {
  const registry = createManagedProviderRegistry([fixtureAdapter({})]);
  assert.deepEqual(registry.list(), [{
    schema: MANAGED_PROVIDER_ADAPTER_SCHEMA,
    tool_id: 'future-cli',
    provider_adapter_id: 'future-managed-v1',
  }]);
  assert.doesNotMatch(JSON.stringify(registry.list()), /function|credential|token/i);
});

test('production registry exposes complete Codex and Claude adapters only', () => {
  assert.deepEqual(managedProviderAdapterForTool('codex'), {
    schema: MANAGED_PROVIDER_ADAPTER_SCHEMA,
    tool_id: 'codex',
    provider_adapter_id: 'codex-managed-local-v1',
  });
  assert.deepEqual(managedProviderAdapterForTool('claude-code'), {
    schema: MANAGED_PROVIDER_ADAPTER_SCHEMA,
    tool_id: 'claude-code',
    provider_adapter_id: 'claude-managed-local-v1',
  });
  assert.equal(managedProviderAdapterForTool('gemini-cli'), null);
});

test('production readiness stays metadata-only and provider-owned', async () => {
  const portal = {
    apiUrl: 'https://example.test',
    token: 'must-not-be-returned',
  };
  const codex = await inspectManagedProviderReadiness({
    tool: 'codex',
    portal,
    deps: {
      codexBinary: '/private/pinned-codex',
      inspectRelease: () => ({
        ok: true,
        nativeBinary: '/private/pinned-codex',
        version: '0.145.0',
        sha256: 'a'.repeat(64),
      }),
      inspectCustody: ({ portal: received }) => {
        assert.equal(received, portal);
        return {
          ok: true,
          secretId: 'opaque-codex-record',
          authBody: 'must-not-be-returned',
        };
      },
    },
  });
  assert.deepEqual(codex, {
    schema: 'mc-managed-provider-readiness/v1',
    ok: true,
    tool_id: 'codex',
    provider_adapter_id: 'codex-managed-local-v1',
    reason: null,
    hint: null,
  });

  const claude = await inspectManagedProviderReadiness({
    tool: 'claude-code',
    portal,
    root: '/private/mc',
    deps: {
      inspectCertification: ({ root }) => {
        assert.equal(root, '/private/mc');
        return { ok: true, path: '/private/certification' };
      },
      verifyArtifacts: () => ({
        ok: true,
        artifacts: { claudeBinary: '/private/pinned-claude' },
      }),
      inspectCustody: ({ portal: received }) => {
        assert.equal(received, portal);
        return {
          ok: true,
          secretId: 'opaque-claude-record',
          revision: 7,
          grant: { accessToken: 'must-not-be-returned' },
        };
      },
    },
  });
  assert.deepEqual(claude, {
    schema: 'mc-managed-provider-readiness/v1',
    ok: true,
    tool_id: 'claude-code',
    provider_adapter_id: 'claude-managed-local-v1',
    reason: null,
    hint: null,
  });
  assert.doesNotMatch(
    JSON.stringify({ codex, claude }),
    /must-not-be-returned|opaque-|private/i,
  );
});

test('production readiness refuses before custody when release proof is missing', async () => {
  let custodyOpened = false;
  const codex = await inspectManagedProviderReadiness({
    tool: 'codex',
    deps: {
      inspectRelease: () => ({
        ok: false,
        reason: 'managed-portable-codex-release-untrusted',
      }),
      inspectCustody: () => {
        custodyOpened = true;
        return { ok: true };
      },
    },
  });
  assert.equal(codex.ok, false);
  assert.equal(codex.reason, 'managed-portable-codex-release-untrusted');
  assert.equal(custodyOpened, false);
});
