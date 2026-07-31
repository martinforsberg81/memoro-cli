import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  applyManagedCodexRecovery,
  importLegacyNativeCodexSession,
  importInspectedManagedCodexRecovery,
  inspectManagedCodexRecovery,
  publicManagedCodexRecovery,
  recoverUnjournaledManagedCodexResumeDomain,
} from '../../src/mc/managed-codex-recovery.js';
import { MANAGED_CODEX_PROVIDER_ID } from '../../src/mc/provider-adapters/codex-managed.js';
import { inspectManagedGenerationSync } from '../../src/mc/managed-generation-journal.js';

const ENTRY = Object.freeze({
  name: 'recover-me',
  tool: 'codex',
  coding_session_id: 'sess_recover',
  worktree_path: '/private/worktree',
  session_state: 'live',
  tool_session_id: 'cx_old',
  tool_session_source: 'codex',
  tool_transcript_path: '/private/old.jsonl',
  provider_sessions: {
    schema: 1,
    providers: {
      codex: {
        session_id: 'cx_old',
        transcript_path: '/private/old.jsonl',
        runtime_generation: null,
        last_consumed_handoff_sequence: 0,
      },
    },
  },
});

const RUNTIME_GENERATION = '11111111-1111-4111-8111-111111111111';
const DOMAIN_GENERATION = '22222222-2222-4222-8222-222222222222';
const PROVIDER_GENERATION = '33333333-3333-4333-8333-333333333333';
const MANIFEST_DIGEST = 'a'.repeat(64);
const TRANSACTION = Object.freeze({
  schema: 'mc-managed-generation-transaction',
  version: 1,
  sequence: 1,
  coding_session_id: ENTRY.coding_session_id,
  runtime_generation: RUNTIME_GENERATION,
  intent_digest: 'b'.repeat(64),
});
const ARTIFACT = Object.freeze({
  schema: 'mc-provider-artifact-v1',
  coding_session_id: ENTRY.coding_session_id,
  runtime_generation: RUNTIME_GENERATION,
  tool: 'codex',
  provider_session_id: '019fade7-639a-7a33-a5d8-7e49d575022a',
  transcript_path: '/private/domain/home/.codex/sessions/rollout.jsonl',
  captured_at: '2026-07-29T12:44:13.029Z',
});

function inspectionDeps(overrides = {}) {
  return {
    sessionHostPaths: () => ({
      dir: '/private/host',
      lifecyclePath: '/private/host/lifecycle.json',
    }),
    providerArtifactPath: () => '/private/host/provider-artifact.json',
    readSessionLifecycle: async () => ({
      verdict: 'exited',
      record: {
        state: 'exited',
        runtime_generation: RUNTIME_GENERATION,
        observed_at: '2026-07-29T15:28:06.777Z',
      },
    }),
    readProviderArtifact: () => ({ kind: 'present', artifact: ARTIFACT }),
    inspectCredentialDomain: () => ({
      ok: true,
      descriptor: {
        session_id: ENTRY.coding_session_id,
        generation: DOMAIN_GENERATION,
        manifest_sha256: MANIFEST_DIGEST,
        fixed_secret_id: 'opaque',
      },
    }),
    scanRuntimeSidecars: async () => ({
      zombie_hosts: [],
    }),
    ...overrides,
  };
}

describe('managed Codex recovery', () => {
  test('imports an existing native provider id before the first managed generation', () => {
    const providerSessionId = '019f383d-d5c4-7e90-826e-32ea7b396bd2';
    const artifacts = [
      {
        ...ARTIFACT,
        runtime_generation: '44444444-4444-4444-8444-444444444444',
        provider_session_id: providerSessionId,
        transcript_path: '/user/.codex/sessions/older.jsonl',
        captured_at: '2026-07-29T14:05:00.552Z',
      },
      {
        ...ARTIFACT,
        runtime_generation: '55555555-5555-4555-8555-555555555555',
        provider_session_id: providerSessionId,
        transcript_path: '/user/.codex/sessions/latest.jsonl',
        captured_at: '2026-07-30T11:01:21.615Z',
      },
    ];
    let archived = null;
    const imported = importLegacyNativeCodexSession({
      entry: {
        ...ENTRY,
        tool_session_id: providerSessionId,
        tool_session_source: 'codex',
      },
      root: '/private/mc',
      deps: {
        inspectManagedSession: () => ({
          kind: 'absent',
          generations: [],
          active: null,
        }),
        listProviderArtifacts: () => ({ ok: true, artifacts }),
        sessionsDir: '/user/.codex/sessions',
        validateProviderArtifact: ({ evidence }) => ({
          ok: true,
          transcriptPath: evidence.transcriptPath,
        }),
        persistManagedSessionState: (input) => {
          archived = input;
          return { ok: true, state: { archive_digest: 'c'.repeat(64) } };
        },
      },
    });

    assert.equal(imported.ok, true);
    assert.equal(imported.repaired_cutover, false);
    assert.equal(imported.provider_session_id, providerSessionId);
    assert.equal(
      imported.runtime_generation,
      '55555555-5555-4555-8555-555555555555',
    );
    assert.equal(archived.descriptor.session_id, ENTRY.coding_session_id);
    assert.equal(archived.descriptor.codex_home, '/user/.codex');
    assert.equal(archived.providerArtifact.transcript_path, artifacts[1].transcript_path);
  });

  test('discovers the exact native transcript when no host artifact exists', () => {
    const providerSessionId = '019f383d-d5c4-7e90-826e-32ea7b396bd2';
    const transcriptPath = `/user/.codex/sessions/exact-${providerSessionId}.jsonl`;
    let archived = null;
    const imported = importLegacyNativeCodexSession({
      entry: {
        ...ENTRY,
        tool_session_id: providerSessionId,
        tool_session_source: 'codex',
      },
      root: '/private/mc',
      deps: {
        inspectManagedSession: () => ({
          kind: 'absent',
          generations: [],
        }),
        listProviderArtifacts: () => ({
          ok: false,
          reason: 'managed-native-import-artifact-missing',
        }),
        sessionsDir: '/user/.codex/sessions',
        observeProviderArtifact: () => ({
          ok: true,
          evidence: {
            providerSessionId,
            transcriptPath,
          },
        }),
        statFile: () => ({
          mtimeMs: Date.parse('2026-07-30T11:01:21.615Z'),
        }),
        validateProviderArtifact: ({ evidence }) => ({
          ok: true,
          transcriptPath: evidence.transcriptPath,
        }),
        persistManagedSessionState: (input) => {
          archived = input;
          return { ok: true, state: { archive_digest: 'e'.repeat(64) } };
        },
      },
    });

    assert.equal(imported.ok, true);
    assert.equal(imported.provider_session_id, providerSessionId);
    assert.match(
      imported.runtime_generation,
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-8[0-9a-f]{3}-[0-9a-f]{12}$/u,
    );
    assert.equal(archived.providerArtifact.transcript_path, transcriptPath);
  });

  test('repairs the first managed fresh cutover only from unanimous pre-intent artifacts', () => {
    const oldProviderSessionId = '019f383d-d5c4-7e90-826e-32ea7b396bd2';
    const newProviderSessionId = '019fb68b-23e0-78f0-97dd-8354b99f4b38';
    const oldArtifact = {
      ...ARTIFACT,
      runtime_generation: '55555555-5555-4555-8555-555555555555',
      provider_session_id: oldProviderSessionId,
      transcript_path: '/user/.codex/sessions/old.jsonl',
      captured_at: '2026-07-30T11:01:21.615Z',
    };
    const newArtifact = {
      ...ARTIFACT,
      runtime_generation: '66666666-6666-4666-8666-666666666666',
      provider_session_id: newProviderSessionId,
      transcript_path: '/managed/.codex/sessions/new.jsonl',
      captured_at: '2026-07-31T05:00:03.019Z',
    };
    const imported = importLegacyNativeCodexSession({
      entry: {
        ...ENTRY,
        created_at: '2026-07-06T16:23:22.145Z',
        tool_session_id: newProviderSessionId,
        tool_session_source: 'codex',
        tool_session_provider_adapter: MANAGED_CODEX_PROVIDER_ID,
        tool_session_provider_generation: newArtifact.runtime_generation,
      },
      root: '/private/mc',
      deps: {
        inspectManagedSession: () => ({
          kind: 'present',
          active: null,
          generations: [{
            terminal: true,
            phase: 'ready',
            intent: {
              sequence: 1,
              recorded_at: '2026-07-31T04:54:58.041Z',
              data: { mode: 'fresh', tool: 'codex' },
            },
            receipts: {
              'provider-artifact': {
                data: { provider_session_id: newProviderSessionId },
              },
              ready: {
                data: { provider_session_id: newProviderSessionId },
              },
            },
          }],
        }),
        listProviderArtifacts: () => ({
          ok: true,
          artifacts: [oldArtifact, newArtifact],
        }),
        sessionsDir: '/user/.codex/sessions',
        validateProviderArtifact: ({ evidence }) => ({
          ok: true,
          transcriptPath: evidence.transcriptPath,
        }),
        persistManagedSessionState: () => ({
          ok: true,
          state: { archive_digest: 'd'.repeat(64) },
        }),
      },
    });

    assert.equal(imported.ok, true);
    assert.equal(imported.repaired_cutover, true);
    assert.equal(imported.provider_session_id, oldProviderSessionId);
    assert.equal(imported.runtime_generation, oldArtifact.runtime_generation);
  });

  test('repairs repeated and incomplete fresh cutover attempts from the pre-intent provider', () => {
    const oldProviderSessionId = '019f9361-736d-7291-97ea-baf5f83239ca';
    const oldArtifact = {
      ...ARTIFACT,
      runtime_generation: '77777777-7777-4777-8777-777777777777',
      provider_session_id: oldProviderSessionId,
      transcript_path: '/user/.codex/sessions/old.jsonl',
      captured_at: '2026-07-30T11:04:03.405Z',
    };
    const imported = importLegacyNativeCodexSession({
      entry: {
        ...ENTRY,
        created_at: '2026-07-24T09:07:41.368Z',
        tool_session_id: oldProviderSessionId,
        tool_session_source: 'codex',
        tool_transcript_path: oldArtifact.transcript_path,
      },
      root: '/private/mc',
      deps: {
        inspectManagedSession: () => ({
          kind: 'present',
          active: null,
          generations: [
            {
              terminal: false,
              intent: {
                sequence: 1,
                recorded_at: '2026-07-31T04:55:10.950Z',
                data: { mode: 'fresh', tool: 'codex' },
              },
              receipts: {},
            },
            {
              terminal: true,
              phase: 'ready',
              intent: {
                sequence: 2,
                recorded_at: '2026-07-31T05:26:22.518Z',
                data: { mode: 'fresh', tool: 'codex' },
              },
              receipts: {
                'provider-artifact': {
                  data: {
                    provider_session_id: '019fb6a3-5d5d-72a1-a6c4-0379608b364a',
                  },
                },
              },
            },
          ],
        }),
        listProviderArtifacts: () => ({
          ok: true,
          artifacts: [
            oldArtifact,
            {
              ...ARTIFACT,
              runtime_generation: '88888888-8888-4888-8888-888888888888',
              provider_session_id: '019fb6a3-5d5d-72a1-a6c4-0379608b364a',
              transcript_path: '/managed/.codex/sessions/new.jsonl',
              captured_at: '2026-07-31T05:26:30.365Z',
            },
          ],
        }),
        sessionsDir: '/user/.codex/sessions',
        validateProviderArtifact: ({ evidence }) => ({
          ok: true,
          transcriptPath: evidence.transcriptPath,
        }),
        persistManagedSessionState: () => ({
          ok: true,
          state: { archive_digest: 'f'.repeat(64) },
        }),
      },
    });

    assert.equal(imported.ok, true);
    assert.equal(imported.repaired_cutover, true);
    assert.equal(imported.provider_session_id, oldProviderSessionId);
    assert.equal(imported.runtime_generation, oldArtifact.runtime_generation);
  });

  test('leaves a legitimate managed fresh generation to ordinary reconciliation', () => {
    const providerSessionId = '019fb690-ab6d-7140-9137-00eb16d3e498';
    const imported = importLegacyNativeCodexSession({
      entry: {
        ...ENTRY,
        created_at: '2026-07-31T05:05:51.303Z',
        tool_session_id: providerSessionId,
        tool_session_source: 'codex',
        tool_transcript_path: null,
        tool_session_provider_adapter: MANAGED_CODEX_PROVIDER_ID,
        tool_session_provider_generation: RUNTIME_GENERATION,
      },
      root: '/private/mc',
      deps: {
        inspectManagedSession: () => ({
          kind: 'present',
          active: null,
          generations: [{
            terminal: true,
            phase: 'ready',
            intent: {
              sequence: 1,
              recorded_at: '2026-07-31T05:05:52.303Z',
              data: { mode: 'fresh', tool: 'codex' },
            },
            receipts: {},
          }],
        }),
        listProviderArtifacts: () => ({
          ok: true,
          artifacts: [{
            ...ARTIFACT,
            provider_session_id: providerSessionId,
            captured_at: '2026-07-31T05:06:05.414Z',
          }],
        }),
      },
    });

    assert.equal(imported.ok, false);
    assert.equal(imported.attempted, false);
    assert.equal(imported.reason, 'managed-native-import-artifact-missing');
  });

  test('fails closed when pre-managed artifacts disagree on the provider id', () => {
    const imported = importLegacyNativeCodexSession({
      entry: {
        ...ENTRY,
        tool_session_id: 'provider_expected',
        tool_session_source: 'codex',
      },
      root: '/private/mc',
      deps: {
        inspectManagedSession: () => ({
          kind: 'absent',
          generations: [],
        }),
        listProviderArtifacts: () => ({
          ok: true,
          artifacts: [
            { ...ARTIFACT, provider_session_id: 'provider_expected' },
            { ...ARTIFACT, provider_session_id: 'provider_other' },
          ],
        }),
      },
    });

    assert.equal(imported.ok, false);
    assert.equal(imported.attempted, true);
    assert.equal(imported.reason, 'managed-native-import-artifact-ambiguous');
  });

  test('closes an exited pre-journal resume domain only when its restored archive is unchanged', async () => {
    const entry = {
      ...ENTRY,
      tool_session_provider_generation: PROVIDER_GENERATION,
      provider_sessions: {
        schema: 1,
        providers: {
          codex: {
            session_id: ENTRY.tool_session_id,
            transcript_path: null,
            runtime_generation: PROVIDER_GENERATION,
            last_consumed_handoff_sequence: 0,
          },
        },
      },
    };
    const descriptor = {
      session_id: ENTRY.coding_session_id,
      codex_home: '/private/domain/home/.codex',
      provider_config_path: '/private/domain/home/.codex/config.toml',
    };
    let closed = null;
    const recovered = await recoverUnjournaledManagedCodexResumeDomain({
      entry,
      localPresence: {
        verdict: 'exited',
        runtime_generation: RUNTIME_GENERATION,
        reason: 'host-process-exited',
      },
      root: '/private/mc',
      deps: {
        inspectCredentialDomainPresence: () => ({
          kind: 'present',
          descriptor,
        }),
        sessionHostPaths: () => ({
          dir: '/private/host',
          lifecyclePath: '/private/host/lifecycle.json',
        }),
        readSessionLifecycle: async () => ({
          verdict: 'live',
          record: {
            state: 'live',
            runtime_generation: RUNTIME_GENERATION,
            observed_at: '2026-07-29T15:28:06.777Z',
          },
        }),
        inspectLegacyProviderAbsence: () => ({
          ok: true,
          transcript_path: '/private/domain/home/.codex/sessions/exact.jsonl',
          evidence_digest: 'd'.repeat(64),
        }),
        readRegistry: () => ({ entries: [entry] }),
        closeCredentialDomain: async (input) => {
          closed = input;
          return { ok: true };
        },
        reapZombieHosts: async (hosts) => ({
          ok: true,
          removed: hosts,
        }),
      },
    });

    assert.equal(recovered.ok, true, JSON.stringify(recovered));
    assert.equal(recovered.attempted, true);
    assert.equal(recovered.recovered, true);
    assert.equal(recovered.host_retired, true);
    assert.equal(closed.descriptor, descriptor);
    assert.equal(closed.providerArtifact.provider_session_id, ENTRY.tool_session_id);
    assert.equal(closed.providerArtifact.runtime_generation, PROVIDER_GENERATION);
    assert.equal(
      closed.providerArtifact.transcript_path,
      '/private/domain/home/.codex/sessions/exact.jsonl',
    );
  });

  test('plans one exact exited generation and keeps private evidence out of output', async () => {
    const inspected = await inspectManagedCodexRecovery({
      entry: ENTRY,
      root: '/private/mc',
      registry: { entries: [ENTRY] },
      deps: inspectionDeps(),
    });

    assert.equal(inspected.ok, true);
    assert.equal(inspected.provider_session_id, ARTIFACT.provider_session_id);
    assert.deepEqual(inspected.actions, [
      'persist-provider-auth',
      'archive-provider-session',
      'update-provider-registry',
    ]);
    assert.equal(inspected._private.providerArtifact, ARTIFACT);

    const publicResult = publicManagedCodexRecovery(inspected);
    assert.equal('_private' in publicResult, false);
    assert.doesNotMatch(JSON.stringify(publicResult), /fixed_secret_id|opaque/);
  });

  test('fails closed without positive exited lifecycle evidence', async () => {
    const inspected = await inspectManagedCodexRecovery({
      entry: ENTRY,
      root: '/private/mc',
      registry: { entries: [ENTRY] },
      deps: inspectionDeps({
        readSessionLifecycle: async () => ({
          verdict: 'unknown',
          record: null,
        }),
      }),
    });

    assert.deepEqual(inspected, {
      ok: false,
      recoverable: false,
      reason: 'managed-recovery-exit-unconfirmed',
    });
  });

  test('fails closed when the artifact does not bind the exited generation', async () => {
    const inspected = await inspectManagedCodexRecovery({
      entry: ENTRY,
      root: '/private/mc',
      registry: { entries: [ENTRY] },
      deps: inspectionDeps({
        readProviderArtifact: () => ({
          kind: 'unknown',
          reason: 'generation-mismatch',
        }),
      }),
    });

    assert.equal(inspected.reason, 'managed-recovery-provider-artifact-unconfirmed');
  });

  test('persists the fixed domain before updating registry and retiring its host', async () => {
    const order = [];
    let written = null;
    const inspected = {
      ok: true,
      name: ENTRY.name,
      coding_session_id: ENTRY.coding_session_id,
      _private: {
        descriptor: {
          session_id: ENTRY.coding_session_id,
          generation: DOMAIN_GENERATION,
          manifest_sha256: MANIFEST_DIGEST,
          fixed_secret_id: 'opaque',
        },
        providerArtifact: ARTIFACT,
        lifecycle: {
          state: 'exited',
          runtime_generation: RUNTIME_GENERATION,
          observed_at: '2026-07-29T15:28:06.777Z',
          exit_code: 0,
        },
        zombieHost: {
          session_id: ENTRY.coding_session_id,
          path: '/private/host',
          pid: 123,
        },
        entryIdentity: {
          name: ENTRY.name,
          coding_session_id: ENTRY.coding_session_id,
          worktree_path: ENTRY.worktree_path,
          tool: ENTRY.tool,
        },
      },
    };

    const result = await applyManagedCodexRecovery({
      inspection: inspected,
      portal: { apiUrl: 'https://example.test', token: 'not-returned' },
      deps: {
        readRegistry: () => ({ entries: [ENTRY] }),
        importInspectedManagedCodexRecovery: () => ({
          ok: true,
          transaction: TRANSACTION,
        }),
        closeCredentialDomain: async ({
          descriptor,
          providerArtifact,
          managedTransaction,
        }) => {
          order.push('close');
          assert.equal(descriptor.fixed_secret_id, 'opaque');
          assert.equal(providerArtifact, ARTIFACT);
          assert.equal(managedTransaction, TRANSACTION);
          return { ok: true };
        },
        writeRegistry: (next) => {
          order.push('registry');
          written = next;
        },
        reapZombieHosts: async (hosts) => {
          order.push('host');
          return { ok: true, removed: hosts };
        },
      },
    });

    assert.equal(result.ok, true);
    assert.deepEqual(order, ['close', 'registry', 'host']);
    assert.equal(written.entries[0].session_state, 'idle');
    assert.equal(written.entries[0].tool_session_id, ARTIFACT.provider_session_id);
    assert.equal(written.entries[0].tool_transcript_path, null);
    assert.equal(
      written.entries[0].tool_session_provider_adapter,
      MANAGED_CODEX_PROVIDER_ID,
    );
    assert.equal(
      written.entries[0].tool_session_provider_generation,
      RUNTIME_GENERATION,
    );
    assert.equal(
      written.entries[0].provider_sessions.providers.codex.session_id,
      ARTIFACT.provider_session_id,
    );
  });

  test('does not update registry when custody refresh or session archival fails', async () => {
    let wrote = false;
    const result = await applyManagedCodexRecovery({
      inspection: {
        ok: true,
        name: ENTRY.name,
        _private: {
          descriptor: {},
          providerArtifact: ARTIFACT,
          zombieHost: null,
          entryIdentity: {
            name: ENTRY.name,
            coding_session_id: ENTRY.coding_session_id,
            worktree_path: ENTRY.worktree_path,
            tool: ENTRY.tool,
          },
        },
      },
      portal: { apiUrl: 'https://example.test', token: 'not-returned' },
      deps: {
        readRegistry: () => ({ entries: [ENTRY] }),
        importInspectedManagedCodexRecovery: () => ({
          ok: true,
          transaction: TRANSACTION,
        }),
        closeCredentialDomain: async () => ({
          ok: false,
          reason: 'managed-domain-refresh-not-persisted',
        }),
        writeRegistry: () => { wrote = true; },
      },
    });

    assert.equal(result.ok, false);
    assert.equal(result.reason, 'managed-domain-refresh-not-persisted');
    assert.equal(wrote, false);
  });

  test('refuses recovery after the selected registry identity changes', async () => {
    let closed = false;
    const result = await applyManagedCodexRecovery({
      inspection: {
        ok: true,
        name: ENTRY.name,
        _private: {
          descriptor: {},
          providerArtifact: ARTIFACT,
          zombieHost: null,
          entryIdentity: {
            name: ENTRY.name,
            coding_session_id: ENTRY.coding_session_id,
            worktree_path: ENTRY.worktree_path,
            tool: ENTRY.tool,
          },
        },
      },
      portal: { apiUrl: 'https://example.test', token: 'not-returned' },
      deps: {
        readRegistry: () => ({
          entries: [{ ...ENTRY, coding_session_id: 'sess_replaced' }],
        }),
        closeCredentialDomain: async () => {
          closed = true;
          return { ok: true };
        },
      },
    });

    assert.equal(result.reason, 'managed-recovery-registry-changed');
    assert.equal(closed, false);
  });

  test('imports legacy exit evidence into one idempotent durable generation', () => {
    const root = mkdtempSync(join(tmpdir(), 'mc-managed-import-'));
    const inspection = {
      ok: true,
      name: ENTRY.name,
      coding_session_id: ENTRY.coding_session_id,
      runtime_generation: RUNTIME_GENERATION,
      provider_session_id: ARTIFACT.provider_session_id,
      exit_observed_at: '2026-07-29T15:28:06.777Z',
      _private: {
        root,
        descriptor: {
          session_id: ENTRY.coding_session_id,
          generation: DOMAIN_GENERATION,
          manifest_sha256: MANIFEST_DIGEST,
        },
        providerArtifact: ARTIFACT,
        lifecycle: {
          state: 'exited',
          runtime_generation: RUNTIME_GENERATION,
          observed_at: '2026-07-29T15:28:06.777Z',
          exit_code: 0,
        },
      },
    };
    try {
      const first = importInspectedManagedCodexRecovery({
        inspection,
        entry: ENTRY,
        root,
      });
      assert.equal(first.ok, true);
      assert.equal(first.generation.phase, 'exited');
      assert.deepEqual(Object.keys(first.generation.receipts), [
        'domain-ready',
        'broker-accepted',
        'live',
        'provider-artifact',
        'exited',
      ]);

      const retried = importInspectedManagedCodexRecovery({
        inspection,
        entry: ENTRY,
        root,
      });
      assert.equal(retried.ok, true);
      assert.equal(retried.transaction.intent_digest, first.transaction.intent_digest);
      const durable = inspectManagedGenerationSync({
        mcHomeDir: root,
        codingSessionId: ENTRY.coding_session_id,
        runtimeGeneration: RUNTIME_GENERATION,
      });
      assert.equal(durable.phase, 'exited');
      assert.doesNotMatch(JSON.stringify(durable), /opaque|not-returned/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
