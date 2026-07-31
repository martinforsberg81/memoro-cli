import assert from 'node:assert/strict';
import test from 'node:test';

import { resolveToolInput } from '../../src/adapters/index.js';
import { buildHandoff } from '../../src/mc/handoff.js';
import {
  deriveHandoffControllerCapability,
  deriveHandoffControllerRoot,
  handoffControllerCapabilityDigest,
} from '../../src/mc/handoff-controller-capability.js';
import {
  commitProviderSwitchDelivery,
  prepareProviderSwitch,
  recoverProviderSwitch,
} from '../../src/mc/provider-switch.js';

const sourceGeneration = '4f50f5a1-4c6b-4d6a-8b5c-152c5e6b8701';
const targetGeneration = '9937ac60-46ce-42dd-9302-6533f1c6c38c';
const serverDigest = 'd'.repeat(64);
const transactionId = '73a85b7e-2ce4-4db0-8b38-16ba08de03bf';
const controllerRoot = deriveHandoffControllerRoot({
  token: 'token-in-memory',
  codingSessionId: 'sess_switch1',
});
const controllerRootDigest = handoffControllerCapabilityDigest(controllerRoot);
const controllerCapability = deriveHandoffControllerCapability({
  root: controllerRoot,
  transactionId,
});
const controllerCapabilityDigest = handoffControllerCapabilityDigest(
  controllerCapability,
);

function sourceEntry() {
  return {
    name: 'handoff',
    tool: 'claude',
    coding_session_id: 'sess_switch1',
    worktree_path: '/repo',
    session_objective: {
      text: 'Build the causal provider switch.',
      authority: 'explicit',
    },
    provider_sessions: {
      schema: 1,
      providers: {
        'claude-code': {
          session_id: 'claude-native-a',
          transcript_path: '/private/transcripts/a.jsonl',
          runtime_generation: sourceGeneration,
          last_consumed_handoff_sequence: 0,
        },
      },
    },
  };
}

function presentTargetArtifact() {
  return {
    kind: 'present',
    artifact: {
      tool: 'codex',
      provider_session_id: 'codex-native-b',
      transcript_path: '/private/transcripts/b.jsonl',
      runtime_generation: targetGeneration,
    },
  };
}

function publicRow(handoff) {
  const { coding_session_id: _codingSessionId, ...projection } = handoff;
  return {
    ...projection,
    digest: serverDigest,
    scanner: {
      version: 'mc-server-handoff-scanner-v1',
      result: 'clean',
      redaction_count: 0,
    },
    created_at: '2026-07-28T12:05:00.000Z',
  };
}

function makeBroker() {
  let journal = null;
  const calls = [];
  const request = async (message) => {
    calls.push(message);
    if (message.type === 'handoff_switch_read') return { ok: true, journal };
    if (message.type === 'handoff_switch_begin') {
      journal = structuredClone(message.journal);
      return { ok: true, journal };
    }
    if (message.type === 'remove_session') return { ok: true, removed: true };
    if (message.type === 'handoff_switch_diagnose') {
      return { ok: true, journal };
    }
    if (message.type === 'handoff_switch_advance') {
      assert.equal(journal.phase, message.expected_phase);
      journal = {
        ...journal,
        ...(message.patch || {}),
        phase: message.next_phase,
        updated_at: message.updated_at,
      };
      return { ok: true, journal };
    }
    throw new Error(`unexpected request ${message.type}`);
  };
  return {
    request,
    calls,
    get journal() { return journal; },
    set journal(value) { journal = value; },
  };
}

test('A to B seals, persists, advances the source cursor, and prepares one user turn', async () => {
  const entry = sourceEntry();
  const broker = makeBroker();
  const cursorCommits = [];
  let hostReady = false;
  let ensured = 0;
  let candidate = null;
  let contextCalls = 0;
  const result = await prepareProviderSwitch({
    entry,
    targetTool: resolveToolInput('codex'),
    localPresence: {
      verdict: 'exited',
      runtime_generation: sourceGeneration,
      session: {
        id: 'sess_switch1',
        tool: 'claude',
        runtime_generation: sourceGeneration,
        source_id: 'device:laptop',
        source_kind: 'local',
        broker_socket_path: '/private/broker.sock',
      },
    },
    deps: {
      requestBroker: async (message, { socketPath } = {}) => {
        if (!hostReady) throw new Error('dead socket');
        assert.equal(socketPath, '/private/hosts/sess_switch1/broker.sock');
        return broker.request(message);
      },
      sessionHostPaths: () => ({
        socketPath: '/private/hosts/sess_switch1/broker.sock',
        handoffSwitchPath: '/private/hosts/sess_switch1/handoff-switch.json',
      }),
      mcHome: () => '/private',
      readHandoffSwitchJournalSync: ({ path, trustedRoot }) => {
        assert.equal(path, '/private/hosts/sess_switch1/handoff-switch.json');
        assert.equal(trustedRoot, '/private');
        return { kind: 'absent' };
      },
      ensureSessionHostRunning: async ({
        sessionId,
        controllerBinding,
        paths,
      }) => {
        assert.equal(sessionId, entry.coding_session_id);
        assert.equal(paths.socketPath, '/private/hosts/sess_switch1/broker.sock');
        assert.deepEqual(controllerBinding, {
          schema: 'mc-broker-controller-bootstrap-v1',
          session_id: entry.coding_session_id,
          session_controller_capability: controllerRoot,
        });
        ensured += 1;
        hostReady = true;
        return { ok: true };
      },
      readProviderArtifact: presentTargetArtifact,
      readConfig: async () => ({ apiUrl: 'https://meetmemoro.test' }),
      getApiUrl: () => null,
      resolveBootstrapIdentity: async () => ({
        token: 'token-in-memory',
        apiUrl: 'https://meetmemoro.test',
      }),
      getRepoContext: async () => ({
        toplevel: '/repo',
        branch: 'sess/handoff',
        remoteUrl: 'git@github.com:martinforsberg81/memoro.git',
      }),
      fetchStrictHandoffContext: async () => {
        contextCalls += 1;
        if (contextCalls === 1) {
          return {
            ok: true,
            continuity: {
              consumedSequence: 0,
              latestSequence: 0,
              latestDigest: null,
            },
            handoffs: [],
          };
        }
        return {
          ok: true,
          continuity: {
            consumedSequence: 0,
            latestSequence: 1,
            latestDigest: serverDigest,
          },
          handoffs: [publicRow(candidate)],
        };
      },
      buildDeterministicHandoff: async (input) => {
        candidate = buildHandoff({
          codingSessionId: entry.coding_session_id,
          sequence: input.sequence,
          parentDigest: input.parentDigest,
          source: input.source,
          workspace: {
            anchor: {
              repoId: 'repo_memoro',
              ref: '1'.repeat(40),
              branch: 'sess/handoff',
            },
            digest: 'c'.repeat(64),
          },
          content: {
            goal: 'Build the causal provider switch.',
            state: 'The source provider ended with a clean workspace.',
          },
        }).handoff;
        return { ok: true, handoff: candidate };
      },
      postHeartbeatWithRetry: async () => true,
      persistSessionHandoff: async ({ handoff }) => {
        assert.deepEqual(handoff, candidate);
        return {
          ok: true,
          sequence: 1,
          digest: serverDigest,
          duplicate: false,
        };
      },
      patchProviderSessionSequenceIfPresent: (name, provider, sequence) => {
        cursorCommits.push({ name, provider, sequence });
        const next = structuredClone(entry);
        next.provider_sessions.providers['claude-code'].last_consumed_handoff_sequence = sequence;
        return { ok: true, entry: next };
      },
      randomUUID: () => '73a85b7e-2ce4-4db0-8b38-16ba08de03bf',
      now: () => '2026-07-28T12:00:00.000Z',
    },
  });

  assert.equal(result.ok, true);
  assert.equal(result.journal.phase, 'target_launch_started');
  assert.equal(result.transaction.target_latest_sequence, 1);
  assert.match(result.message, /ordinary user-level continuity/);
  assert.doesNotMatch(
    result.message,
    /device:laptop|token-in-memory|\/private\/transcripts/,
  );
  assert.deepEqual(cursorCommits, [{
    name: 'handoff',
    provider: 'claude-code',
    sequence: 1,
  }]);
  assert.equal(ensured, 1);
  assert.ok(
    broker.calls.find((call) => call.type === 'remove_session'),
    'source finalization must precede target launch',
  );
});

test('managed source handoff uses terminal archive proof instead of a transcript path', async () => {
  const entry = sourceEntry();
  entry.tool_session_provider_adapter = 'claude-managed-local-v1';
  entry.tool_session_provider_generation = sourceGeneration;
  entry.provider_sessions.providers['claude-code'].transcript_path = null;
  let inspected = 0;

  const result = await prepareProviderSwitch({
    entry,
    targetTool: resolveToolInput('codex'),
    targetCustody: 'managed',
    localPresence: { verdict: 'unknown', session: null },
    deps: {
      inspectManagedProviderHandoffSource: (input) => {
        inspected += 1;
        assert.equal(input.tool, 'claude-code');
        assert.equal(input.providerSessionId, 'claude-native-a');
        assert.equal(input.runtimeGeneration, sourceGeneration);
        return {
          schema: 'mc-managed-provider-handoff-source/v1',
          ok: true,
          tool_id: 'claude-code',
          provider_adapter_id: 'claude-managed-local-v1',
          coding_session_id: entry.coding_session_id,
          provider_session_id: 'claude-native-a',
          runtime_generation: sourceGeneration,
          archive_digest: 'a'.repeat(64),
          reason: null,
        };
      },
      mcHome: () => '/private/mc',
      brokerRequest: async () => ({ ok: true, journal: null }),
      readConfig: async () => ({ apiUrl: 'https://meetmemoro.test' }),
      getApiUrl: () => null,
      resolveBootstrapIdentity: async () => ({ token: 'token-in-memory' }),
      getRepoContext: async () => ({
        toplevel: '/repo',
        branch: 'sess/handoff',
        remoteUrl: 'git@github.com:martinforsberg81/memoro.git',
      }),
    },
  });

  assert.equal(inspected, 1);
  assert.deepEqual(result, {
    ok: false,
    code: 'handoff-source-runtime-unconfirmed',
  });
});

test('delivery commits only the target cursor after broker acknowledgement', async () => {
  const entry = sourceEntry();
  let registryEntry = entry;
  entry.provider_sessions.providers['claude-code'].last_consumed_handoff_sequence = 1;
  const broker = makeBroker();
  broker.journal = {
    transaction_id: '73a85b7e-2ce4-4db0-8b38-16ba08de03bf',
    phase: 'delivery_acknowledged',
    target_tool: 'codex',
    controller_root_digest: controllerRootDigest,
    controller_capability_digest: controllerCapabilityDigest,
    target_latest_sequence: 2,
    target_runtime_generation: targetGeneration,
  };
  const commits = [];

  const result = await commitProviderSwitchDelivery({
    entry,
    targetTool: resolveToolInput('codex'),
    sessionControllerCapability: controllerRoot,
    transaction: {
      transaction_id: broker.journal.transaction_id,
      target_tool: 'codex',
      controller_capability: controllerCapability,
      target_latest_sequence: 2,
      require_target_artifact: true,
    },
    deps: {
      brokerRequest: broker.request,
      readProviderArtifact: presentTargetArtifact,
      patchProviderSessionSequenceIfPresent: (name, provider, sequence) => {
        commits.push({ name, provider, sequence });
        const next = structuredClone(entry);
        next.provider_sessions.providers.codex = {
          session_id: null,
          transcript_path: null,
          runtime_generation: null,
          last_consumed_handoff_sequence: sequence,
        };
        registryEntry = next;
        return { ok: true, entry: next };
      },
      upsertEntry: (patch) => {
        registryEntry = { ...registryEntry, ...patch };
        return registryEntry;
      },
      now: () => '2026-07-28T12:10:00.000Z',
    },
  });

  assert.equal(result.ok, true);
  assert.equal(result.journal.phase, 'complete');
  assert.deepEqual(commits, [{ name: 'handoff', provider: 'codex', sequence: 2 }]);
  assert.equal(
    result.entry.provider_sessions.providers['claude-code'].last_consumed_handoff_sequence,
    1,
  );
  assert.equal(
    result.entry.provider_sessions.providers.codex.last_consumed_handoff_sequence,
    2,
  );
});

test('managed delivery never projects the private target transcript path', async () => {
  const entry = sourceEntry();
  entry.provider_sessions.providers['claude-code'].transcript_path = null;
  entry.provider_sessions.providers['claude-code'].last_consumed_handoff_sequence = 1;
  const broker = makeBroker();
  broker.journal = {
    transaction_id: transactionId,
    phase: 'delivery_acknowledged',
    target_tool: 'codex',
    target_custody: 'managed',
    controller_root_digest: controllerRootDigest,
    controller_capability_digest: controllerCapabilityDigest,
    target_latest_sequence: 1,
    target_runtime_generation: targetGeneration,
  };
  let current = entry;
  const transaction = {
    transaction_id: transactionId,
    target_tool: 'codex',
    target_custody: 'managed',
    controller_capability: controllerCapability,
    target_latest_sequence: 1,
    require_target_artifact: true,
  };
  const deps = {
    brokerRequest: broker.request,
    readProviderArtifact: presentTargetArtifact,
    patchProviderSessionSequenceIfPresent: (_name, provider, sequence) => {
      const next = structuredClone(current);
      next.provider_sessions.providers[provider] = {
        session_id: null,
        transcript_path: null,
        runtime_generation: null,
        last_consumed_handoff_sequence: sequence,
      };
      current = next;
      return { ok: true, entry: next };
    },
    upsertEntry: (patch) => {
      current = { ...current, ...patch };
      return current;
    },
    now: () => '2026-07-28T12:10:00.000Z',
  };

  const result = await commitProviderSwitchDelivery({
    entry,
    targetTool: resolveToolInput('codex'),
    targetCustody: 'managed',
    sessionControllerCapability: controllerRoot,
    transaction,
    deps,
  });
  assert.equal(result.ok, true);
  assert.deepEqual(result.entry.provider_sessions.providers.codex, {
    session_id: 'codex-native-b',
    transcript_path: null,
    runtime_generation: targetGeneration,
    last_consumed_handoff_sequence: 1,
  });
  assert.doesNotMatch(JSON.stringify(result.entry), /\/private\/transcripts/u);

  const mismatch = await commitProviderSwitchDelivery({
    entry,
    targetTool: resolveToolInput('codex'),
    targetCustody: 'native',
    sessionControllerCapability: controllerRoot,
    transaction,
    deps,
  });
  assert.deepEqual(mismatch, {
    ok: false,
    code: 'handoff-delivery-commit-input-invalid',
  });
});

test('delivery recovery finishes a registry switch after the durable cursor commit', async () => {
  const entry = sourceEntry();
  entry.provider_sessions.providers['claude-code'].last_consumed_handoff_sequence = 1;
  const broker = makeBroker();
  broker.journal = {
    transaction_id: '73a85b7e-2ce4-4db0-8b38-16ba08de03bf',
    phase: 'delivery_acknowledged',
    target_tool: 'codex',
    controller_root_digest: controllerRootDigest,
    controller_capability_digest: controllerCapabilityDigest,
    target_latest_sequence: 1,
    target_runtime_generation: targetGeneration,
  };
  let failRegistrySwitch = true;
  let current = entry;
  const deps = {
    brokerRequest: broker.request,
    readProviderArtifact: presentTargetArtifact,
    patchProviderSessionSequenceIfPresent: (_name, _provider, sequence) => {
      current = structuredClone(current);
      current.provider_sessions.providers.codex = {
        session_id: 'codex-native-b',
        transcript_path: '/private/transcripts/b.jsonl',
        runtime_generation: targetGeneration,
        last_consumed_handoff_sequence: sequence,
      };
      return { ok: true, entry: current };
    },
    upsertEntry: (patch) => {
      if (failRegistrySwitch) throw new Error('injected crash boundary');
      current = { ...current, ...patch };
      return current;
    },
    now: () => '2026-07-28T12:10:00.000Z',
  };
  const transaction = {
    transaction_id: broker.journal.transaction_id,
    target_tool: 'codex',
    controller_capability: controllerCapability,
    target_latest_sequence: 1,
    require_target_artifact: true,
  };

  const interrupted = await commitProviderSwitchDelivery({
    entry,
    targetTool: resolveToolInput('codex'),
    sessionControllerCapability: controllerRoot,
    transaction,
    deps,
  });
  assert.equal(interrupted.ok, false);
  assert.equal(interrupted.code, 'handoff-tool-switch-commit-failed');
  assert.equal(broker.journal.phase, 'consumed_committed');

  failRegistrySwitch = false;
  const recovered = await commitProviderSwitchDelivery({
    entry: current,
    targetTool: resolveToolInput('codex'),
    sessionControllerCapability: controllerRoot,
    transaction,
    deps,
  });
  assert.equal(recovered.ok, true);
  assert.equal(recovered.entry.tool, 'codex');
  assert.equal(recovered.journal.phase, 'complete');
});

test('delivery commit rejects a caller sequence that differs from the journal', async () => {
  const entry = sourceEntry();
  const broker = makeBroker();
  broker.journal = {
    transaction_id: '73a85b7e-2ce4-4db0-8b38-16ba08de03bf',
    phase: 'delivery_acknowledged',
    target_tool: 'codex',
    controller_root_digest: controllerRootDigest,
    controller_capability_digest: controllerCapabilityDigest,
    target_latest_sequence: 2,
    target_runtime_generation: targetGeneration,
  };
  let mutated = false;
  const result = await commitProviderSwitchDelivery({
    entry,
    targetTool: resolveToolInput('codex'),
    sessionControllerCapability: controllerRoot,
    transaction: {
      transaction_id: broker.journal.transaction_id,
      target_tool: 'codex',
      controller_capability: controllerCapability,
      target_latest_sequence: 1,
      require_target_artifact: true,
    },
    deps: {
      brokerRequest: broker.request,
      patchProviderSessionSequenceIfPresent: () => {
        mutated = true;
        return { ok: true, entry };
      },
    },
  });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'handoff-delivery-proof-unavailable');
  assert.equal(mutated, false);
});

test('recovery finds a delivered switch even when the registry already names the target', async () => {
  const entry = sourceEntry();
  entry.tool = 'codex';
  entry.provider_sessions.providers['claude-code'].last_consumed_handoff_sequence = 1;
  entry.provider_sessions.providers.codex = {
    session_id: 'codex-native-b',
    transcript_path: '/private/transcripts/b.jsonl',
    runtime_generation: targetGeneration,
    last_consumed_handoff_sequence: 1,
  };
  const broker = makeBroker();
  broker.journal = {
    coding_session_id: entry.coding_session_id,
    transaction_id: '73a85b7e-2ce4-4db0-8b38-16ba08de03bf',
    phase: 'delivery_acknowledged',
    target_tool: 'codex',
    controller_root_digest: controllerRootDigest,
    controller_capability_digest: controllerCapabilityDigest,
    source_cursor: 0,
    target_cursor: 0,
    handoff: {
      source: {
        kind: 'local',
        id: 'device:laptop',
        tool: 'claude-code',
        runtime_generation: sourceGeneration,
      },
    },
    persisted: { sequence: 1, digest: serverDigest },
    target_latest_sequence: 1,
    target_runtime_generation: targetGeneration,
  };
  const result = await recoverProviderSwitch({
    entry,
    deps: {
      brokerRequest: broker.request,
      readConfig: async () => ({ apiUrl: 'https://meetmemoro.test' }),
      getApiUrl: () => null,
      resolveBootstrapIdentity: async () => ({
        token: 'token-in-memory',
        apiUrl: 'https://meetmemoro.test',
      }),
    },
  });
  assert.equal(result.ok, true);
  assert.equal(result.active, true);
  assert.equal(result.recoveredDelivery, true);
  assert.equal(result.targetTool.id, 'codex');
});

test('recovery of an exited delivered target requires its exact provider artifact', async () => {
  const entry = sourceEntry();
  const broker = makeBroker();
  broker.journal = {
    coding_session_id: entry.coding_session_id,
    transaction_id: '73a85b7e-2ce4-4db0-8b38-16ba08de03bf',
    phase: 'delivery_acknowledged',
    target_tool: 'codex',
    controller_root_digest: controllerRootDigest,
    controller_capability_digest: controllerCapabilityDigest,
    source_cursor: 0,
    target_cursor: 0,
    handoff: {
      source: {
        kind: 'local',
        id: 'device:laptop',
        tool: 'claude-code',
        runtime_generation: sourceGeneration,
      },
    },
    persisted: { sequence: 1, digest: serverDigest },
    target_latest_sequence: 1,
    target_runtime_generation: targetGeneration,
  };

  const result = await recoverProviderSwitch({
    entry,
    localPresence: {
      verdict: 'exited',
      runtime_generation: targetGeneration,
      session: null,
    },
    deps: {
      brokerRequest: broker.request,
      readConfig: async () => ({ apiUrl: 'https://meetmemoro.test' }),
      getApiUrl: () => null,
      resolveBootstrapIdentity: async () => ({
        token: 'token-in-memory',
        apiUrl: 'https://meetmemoro.test',
      }),
    },
  });

  assert.equal(result.ok, true);
  assert.equal(result.recoveredDelivery, true);
  assert.equal(result.transaction.target_tool, 'codex');
  assert.equal(result.transaction.require_target_artifact, true);
});

test('plain recovery restarts a dead session host from its trusted local journal', async () => {
  const entry = sourceEntry();
  const journal = {
    coding_session_id: entry.coding_session_id,
    transaction_id: '73a85b7e-2ce4-4db0-8b38-16ba08de03bf',
    phase: 'delivery_acknowledged',
    target_tool: 'codex',
    controller_root_digest: controllerRootDigest,
    controller_capability_digest: controllerCapabilityDigest,
    source_cursor: 0,
    target_cursor: 0,
    handoff: {
      source: {
        kind: 'local',
        id: 'device:laptop',
        tool: 'claude-code',
        runtime_generation: sourceGeneration,
      },
    },
    persisted: { sequence: 1, digest: serverDigest },
    target_latest_sequence: 1,
    target_runtime_generation: targetGeneration,
  };
  let hostReady = false;
  let ensured = 0;
  const result = await recoverProviderSwitch({
    entry,
    localPresence: {
      verdict: 'exited',
      runtime_generation: targetGeneration,
      session: null,
    },
    deps: {
      requestBroker: async (message, { socketPath } = {}) => {
        assert.equal(socketPath, '/private/hosts/sess_switch1/broker.sock');
        if (!hostReady) throw new Error('dead socket');
        assert.equal(message.type, 'handoff_switch_read');
        return { ok: true, journal };
      },
      sessionHostPaths: () => ({
        socketPath: '/private/hosts/sess_switch1/broker.sock',
        handoffSwitchPath: '/private/hosts/sess_switch1/handoff-switch.json',
      }),
      mcHome: () => '/private',
      readHandoffSwitchJournalSync: ({ path, trustedRoot }) => {
        assert.equal(path, '/private/hosts/sess_switch1/handoff-switch.json');
        assert.equal(trustedRoot, '/private');
        return { kind: 'present', journal };
      },
      ensureSessionHostRunning: async ({
        sessionId,
        controllerBinding,
        paths,
      }) => {
        assert.equal(sessionId, entry.coding_session_id);
        assert.equal(paths.socketPath, '/private/hosts/sess_switch1/broker.sock');
        assert.deepEqual(controllerBinding, {
          schema: 'mc-broker-controller-bootstrap-v1',
          session_id: entry.coding_session_id,
          session_controller_capability: controllerRoot,
        });
        ensured += 1;
        hostReady = true;
        return { ok: true };
      },
      readConfig: async () => ({ apiUrl: 'https://meetmemoro.test' }),
      getApiUrl: () => null,
      resolveBootstrapIdentity: async () => ({
        token: 'token-in-memory',
        apiUrl: 'https://meetmemoro.test',
      }),
    },
  });

  assert.equal(result.ok, true);
  assert.equal(result.recoveredDelivery, true);
  assert.equal(result.transaction.require_target_artifact, true);
  assert.equal(ensured, 1);
});

test('missing local journal fails closed when server continuity proves a persisted handoff', async () => {
  const entry = sourceEntry();
  const result = await recoverProviderSwitch({
    entry,
    localPresence: {
      verdict: 'exited',
      runtime_generation: sourceGeneration,
      session: null,
    },
    deps: {
      requestBroker: async () => {
        throw new Error('dead socket');
      },
      sessionHostPaths: () => ({
        socketPath: '/private/hosts/sess_switch1/broker.sock',
        handoffSwitchPath: '/private/hosts/sess_switch1/handoff-switch.json',
      }),
      mcHome: () => '/private',
      readHandoffSwitchJournalSync: () => ({ kind: 'absent' }),
      readConfig: async () => ({ apiUrl: 'https://meetmemoro.test' }),
      getApiUrl: () => null,
      resolveBootstrapIdentity: async () => ({
        token: 'token-in-memory',
        apiUrl: 'https://meetmemoro.test',
      }),
      getRepoContext: async () => ({
        remoteUrl: 'git@example.com:org/repo.git',
        branch: 'main',
        toplevel: '/repo',
      }),
      fetchStrictHandoffContext: async () => ({
        ok: true,
        continuity: {
          consumedSequence: 0,
          latestSequence: 1,
          latestDigest: serverDigest,
        },
        handoffs: [{ sequence: 1 }],
      }),
    },
  });

  assert.deepEqual(result, {
    ok: false,
    code: 'handoff-switch-journal-integrity-lost',
  });
});

test('same-provider recovery permits a pre-capability server but a switch does not', async () => {
  const entry = sourceEntry();
  const deps = {
    requestBroker: async () => {
      throw new Error('dead socket');
    },
    sessionHostPaths: () => ({
      socketPath: '/private/hosts/sess_switch1/broker.sock',
      handoffSwitchPath: '/private/hosts/sess_switch1/handoff-switch.json',
    }),
    mcHome: () => '/private',
    readHandoffSwitchJournalSync: () => ({ kind: 'absent' }),
    readConfig: async () => ({ apiUrl: 'https://meetmemoro.test' }),
    getApiUrl: () => null,
    resolveBootstrapIdentity: async () => ({
      token: 'token-in-memory',
      apiUrl: 'https://meetmemoro.test',
    }),
    getRepoContext: async () => ({
      remoteUrl: 'git@example.com:org/repo.git',
      branch: 'main',
      toplevel: '/repo',
    }),
    fetchStrictHandoffContext: async () => ({
      ok: false,
      code: 'handoff-capability-unavailable',
    }),
  };
  const localPresence = {
    verdict: 'exited',
    runtime_generation: sourceGeneration,
    session: null,
  };

  assert.deepEqual(await recoverProviderSwitch({
    entry,
    targetTool: resolveToolInput('claude'),
    localPresence,
    deps,
  }), {
    ok: true,
    active: false,
    handoffCapability: 'unavailable',
  });

  assert.deepEqual(await recoverProviderSwitch({
    entry,
    targetTool: null,
    localPresence,
    deps,
  }), {
    ok: true,
    active: false,
    handoffCapability: 'unavailable',
  });

  assert.deepEqual(await recoverProviderSwitch({
    entry,
    targetTool: resolveToolInput('codex'),
    localPresence,
    deps,
  }), {
    ok: false,
    code: 'handoff-capability-unavailable',
  });
});

test('missing journal fails closed when the source cursor proves consumed handoff history', async () => {
  const entry = sourceEntry();
  entry.provider_sessions.providers['claude-code'].last_consumed_handoff_sequence = 1;
  const broker = makeBroker();
  let serverAuditCalled = false;

  const result = await prepareProviderSwitch({
    entry,
    targetTool: resolveToolInput('codex'),
    localPresence: {
      verdict: 'exited',
      runtime_generation: sourceGeneration,
      session: {
        id: entry.coding_session_id,
        tool: 'claude',
        runtime_generation: sourceGeneration,
        source_id: 'device:laptop',
        source_kind: 'local',
      },
    },
    deps: {
      brokerRequest: broker.request,
      readConfig: async () => ({ apiUrl: 'https://meetmemoro.test' }),
      getApiUrl: () => null,
      resolveBootstrapIdentity: async () => ({
        token: 'token-in-memory',
        apiUrl: 'https://meetmemoro.test',
      }),
      fetchStrictHandoffContext: async () => {
        serverAuditCalled = true;
        return {
          ok: true,
          continuity: {
            consumedSequence: 1,
            latestSequence: 1,
            latestDigest: serverDigest,
          },
          handoffs: [],
        };
      },
    },
  });

  assert.deepEqual(result, {
    ok: false,
    code: 'handoff-switch-journal-integrity-lost',
  });
  assert.equal(serverAuditCalled, false);
  assert.equal(
    broker.calls.some((call) => call.type === 'handoff_switch_begin'),
    false,
  );
});

test('delivery recovery binds the exact target artifact before completing the switch', async () => {
  const entry = sourceEntry();
  const broker = makeBroker();
  broker.journal = {
    transaction_id: '73a85b7e-2ce4-4db0-8b38-16ba08de03bf',
    phase: 'delivery_acknowledged',
    target_tool: 'codex',
    controller_root_digest: controllerRootDigest,
    controller_capability_digest: controllerCapabilityDigest,
    target_latest_sequence: 1,
    target_runtime_generation: targetGeneration,
  };
  let current = entry;
  const result = await commitProviderSwitchDelivery({
    entry,
    targetTool: resolveToolInput('codex'),
    sessionControllerCapability: controllerRoot,
    transaction: {
      transaction_id: broker.journal.transaction_id,
      target_tool: 'codex',
      controller_capability: controllerCapability,
      target_latest_sequence: 1,
      require_target_artifact: true,
    },
    deps: {
      brokerRequest: broker.request,
      readProviderArtifact: ({ codingSessionId, runtimeGeneration }) => {
        assert.equal(codingSessionId, entry.coding_session_id);
        assert.equal(runtimeGeneration, targetGeneration);
        return {
          kind: 'present',
          artifact: {
            tool: 'codex',
            provider_session_id: 'codex-native-b',
            transcript_path: '/private/transcripts/b.jsonl',
            runtime_generation: targetGeneration,
          },
        };
      },
      patchProviderSessionSequenceIfPresent: (_name, provider, sequence) => {
        const next = structuredClone(current);
        next.provider_sessions.providers[provider] = {
          session_id: null,
          transcript_path: null,
          runtime_generation: null,
          last_consumed_handoff_sequence: sequence,
        };
        current = next;
        return { ok: true, entry: next };
      },
      upsertEntry: (patch) => {
        current = { ...current, ...patch };
        return current;
      },
      now: () => '2026-07-28T12:10:00.000Z',
    },
  });

  assert.equal(result.ok, true);
  assert.equal(result.journal.phase, 'complete');
  assert.deepEqual(result.entry.provider_sessions.providers.codex, {
    session_id: 'codex-native-b',
    transcript_path: '/private/transcripts/b.jsonl',
    runtime_generation: targetGeneration,
    last_consumed_handoff_sequence: 1,
  });
});

test('delivery recovery does not mutate the cursor without a required target artifact', async () => {
  const entry = sourceEntry();
  const broker = makeBroker();
  broker.journal = {
    transaction_id: '73a85b7e-2ce4-4db0-8b38-16ba08de03bf',
    phase: 'delivery_acknowledged',
    target_tool: 'codex',
    controller_root_digest: controllerRootDigest,
    controller_capability_digest: controllerCapabilityDigest,
    target_latest_sequence: 1,
    target_runtime_generation: targetGeneration,
  };
  let mutated = false;
  const result = await commitProviderSwitchDelivery({
    entry,
    targetTool: resolveToolInput('codex'),
    sessionControllerCapability: controllerRoot,
    transaction: {
      transaction_id: broker.journal.transaction_id,
      target_tool: 'codex',
      controller_capability: controllerCapability,
      target_latest_sequence: 1,
      require_target_artifact: true,
    },
    deps: {
      brokerRequest: broker.request,
      readProviderArtifact: () => ({ kind: 'absent' }),
      patchProviderSessionSequenceIfPresent: () => {
        mutated = true;
        return { ok: true, entry };
      },
    },
  });

  assert.deepEqual(result, { ok: false, code: 'handoff-target-artifact-unconfirmed' });
  assert.equal(mutated, false);
});

test('an interrupted target write remains explicit and is never replayed automatically', async () => {
  const entry = sourceEntry();
  const broker = makeBroker();
  broker.journal = {
    schema: 'mc-handoff-switch-journal-v1',
    transaction_id: '73a85b7e-2ce4-4db0-8b38-16ba08de03bf',
    coding_session_id: entry.coding_session_id,
    phase: 'target_launch_started',
    target_tool: 'codex',
    controller_root_digest: controllerRootDigest,
    controller_capability_digest: controllerCapabilityDigest,
    source_cursor: 0,
    target_cursor: 0,
    handoff: {
      source: {
        tool: 'claude-code',
        id: 'device:laptop',
        runtime_generation: sourceGeneration,
      },
    },
    persisted: { sequence: 1, digest: serverDigest },
    target_latest_sequence: 1,
    target_runtime_generation: targetGeneration,
  };
  const result = await prepareProviderSwitch({
    entry,
    targetTool: resolveToolInput('codex'),
    localPresence: {
      verdict: 'exited',
      runtime_generation: sourceGeneration,
      session: null,
    },
    deps: {
      brokerRequest: broker.request,
      readConfig: async () => ({ apiUrl: 'https://meetmemoro.test' }),
      getApiUrl: () => null,
      resolveBootstrapIdentity: async () => ({
        token: 'token-in-memory',
        apiUrl: 'https://meetmemoro.test',
      }),
      getRepoContext: async () => ({
        toplevel: '/repo',
        branch: 'sess/handoff',
        remoteUrl: 'git@github.com:martinforsberg81/memoro.git',
      }),
    },
  });
  assert.deepEqual(result, { ok: false, code: 'handoff-delivery-ambiguous' });
  assert.equal(
    broker.calls.find((call) => call.type === 'handoff_switch_diagnose')?.code,
    'handoff-delivery-ambiguous',
  );
});

test('a live exact target stays fail-closed while broker delivery is still in progress', async () => {
  const entry = sourceEntry();
  const broker = makeBroker();
  broker.journal = {
    transaction_id: '73a85b7e-2ce4-4db0-8b38-16ba08de03bf',
    coding_session_id: entry.coding_session_id,
    phase: 'target_launch_started',
    target_tool: 'codex',
    controller_root_digest: controllerRootDigest,
    controller_capability_digest: controllerCapabilityDigest,
    source_cursor: 0,
    target_cursor: 0,
    handoff: {
      source: {
        kind: 'local',
        tool: 'claude-code',
        id: 'device:laptop',
        runtime_generation: sourceGeneration,
      },
    },
    persisted: { sequence: 1, digest: serverDigest },
    target_latest_sequence: 1,
    target_runtime_generation: targetGeneration,
  };
  const result = await recoverProviderSwitch({
    entry,
    targetTool: resolveToolInput('codex'),
    localPresence: {
      verdict: 'live',
      runtime_generation: targetGeneration,
      session: {
        id: entry.coding_session_id,
        tool: 'codex',
        runtime_generation: targetGeneration,
      },
    },
    deps: {
      brokerRequest: broker.request,
      readConfig: async () => ({ apiUrl: 'https://meetmemoro.test' }),
      getApiUrl: () => null,
      resolveBootstrapIdentity: async () => ({
        token: 'token-in-memory',
        apiUrl: 'https://meetmemoro.test',
      }),
      getRepoContext: async () => ({
        toplevel: '/repo',
        branch: 'sess/handoff',
        remoteUrl: 'git@github.com:martinforsberg81/memoro.git',
      }),
    },
  });
  assert.deepEqual(result, { ok: false, code: 'handoff-delivery-in-progress' });
  assert.equal(
    broker.calls.find((call) => call.type === 'handoff_switch_diagnose')?.code,
    'handoff-delivery-in-progress',
  );
});

test('Claude A to Codex B to Claude A to Codex B reuses native IDs and delivers only new handoffs', async () => {
  let current = sourceEntry();
  const chain = [];
  const broker = makeBroker();
  const nativeIds = {
    'claude-code': 'claude-native-a',
    codex: 'codex-native-b',
  };
  const generations = {
    'claude-code': sourceGeneration,
    codex: targetGeneration,
  };

  const switchOnce = async (targetName) => {
    const sourceTool = resolveToolInput(current.tool).id;
    const targetTool = resolveToolInput(targetName);
    const targetBefore = current.provider_sessions.providers[targetTool.id] || null;
    const consumedByTarget = [];
    const patchCursor = (_name, provider, sequence) => {
      const next = structuredClone(current);
      next.provider_sessions.providers[provider] ||= {
        session_id: null,
        transcript_path: null,
        runtime_generation: null,
        last_consumed_handoff_sequence: 0,
      };
      next.provider_sessions.providers[provider].last_consumed_handoff_sequence = sequence;
      current = next;
      return { ok: true, entry: next };
    };
    const fetchContext = async ({ consumedSequence }) => {
      const rows = chain.filter((item) => item.sequence > consumedSequence);
      return {
        ok: true,
        continuity: {
          consumedSequence,
          latestSequence: chain.length,
          latestDigest: chain.at(-1)?.digest || null,
        },
        handoffs: rows,
      };
    };
    const prepared = await prepareProviderSwitch({
      entry: current,
      targetTool,
      localPresence: {
        verdict: 'exited',
        runtime_generation: generations[sourceTool],
        session: {
          id: current.coding_session_id,
          tool: sourceTool,
          runtime_generation: generations[sourceTool],
          source_id: 'device:laptop',
          source_kind: 'local',
        },
      },
      deps: {
        brokerRequest: broker.request,
        readConfig: async () => ({ apiUrl: 'https://meetmemoro.test' }),
        getApiUrl: () => null,
        resolveBootstrapIdentity: async () => ({
          token: 'token-in-memory',
          apiUrl: 'https://meetmemoro.test',
        }),
        getRepoContext: async () => ({
          toplevel: '/repo',
          branch: 'sess/handoff',
          remoteUrl: 'git@github.com:martinforsberg81/memoro.git',
        }),
        fetchStrictHandoffContext: fetchContext,
        buildDeterministicHandoff: async (input) => buildHandoff({
          codingSessionId: current.coding_session_id,
          sequence: input.sequence,
          parentDigest: input.parentDigest,
          source: input.source,
          workspace: {
            anchor: {
              repoId: 'repo_memoro',
              ref: '1'.repeat(40),
              branch: 'sess/handoff',
            },
            digest: 'c'.repeat(64),
          },
          content: {
            goal: 'Build the causal provider switch.',
            state: `Safe handoff ${input.sequence}.`,
          },
        }),
        postHeartbeatWithRetry: async () => true,
        persistSessionHandoff: async ({ handoff }) => {
          const sequence = handoff.sequence;
          const rowDigest = String(sequence).repeat(64);
          const { coding_session_id: _codingSessionId, ...projection } = handoff;
          chain.push({
            ...projection,
            digest: rowDigest,
            scanner: {
              version: 'mc-server-handoff-scanner-v1',
              result: 'clean',
              redaction_count: 0,
            },
            created_at: `2026-07-28T12:0${sequence}:00.000Z`,
          });
          return { ok: true, sequence, digest: rowDigest, duplicate: false };
        },
        patchProviderSessionSequenceIfPresent: patchCursor,
        randomUUID: () => '73a85b7e-2ce4-4db0-8b38-16ba08de03bf',
        now: () => '2026-07-28T12:00:00.000Z',
      },
    });
    assert.equal(prepared.ok, true);
    for (const match of prepared.message.matchAll(/Handoff (\d+)/g)) {
      consumedByTarget.push(Number(match[1]));
    }

    broker.journal = {
      ...broker.journal,
      phase: 'delivery_acknowledged',
      target_runtime_generation: generations[targetTool.id],
    };
    const committed = await commitProviderSwitchDelivery({
      entry: current,
      targetTool,
      sessionControllerCapability: controllerRoot,
      transaction: prepared.transaction,
      deps: {
        brokerRequest: broker.request,
        readProviderArtifact: () => ({
          kind: 'present',
          artifact: {
            tool: targetTool.id,
            provider_session_id: nativeIds[targetTool.id],
            transcript_path: `/private/transcripts/${targetTool.id}.jsonl`,
            runtime_generation: generations[targetTool.id],
          },
        }),
        patchProviderSessionSequenceIfPresent: patchCursor,
        upsertEntry: (patch) => {
          current = { ...current, ...patch };
          return current;
        },
        now: () => '2026-07-28T12:10:00.000Z',
      },
    });
    assert.equal(committed.ok, true);
    current = committed.entry;
    current.provider_sessions.providers[targetTool.id] = {
      ...current.provider_sessions.providers[targetTool.id],
      session_id: nativeIds[targetTool.id],
      transcript_path: `/private/transcripts/${targetTool.id}.jsonl`,
      runtime_generation: generations[targetTool.id],
    };
    return {
      consumedByTarget,
      targetNativeIdBefore: targetBefore?.session_id || null,
      targetNativeIdAfter: current.provider_sessions.providers[targetTool.id].session_id,
    };
  };

  const first = await switchOnce('codex');
  const second = await switchOnce('claude');
  const third = await switchOnce('codex');

  assert.deepEqual(first.consumedByTarget, [1]);
  assert.deepEqual(second.consumedByTarget, [2]);
  assert.deepEqual(third.consumedByTarget, [3]);
  assert.equal(first.targetNativeIdBefore, null);
  assert.equal(first.targetNativeIdAfter, 'codex-native-b');
  assert.equal(second.targetNativeIdBefore, 'claude-native-a');
  assert.equal(second.targetNativeIdAfter, 'claude-native-a');
  assert.equal(third.targetNativeIdBefore, 'codex-native-b');
  assert.equal(third.targetNativeIdAfter, 'codex-native-b');
  assert.equal(
    current.provider_sessions.providers['claude-code'].last_consumed_handoff_sequence,
    3,
  );
  assert.equal(
    current.provider_sessions.providers.codex.last_consumed_handoff_sequence,
    3,
  );
});
