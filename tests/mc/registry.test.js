import assert from 'node:assert/strict';
import test, { afterEach } from 'node:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  normalizeProviderSessions,
  patchProviderSessionSequenceIfPresent,
  patchEntriesIfPresent,
  readRegistry,
  readRegistryStrict,
  removeEntryIfMatches,
  upsertEntry,
} from '../../src/mc/registry.js';

test('normalizes an unambiguous legacy native session into its canonical provider projection', () => {
  const result = normalizeProviderSessions({
    tool: 'codex',
    tool_session_source: 'codex',
    tool_session_id: 'cx_a',
    tool_transcript_path: '/tmp/a.jsonl',
  });
  assert.equal(result.ok, true);
  assert.deepEqual(result.providerSessions, {
    schema: 1,
    providers: {
      codex: {
        session_id: 'cx_a', transcript_path: '/tmp/a.jsonl', runtime_generation: null,
        last_consumed_handoff_sequence: 0,
      },
    },
  });
});

test('keeps existing provider projections and rejects ambiguous legacy migration', () => {
  const existing = {
    schema: 1,
    providers: {
      codex: { session_id: 'cx_a', transcript_path: null, runtime_generation: 'gen-a', last_consumed_handoff_sequence: 4 },
      'claude-code': { session_id: 'cl_b', transcript_path: null, runtime_generation: 'gen-b', last_consumed_handoff_sequence: 2 },
    },
  };
  const result = normalizeProviderSessions({
    provider_sessions: existing,
    tool: 'unknown-tool', tool_session_id: 'legacy',
  });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'legacy-provider-ambiguous');
  assert.deepEqual(result.providerSessions, existing);
});

test('does not fall back from an unknown legacy source or mistake credential generation for runtime evidence', () => {
  const ambiguous = normalizeProviderSessions({
    tool: 'codex',
    tool_session_source: 'unknown-provider',
    tool_session_id: 'legacy',
  });
  assert.equal(ambiguous.ok, false);
  assert.equal(ambiguous.reason, 'legacy-provider-ambiguous');

  const migrated = normalizeProviderSessions({
    tool: 'codex',
    tool_session_id: 'cx_legacy',
    tool_session_provider_generation: 'credential-domain-generation',
  });
  assert.equal(migrated.providerSessions.providers.codex.runtime_generation, null);
});

test('rejects unsafe legacy provider data during migration', () => {
  for (const entry of [
    { tool: 'codex', tool_session_id: '../unsafe' },
    { tool: 'codex', tool_session_id: ' cx_unsafe' },
    { tool: 'codex', tool_session_id: 42 },
    { tool: 'codex', tool_session_id: 'cx_safe', tool_transcript_path: 'relative/transcript.jsonl' },
    { tool: 'codex', tool_session_id: 'cx_safe', tool_transcript_path: ' /tmp/transcript.jsonl' },
    { tool: 'codex', tool_session_id: 'cx_safe', tool_transcript_path: 42 },
  ]) {
    const result = normalizeProviderSessions(entry);
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'legacy-provider-invalid');
  }
});

test('preserves forward provider data and rejects it rather than silently resetting it', () => {
  const future = { schema: 2, providers: { codex: { session_id: 'cx_future' } } };
  const result = normalizeProviderSessions({ provider_sessions: future, tool: 'codex', tool_session_id: 'cx_legacy' });
  assert.deepEqual(result, { ok: false, reason: 'provider-sessions-invalid', providerSessions: future });
});

test('rejects unknown fields in a known provider projection while preserving unknown providers', () => {
  const knownExtra = normalizeProviderSessions({
    provider_sessions: {
      schema: 1,
      providers: {
        codex: {
          session_id: 'cx_a', transcript_path: null, runtime_generation: null,
          last_consumed_handoff_sequence: 0, future_field: 'not accepted for a known V1 provider',
        },
      },
    },
  });
  assert.equal(knownExtra.ok, false);

  const unknownProvider = normalizeProviderSessions({
    provider_sessions: { schema: 1, providers: { 'future-provider': { future_field: 'preserved' } } },
  });
  assert.equal(unknownProvider.ok, true);
  assert.deepEqual(unknownProvider.providerSessions.providers['future-provider'], { future_field: 'preserved' });
});

test('bounds and fences known provider session values', () => {
  const projection = (patch) => normalizeProviderSessions({
    provider_sessions: {
      schema: 1,
      providers: {
        codex: {
          session_id: 'cx_valid', transcript_path: '/tmp/codex.jsonl', runtime_generation: 'gen_valid',
          last_consumed_handoff_sequence: 0, ...patch,
        },
      },
    },
  });
  for (const patch of [
    { session_id: ' cx_valid' },
    { session_id: 'x'.repeat(129) },
    { runtime_generation: 'gen\nunsafe' },
    { transcript_path: 'relative/transcript.jsonl' },
    { transcript_path: '/tmp/unsafe\u0000.jsonl' },
    { transcript_path: `/tmp/${'x'.repeat(4096)}` },
  ]) {
    assert.equal(projection(patch).ok, false);
  }
  assert.equal(projection({ transcript_path: null, runtime_generation: null }).ok, true);
});

test('patches provider handoff sequences monotonically without touching another provider', () => {
  tempHome = mkdtempSync(join(tmpdir(), 'mc-registry-provider-sequence-'));
  process.env.MC_HOME = tempHome;
  upsertEntry({
    name: 'round-trip',
    provider_sessions: {
      schema: 1,
      providers: {
        codex: { session_id: 'cx_a', transcript_path: null, runtime_generation: null, last_consumed_handoff_sequence: 2 },
        'claude-code': { session_id: 'cl_b', transcript_path: null, runtime_generation: null, last_consumed_handoff_sequence: 7 },
      },
    },
  });
  assert.equal(patchProviderSessionSequenceIfPresent('round-trip', 'codex', 3).ok, true);
  assert.equal(readRegistry().entries[0].provider_sessions.providers.codex.last_consumed_handoff_sequence, 3);
  assert.equal(readRegistry().entries[0].provider_sessions.providers['claude-code'].last_consumed_handoff_sequence, 7);
  assert.deepEqual(patchProviderSessionSequenceIfPresent('round-trip', 'codex', 1), { ok: false, reason: 'handoff-sequence-regression' });
});

let tempHome = null;
const originalMcHome = process.env.MC_HOME;

afterEach(() => {
  if (tempHome) {
    rmSync(tempHome, { recursive: true, force: true });
    tempHome = null;
  }
  if (originalMcHome === undefined) delete process.env.MC_HOME;
  else process.env.MC_HOME = originalMcHome;
});

test('new registry entries default to the package default tool', () => {
  tempHome = mkdtempSync(join(tmpdir(), 'mc-registry-default-'));
  process.env.MC_HOME = tempHome;

  const entry = upsertEntry({ name: 'implicit-tool' });

  assert.equal(entry.tool, 'codex');
});

test('patchEntriesIfPresent updates atomically without resurrecting missing entries', () => {
  tempHome = mkdtempSync(join(tmpdir(), 'mc-registry-patch-'));
  process.env.MC_HOME = tempHome;
  upsertEntry({ name: 'present', branch: 'sess/present' });

  const missing = patchEntriesIfPresent([
    { name: 'present', tool_session_id: 'session_present' },
    { name: 'already-removed', tool_session_id: 'session_removed' },
  ]);

  assert.equal(missing.ok, false);
  assert.deepEqual(missing.missing, ['already-removed']);
  assert.equal(readRegistry().entries.length, 1);
  assert.equal(readRegistry().entries[0].tool_session_id, null);

  const updated = patchEntriesIfPresent([
    { name: 'present', tool_session_id: 'session_present' },
  ]);
  assert.equal(updated.ok, true);
  assert.equal(readRegistry().entries[0].tool_session_id, 'session_present');
});

test('strict registry reads reject malformed state instead of returning empty', () => {
  tempHome = mkdtempSync(join(tmpdir(), 'mc-registry-strict-'));
  process.env.MC_HOME = tempHome;
  writeFileSync(join(tempHome, 'registry.json'), '{not-json');

  assert.throws(() => readRegistryStrict(), /JSON/);
  assert.deepEqual(readRegistry(), { entries: [] });
});

test('removeEntryIfMatches preserves a concurrently changed teardown recipe', () => {
  tempHome = mkdtempSync(join(tmpdir(), 'mc-registry-cas-'));
  process.env.MC_HOME = tempHome;
  upsertEntry({
    name: 'target',
    branch: 'sess/target',
    worktree_path: '/tmp/target',
    tool_session_id: 'session-a',
  });

  const changed = removeEntryIfMatches('target', {
    branch: 'sess/target',
    worktree_path: '/tmp/target',
    tool_session_id: 'session-b',
  });

  assert.equal(changed.ok, false);
  assert.equal(changed.reason, 'entry-changed');
  assert.equal(readRegistryStrict().entries.length, 1);

  const removed = removeEntryIfMatches('target', {
    branch: 'sess/target',
    worktree_path: '/tmp/target',
    tool_session_id: 'session-a',
  });
  assert.equal(removed.ok, true);
  assert.deepEqual(readRegistryStrict().entries, []);
});
