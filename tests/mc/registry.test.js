import assert from 'node:assert/strict';
import test, { afterEach } from 'node:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  MC_SESSION_ID_RE,
  REGISTRY_SCHEMA_VERSION,
  formatEntryResolutionError,
  migrateRegistry,
  normalizeToolSessions,
  patchToolSessionSequenceIfPresent,
  patchEntriesIfPresent,
  readRegistry,
  readRegistryStrict,
  removeEntryIfMatches,
  resolveEntry,
  upsertEntry,
} from '../../src/mc/registry.js';
import { repositoryIdForCanonicalRemote } from '../../src/mc/repository-identity.js';

test('normalizes an unambiguous legacy native session into its canonical provider projection', () => {
  const result = normalizeToolSessions({
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
  const result = normalizeToolSessions({
    tool_sessions: existing,
    tool: 'unknown-tool', tool_session_id: 'legacy',
  });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'legacy-provider-ambiguous');
  assert.deepEqual(result.providerSessions, existing);
});

test('does not fall back from an unknown legacy source or mistake credential generation for runtime evidence', () => {
  const ambiguous = normalizeToolSessions({
    tool: 'codex',
    tool_session_source: 'unknown-provider',
    tool_session_id: 'legacy',
  });
  assert.equal(ambiguous.ok, false);
  assert.equal(ambiguous.reason, 'legacy-provider-ambiguous');

  const migrated = normalizeToolSessions({
    tool: 'codex',
    tool_session_id: 'cx_legacy',
    tool_session_generation: 'credential-domain-generation',
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
    const result = normalizeToolSessions(entry);
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'legacy-provider-invalid');
  }
});

test('preserves forward provider data and rejects it rather than silently resetting it', () => {
  const future = { schema: 2, providers: { codex: { session_id: 'cx_future' } } };
  const result = normalizeToolSessions({ tool_sessions: future, tool: 'codex', tool_session_id: 'cx_legacy' });
  assert.deepEqual(result, { ok: false, reason: 'provider-sessions-invalid', providerSessions: future });
});

test('every provider uses the same strict provider-session projection', () => {
  const knownExtra = normalizeToolSessions({
    tool_sessions: {
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

  const invalidFutureProvider = normalizeToolSessions({
    tool_sessions: { schema: 1, providers: { 'future-provider': { future_field: 'preserved' } } },
  });
  assert.equal(invalidFutureProvider.ok, false);

  const futureProvider = normalizeToolSessions({
    tool_sessions: {
      schema: 1,
      providers: {
        'future-provider': {
          session_id: 'future_1',
          transcript_path: null,
          runtime_generation: null,
          last_consumed_handoff_sequence: 0,
        },
      },
    },
  });
  assert.equal(futureProvider.ok, true);
});

test('bounds and fences known provider session values', () => {
  const projection = (patch) => normalizeToolSessions({
    tool_sessions: {
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
    tool_sessions: {
      schema: 1,
      providers: {
        codex: { session_id: 'cx_a', transcript_path: null, runtime_generation: null, last_consumed_handoff_sequence: 2 },
        'claude-code': { session_id: 'cl_b', transcript_path: null, runtime_generation: null, last_consumed_handoff_sequence: 7 },
      },
    },
  });
  assert.equal(patchToolSessionSequenceIfPresent('round-trip', 'codex', 3).ok, true);
  assert.equal(readRegistry().entries[0].tool_sessions.providers.codex.last_consumed_handoff_sequence, 3);
  assert.equal(readRegistry().entries[0].tool_sessions.providers['claude-code'].last_consumed_handoff_sequence, 7);
  assert.deepEqual(patchToolSessionSequenceIfPresent('round-trip', 'codex', 1), { ok: false, reason: 'handoff-sequence-regression' });
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
  const entry = upsertEntry({
    name: 'target',
    branch: 'sess/target',
    worktree_path: '/tmp/target',
    primary_worktree: process.cwd(),
    tool_session_id: 'session-a',
  });

  const changed = removeEntryIfMatches('target', {
    session_id: entry.session_id,
    repository_id: entry.repository_id,
    branch: 'sess/target',
    worktree_path: '/tmp/target',
    tool_session_id: 'session-b',
  });

  assert.equal(changed.ok, false);
  assert.equal(changed.reason, 'entry-changed');
  assert.equal(readRegistryStrict().entries.length, 1);

  const removed = removeEntryIfMatches('target', {
    session_id: entry.session_id,
    repository_id: entry.repository_id,
    branch: 'sess/target',
    worktree_path: '/tmp/target',
    tool_session_id: 'session-a',
  });
  assert.equal(removed.ok, true);
  assert.deepEqual(readRegistryStrict().entries, []);
});

test('migrates a 0.7.10 registry idempotently while preserving every field', () => {
  const legacy = {
    future_top_level: { preserved: true },
    entries: [{
      name: 'billing',
      primary_worktree: '/repo/a',
      future_entry_field: ['preserved'],
    }],
  };
  const resolver = () => ({
    ok: true,
    id: 'repo_aaaaaaaaaaaaaaaaaaaaaaaa',
    kind: 'local',
    canonical: null,
  });
  const first = migrateRegistry(legacy, {
    repositoryResolver: resolver,
    sessionIdFactory: () => 'mcs_111111111111111111111111',
  });
  assert.equal(first.ok, true);
  assert.equal(first.changed, true);
  assert.equal(first.registry.schema_version, REGISTRY_SCHEMA_VERSION);
  assert.equal(first.registry.future_top_level.preserved, true);
  assert.deepEqual(first.registry.entries[0].future_entry_field, ['preserved']);
  assert.equal(first.registry.entries[0].repository_id, 'repo_aaaaaaaaaaaaaaaaaaaaaaaa');
  assert.equal(first.registry.entries[0].session_id, 'mcs_111111111111111111111111');

  const second = migrateRegistry(first.registry, {
    repositoryResolver: () => { throw new Error('resolved identities must not be regenerated'); },
    sessionIdFactory: () => { throw new Error('session ids must not be regenerated'); },
  });
  assert.equal(second.ok, true);
  assert.equal(second.changed, false);
  assert.deepEqual(second.registry, first.registry);
});

test('persists the 0.7.10 migration once and keeps subsequent reads byte-stable', () => {
  tempHome = mkdtempSync(join(tmpdir(), 'mc-registry-v0710-'));
  process.env.MC_HOME = tempHome;
  const path = join(tempHome, 'registry.json');
  writeFileSync(path, JSON.stringify({
    release_marker: '0.7.10',
    entries: [{ name: 'legacy-io', primary_worktree: process.cwd(), custom: true }],
  }, null, 2));

  const first = readRegistryStrict();
  const afterFirst = readFileSync(path, 'utf8');
  const second = readRegistryStrict();
  const afterSecond = readFileSync(path, 'utf8');

  assert.equal(first.schema_version, REGISTRY_SCHEMA_VERSION);
  assert.equal(first.release_marker, '0.7.10');
  assert.match(first.entries[0].session_id, MC_SESSION_ID_RE);
  assert.equal(first.entries[0].custom, true);
  assert.deepEqual(second, first);
  assert.equal(afterSecond, afterFirst);
});

test('preserves ambiguous legacy entries byte-for-byte and reports the ambiguity', () => {
  const legacy = {
    entries: [
      { name: 'same', primary_worktree: '/repo/a', marker: 1 },
      { name: 'same', primary_worktree: '/repo/a', marker: 2 },
    ],
  };
  const before = JSON.stringify(legacy);
  const migrated = migrateRegistry(legacy, {
    repositoryResolver: () => ({
      ok: true,
      id: 'repo_aaaaaaaaaaaaaaaaaaaaaaaa',
      kind: 'local',
      canonical: null,
    }),
    sessionIdFactory: (() => {
      let next = 0;
      return () => `mcs_${String(++next).padStart(24, '0')}`;
    })(),
  });
  assert.equal(migrated.ok, false);
  assert.equal(migrated.reason, 'ambiguous-legacy-session');
  assert.equal(migrated.changed, false);
  assert.equal(JSON.stringify(migrated.registry), before);

  const lookup = resolveEntry('same', {
    registry: legacy,
    repositoryId: 'repo_aaaaaaaaaaaaaaaaaaaaaaaa',
  });
  assert.equal(lookup.ok, false);
  assert.equal(lookup.reason, 'ambiguous-legacy-session');
  assert.match(formatEntryResolutionError('same', lookup), /ambiguous|preserved/u);
});

test('does not create local repository ids before an ambiguous migration is rejected', () => {
  let createCalls = 0;
  const migrated = migrateRegistry({
    entries: [
      { name: 'same', primary_worktree: '/repo/a', marker: 1 },
      { name: 'same', primary_worktree: '/repo/a', marker: 2 },
    ],
  }, {
    repositoryResolver: (_path, { createLocal }) => {
      if (createLocal) createCalls += 1;
      return createLocal
        ? {
            ok: true,
            id: 'repo_aaaaaaaaaaaaaaaaaaaaaaaa',
            kind: 'local',
            canonical: null,
            root: '/repo/a',
          }
        : { ok: false, reason: 'local-repository-id-missing', root: '/repo/a' };
    },
  });

  assert.equal(migrated.ok, false);
  assert.equal(migrated.reason, 'ambiguous-legacy-session');
  assert.equal(createCalls, 0);
});

test('v2 provider-named fields migrate to tool_* names without re-stamping legacy keys', () => {
  const v2 = {
    schema_version: 2,
    entries: [{
      name: 'renamed',
      session_id: 'mcs_cccccccccccccccccccccccc',
      repository_id: repositoryIdForCanonicalRemote('github.com/owner/project'),
      repository_identity: {
        schema: 1,
        kind: 'remote',
        canonical: 'github.com/owner/project',
      },
      provider_sessions: {
        schema: 1,
        providers: { codex: { session_id: 'cx_1' } },
      },
      tool_session_provider_adapter: 'codex-managed-local-v1',
      tool_session_provider_generation: 'gen-1',
    }],
  };
  const migrated = migrateRegistry(v2);

  assert.equal(migrated.ok, true);
  assert.equal(migrated.changed, true);
  assert.equal(migrated.registry.schema_version, 3);
  const entry = migrated.registry.entries[0];
  assert.deepEqual(entry.tool_sessions, {
    schema: 1,
    providers: { codex: { session_id: 'cx_1' } },
  });
  assert.equal(entry.tool_session_adapter, 'codex-managed-local-v1');
  assert.equal(entry.tool_session_generation, 'gen-1');
  assert.equal('provider_sessions' in entry, false);
  assert.equal('tool_session_provider_adapter' in entry, false);
  assert.equal('tool_session_provider_generation' in entry, false);
  // v1→v2 semantics must not fire again on the v3 bump.
  assert.equal(entry.legacy_session_key, undefined);
});

test('rejects a remote projection whose canonical identity does not match its repository id', () => {
  const migrated = migrateRegistry({
    schema_version: REGISTRY_SCHEMA_VERSION,
    entries: [{
      name: 'mismatch',
      session_id: 'mcs_aaaaaaaaaaaaaaaaaaaaaaaa',
      repository_id: 'repo_bbbbbbbbbbbbbbbbbbbbbbbb',
      repository_identity: {
        schema: 1,
        kind: 'remote',
        canonical: 'github.com/owner/project',
      },
    }],
  });
  assert.equal(migrated.ok, false);
  assert.equal(migrated.reason, 'repository-identity-mismatch');
});

test('preserves same-named legacy entries when their repositories resolve distinctly', () => {
  const legacy = {
    entries: [
      { name: 'shared', primary_worktree: '/repo/a', marker: 'a' },
      { name: 'shared', primary_worktree: '/repo/b', marker: 'b' },
    ],
  };
  const migrated = migrateRegistry(legacy, {
    repositoryResolver: (path) => ({
      ok: true,
      id: path.endsWith('/a')
        ? 'repo_aaaaaaaaaaaaaaaaaaaaaaaa'
        : 'repo_bbbbbbbbbbbbbbbbbbbbbbbb',
      kind: 'local',
      canonical: null,
    }),
    sessionIdFactory: (() => {
      let next = 0;
      return () => `mcs_${String(++next).padStart(24, '0')}`;
    })(),
  });

  assert.equal(migrated.ok, true);
  assert.equal(migrated.registry.entries.length, 2);
  assert.deepEqual(migrated.registry.entries.map((entry) => entry.marker), ['a', 'b']);
  assert.equal(new Set(migrated.registry.entries.map((entry) => entry.repository_id)).size, 2);
  assert.equal(new Set(migrated.registry.entries.map((entry) => entry.session_id)).size, 2);
});

test('does not rewrite an ambiguous legacy registry during normal reads', () => {
  tempHome = mkdtempSync(join(tmpdir(), 'mc-registry-ambiguous-'));
  process.env.MC_HOME = tempHome;
  const path = join(tempHome, 'registry.json');
  const raw = JSON.stringify({
    entries: [
      { name: 'same', worktree_path: '/missing/a', marker: 1 },
      { name: 'same', worktree_path: '/missing/b', marker: 2 },
    ],
  }, null, 4);
  writeFileSync(path, raw);

  const registry = readRegistry();
  const lookup = resolveEntry('same', { registry, cwd: process.cwd() });
  assert.equal(lookup.reason, 'ambiguous-legacy-session');
  assert.throws(() => readRegistryStrict(), /ambiguous-legacy-session/u);
  assert.equal(readFileSync(path, 'utf8'), raw);
});

test('same session name resolves by repository while opaque id resolves globally', () => {
  const a = {
    name: 'billing',
    session_id: 'mcs_aaaaaaaaaaaaaaaaaaaaaaaa',
    repository_id: 'repo_aaaaaaaaaaaaaaaaaaaaaaaa',
  };
  const b = {
    name: 'billing',
    session_id: 'mcs_bbbbbbbbbbbbbbbbbbbbbbbb',
    repository_id: 'repo_bbbbbbbbbbbbbbbbbbbbbbbb',
  };
  const registry = { schema_version: REGISTRY_SCHEMA_VERSION, entries: [a, b] };
  assert.equal(resolveEntry('billing', {
    registry,
    repositoryId: b.repository_id,
  }).entry, b);
  assert.equal(resolveEntry(a.session_id, {
    registry,
    cwd: '/outside-any-repository',
  }).entry, a);
  assert.match(a.session_id, MC_SESSION_ID_RE);
});

test('fallbackGlobal resolves a unique name from any repository but keeps ambiguity failing', () => {
  const a = {
    name: 'unique-elsewhere',
    session_id: 'mcs_cccccccccccccccccccccccc',
    repository_id: 'repo_aaaaaaaaaaaaaaaaaaaaaaaa',
  };
  const b = {
    name: 'billing',
    session_id: 'mcs_aaaaaaaaaaaaaaaaaaaaaaaa',
    repository_id: 'repo_aaaaaaaaaaaaaaaaaaaaaaaa',
  };
  const c = {
    name: 'billing',
    session_id: 'mcs_bbbbbbbbbbbbbbbbbbbbbbbb',
    repository_id: 'repo_bbbbbbbbbbbbbbbbbbbbbbbb',
  };
  const registry = { schema_version: REGISTRY_SCHEMA_VERSION, entries: [a, b, c] };

  // From a repo that is NOT a's: unique name resolves with the fallback…
  const crossRepo = resolveEntry('unique-elsewhere', {
    registry,
    repositoryId: 'repo_bbbbbbbbbbbbbbbbbbbbbbbb',
    fallbackGlobal: true,
  });
  assert.equal(crossRepo.ok, true);
  assert.equal(crossRepo.entry, a);
  assert.equal(crossRepo.source, 'unique-global-name');

  // …but without the flag the repo scope still refuses…
  assert.equal(resolveEntry('unique-elsewhere', {
    registry,
    repositoryId: 'repo_bbbbbbbbbbbbbbbbbbbbbbbb',
  }).ok, false);

  // …and a cross-repo duplicate stays ambiguous even with the fallback.
  const ambiguous = resolveEntry('billing', {
    registry,
    repositoryId: 'repo_cccccccccccccccccccccccc',
    fallbackGlobal: true,
  });
  assert.equal(ambiguous.ok, false);
  assert.equal(ambiguous.reason, 'repository-mismatch');

  // Outside any repository, a unique repo-scoped name also resolves.
  const noContext = resolveEntry('unique-elsewhere', {
    registry,
    cwd: '/outside-any-repository',
    fallbackGlobal: true,
    repositoryResolver: () => null,
  });
  assert.equal(noContext.ok, true);
  assert.equal(noContext.entry, a);
});

test('resolution errors list every candidate with its opaque session id', () => {
  const result = {
    reason: 'ambiguous-session-name',
    candidates: [
      {
        session_id: 'mcs_aaaaaaaaaaaaaaaaaaaaaaaa',
        repository_identity: { schema: 1, kind: 'remote', canonical: 'github.com/org/repo-a' },
        session_state: 'idle',
        worktree_path: '/worktrees/repo-a/billing',
      },
      {
        session_id: 'mcs_bbbbbbbbbbbbbbbbbbbbbbbb',
        repo_slug: 'repo-b',
        session_state: 'live',
        worktree_path: null,
      },
    ],
  };
  const message = formatEntryResolutionError('billing', result);
  assert.match(message, /mcs_aaaaaaaaaaaaaaaaaaaaaaaa\s+repo=github\.com\/org\/repo-a\s+state=idle/);
  assert.match(message, /mcs_bbbbbbbbbbbbbbbbbbbbbbbb\s+repo=repo-b\s+state=live\s+no worktree/);
});

test('upsert preserves an unresolved legacy name in another repository', () => {
  tempHome = mkdtempSync(join(tmpdir(), 'mc-registry-legacy-preserve-'));
  process.env.MC_HOME = tempHome;
  writeFileSync(join(tempHome, 'registry.json'), JSON.stringify({
    schema_version: REGISTRY_SCHEMA_VERSION,
    entries: [{
      name: 'shared',
      session_id: 'mcs_aaaaaaaaaaaaaaaaaaaaaaaa',
      marker: 'legacy-preserved',
    }],
  }, null, 2));

  const created = upsertEntry({
    name: 'shared',
    repository_id: 'repo_bbbbbbbbbbbbbbbbbbbbbbbb',
    repository_identity: { schema: 1, kind: 'local', canonical: null },
  });

  const entries = readRegistryStrict().entries;
  assert.equal(entries.length, 2);
  assert.equal(entries.find((entry) => entry.marker)?.session_id, 'mcs_aaaaaaaaaaaaaaaaaaaaaaaa');
  assert.equal(created.repository_id, 'repo_bbbbbbbbbbbbbbbbbbbbbbbb');
});

test('upsert refuses to resurrect a removed opaque session id', () => {
  tempHome = mkdtempSync(join(tmpdir(), 'mc-registry-no-resurrection-'));
  process.env.MC_HOME = tempHome;
  const entry = upsertEntry({ name: 'gone', primary_worktree: process.cwd() });
  assert.equal(removeEntryIfMatches(entry.session_id, {
    session_id: entry.session_id,
    repository_id: entry.repository_id,
  }).ok, true);

  assert.throws(() => upsertEntry({
    name: entry.name,
    session_id: entry.session_id,
    repository_id: entry.repository_id,
    session_state: 'idle',
  }), /session_id .* not found/u);
  assert.deepEqual(readRegistryStrict().entries, []);
});

test('cleanup requires both opaque session and repository expected-id guards', () => {
  tempHome = mkdtempSync(join(tmpdir(), 'mc-registry-id-guard-'));
  process.env.MC_HOME = tempHome;
  const entry = upsertEntry({ name: 'guarded', worktree_path: process.cwd() });

  const unguarded = removeEntryIfMatches(entry.session_id, {});
  assert.deepEqual(unguarded, {
    ok: false,
    removed: false,
    reason: 'expected-identity-required',
  });
  const wrongRepo = removeEntryIfMatches(entry.session_id, {
    session_id: entry.session_id,
    repository_id: 'repo_ffffffffffffffffffffffff',
  });
  assert.equal(wrongRepo.reason, 'entry-changed');
  assert.equal(readRegistryStrict().entries.length, 1);
});
