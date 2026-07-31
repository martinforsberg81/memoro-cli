import assert from 'node:assert/strict';
import test from 'node:test';
import {
  chmodSync,
  mkdtempSync,
  mkdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  appendManagedGenerationReceiptSync,
  beginManagedGenerationSync,
  buildManagedGenerationReceipt,
  inspectManagedGenerationSync,
  inspectManagedSessionSync,
  inspectManagedSessionIdentitySync,
  claimManagedSessionIdentitySync,
  managedTransactionFromIntent,
  managedSessionDirectory,
  validateManagedGenerationTransaction,
  validateManagedGenerationReceipt,
} from '../../src/mc/managed-generation-journal.js';

const firstGeneration = '4f50f5a1-4c6b-4d6a-8b5c-152c5e6b8701';
const secondGeneration = '687c338a-1ed4-4c20-9828-1f9a39d37067';
const digestA = 'a'.repeat(64);
const digestB = 'b'.repeat(64);
const timestamp = '2026-07-29T12:00:00.000Z';

function temporaryHome() {
  return mkdtempSync(join(tmpdir(), 'mc-managed-journal-'));
}

function begin(mcHomeDir, overrides = {}) {
  return beginManagedGenerationSync({
    mcHomeDir,
    codingSessionId: 'sess_managed',
    runtimeGeneration: firstGeneration,
    mode: 'fresh',
    tool: 'codex',
    recordedAt: timestamp,
    ...overrides,
  });
}

function append(mcHomeDir, intent, phase, data, overrides = {}) {
  return appendManagedGenerationReceiptSync({
    mcHomeDir,
    codingSessionId: intent.coding_session_id,
    runtimeGeneration: intent.runtime_generation,
    intentDigest: intent.intent_digest,
    phase,
    data,
    recordedAt: timestamp,
    ...overrides,
  });
}

const chain = [
  ['domain-ready', { domain_generation: 'domain_1', manifest_digest: digestA }],
  ['broker-accepted', {}],
  ['live', {}],
  ['provider-artifact', {
    provider_session_id: 'provider_1',
    artifact_digest: digestA,
    tool: 'codex',
    transcript_path: '/private/tmp/managed-rollout.jsonl',
    captured_at: timestamp,
  }],
  ['exited', { exit_code: 0, signal: null }],
  ['custody-persisted', { record_digest: digestA }],
  ['archive-ready', { provider_session_id: 'provider_1', archive_digest: digestB }],
  ['domain-cleaned', { domain_generation: 'domain_1' }],
  ['ready', { provider_session_id: 'provider_1', archive_digest: digestB }],
];

const providerAbsentChain = [
  ['domain-ready', { domain_generation: 'domain_1', manifest_digest: digestA }],
  ['broker-accepted', {}],
  ['live', {}],
  ['exited', { exit_code: 0, signal: null }],
  ['provider-absent', { evidence_digest: digestB, tool: 'codex' }],
  ['custody-persisted', { record_digest: digestA }],
  ['domain-cleaned', { domain_generation: 'domain_1' }],
  ['ready', { provider_session_id: null, archive_digest: null }],
];

test('managed generation receipts form a durable terminal transaction', () => {
  const mcHomeDir = temporaryHome();
  try {
    const started = begin(mcHomeDir);
    assert.equal(started.duplicate, false);
    assert.deepEqual(
      validateManagedGenerationTransaction(managedTransactionFromIntent(started.intent)),
      { ok: true, value: managedTransactionFromIntent(started.intent) },
    );
    for (const [phase, data] of chain) append(mcHomeDir, started.intent, phase, data);

    const generation = inspectManagedGenerationSync({
      mcHomeDir,
      codingSessionId: 'sess_managed',
      runtimeGeneration: firstGeneration,
    });
    assert.equal(generation.kind, 'present');
    assert.equal(generation.phase, 'ready');
    assert.equal(generation.terminal, true);
    assert.equal(generation.receipts.ready.data.provider_session_id, 'provider_1');
    assert.equal(Object.keys(generation.receipts).length, chain.length);
  } finally {
    rmSync(mcHomeDir, { recursive: true, force: true });
  }
});

test('an exited generation without a provider session has a separate terminal branch', () => {
  const mcHomeDir = temporaryHome();
  try {
    const started = begin(mcHomeDir);
    for (const [phase, data] of providerAbsentChain) {
      append(mcHomeDir, started.intent, phase, data);
    }
    const generation = inspectManagedGenerationSync({
      mcHomeDir,
      codingSessionId: 'sess_managed',
      runtimeGeneration: firstGeneration,
    });
    assert.equal(generation.kind, 'present');
    assert.equal(generation.phase, 'ready');
    assert.equal(generation.terminal, true);
    assert.equal(generation.receipts.ready.data.provider_session_id, null);
    assert.equal('archive-ready' in generation.receipts, false);
  } finally {
    rmSync(mcHomeDir, { recursive: true, force: true });
  }
});

test('provider absence conflicts with artifacts and must match the immutable tool', () => {
  const mcHomeDir = temporaryHome();
  const conflictHome = temporaryHome();
  try {
    const started = begin(mcHomeDir);
    for (const [phase, data] of providerAbsentChain.slice(0, 4)) {
      append(mcHomeDir, started.intent, phase, data);
    }
    append(mcHomeDir, started.intent, 'provider-absent', {
      evidence_digest: digestB,
      tool: 'claude-code',
    });
    assert.equal(inspectManagedGenerationSync({
      mcHomeDir,
      codingSessionId: 'sess_managed',
      runtimeGeneration: firstGeneration,
    }).reason, 'provider-absent-tool-mismatch');

    const conflict = begin(conflictHome);
    for (const [phase, data] of chain.slice(0, 5)) {
      append(conflictHome, conflict.intent, phase, data);
    }
    assert.throws(
      () => append(conflictHome, conflict.intent, 'provider-absent', {
        evidence_digest: digestB,
        tool: 'codex',
      }),
      /conflicting-provider-outcome-receipts/,
    );
  } finally {
    rmSync(mcHomeDir, { recursive: true, force: true });
    rmSync(conflictHome, { recursive: true, force: true });
  }
});

test('the durable transaction is provider-agnostic and accepts any bounded adapter id', () => {
  const mcHomeDir = temporaryHome();
  try {
    const started = begin(mcHomeDir, { tool: 'future-provider-v1' });
    for (const [phase, data] of chain) {
      append(mcHomeDir, started.intent, phase, phase === 'provider-artifact'
        ? {
            ...data,
            tool: 'future-provider-v1',
            transcript_path: '/private/tmp/managed-provider.jsonl',
          }
        : data);
    }

    const generation = inspectManagedGenerationSync({
      mcHomeDir,
      codingSessionId: 'sess_managed',
      runtimeGeneration: firstGeneration,
    });
    assert.equal(generation.kind, 'present');
    assert.equal(generation.phase, 'ready');
    assert.equal(generation.intent.data.tool, 'future-provider-v1');
    assert.equal(generation.receipts['provider-artifact'].data.tool, 'future-provider-v1');
  } finally {
    rmSync(mcHomeDir, { recursive: true, force: true });
  }
});

test('provider artifact tool must match the immutable managed launch intent', () => {
  const mcHomeDir = temporaryHome();
  try {
    const started = begin(mcHomeDir, { tool: 'claude-code' });
    for (const [phase, data] of chain.slice(0, 3)) {
      append(mcHomeDir, started.intent, phase, data);
    }
    append(mcHomeDir, started.intent, 'provider-artifact', chain[3][1]);

    const generation = inspectManagedGenerationSync({
      mcHomeDir,
      codingSessionId: 'sess_managed',
      runtimeGeneration: firstGeneration,
    });
    assert.equal(generation.kind, 'unknown');
    assert.equal(generation.reason, 'provider-artifact-tool-mismatch');
  } finally {
    rmSync(mcHomeDir, { recursive: true, force: true });
  }
});

test('generation and phase retries are idempotent but conflicting bindings fail closed', () => {
  const mcHomeDir = temporaryHome();
  try {
    const first = begin(mcHomeDir);
    assert.equal(begin(mcHomeDir, { recordedAt: '2026-07-29T12:01:00.000Z' }).duplicate, true);
    assert.throws(
      () => begin(mcHomeDir, { mode: 'resume', resumeProviderSessionId: 'provider_other' }),
      /different launch intent/,
    );

    assert.equal(append(mcHomeDir, first.intent, 'domain-ready', {
      domain_generation: 'domain_1',
      manifest_digest: digestA,
    }).duplicate, false);
    assert.equal(append(mcHomeDir, first.intent, 'domain-ready', {
      domain_generation: 'domain_1',
      manifest_digest: digestA,
    }, { recordedAt: '2026-07-29T12:02:00.000Z' }).duplicate, true);
    assert.throws(
      () => append(mcHomeDir, first.intent, 'domain-ready', {
        domain_generation: 'domain_2',
        manifest_digest: digestA,
      }),
      /different receipt/,
    );
  } finally {
    rmSync(mcHomeDir, { recursive: true, force: true });
  }
});

test('one immutable sequence claim prevents a second active generation', () => {
  const mcHomeDir = temporaryHome();
  try {
    const first = begin(mcHomeDir);
    assert.throws(
      () => begin(mcHomeDir, {
        runtimeGeneration: secondGeneration,
        mode: 'resume',
        resumeProviderSessionId: 'provider_1',
      }),
      /still active/,
    );
    append(mcHomeDir, first.intent, 'aborted', { reason: 'launch-not-accepted' });
    const second = begin(mcHomeDir, {
      runtimeGeneration: secondGeneration,
      mode: 'resume',
      resumeProviderSessionId: 'provider_1',
    });
    assert.equal(second.intent.sequence, 2);
    assert.equal(inspectManagedSessionSync({
      mcHomeDir,
      codingSessionId: 'sess_managed',
    }).active.runtime_generation, secondGeneration);
  } finally {
    rmSync(mcHomeDir, { recursive: true, force: true });
  }
});

test('one immutable identity claim prevents competing coding session ids', () => {
  const mcHomeDir = temporaryHome();
  try {
    const first = claimManagedSessionIdentitySync({
      mcHomeDir,
      sessionName: 'managed work',
      codingSessionId: 'sess_first',
      recordedAt: timestamp,
    });
    assert.equal(first.ok, true);
    assert.equal(claimManagedSessionIdentitySync({
      mcHomeDir,
      sessionName: 'managed work',
      codingSessionId: 'sess_first',
      recordedAt: '2026-07-29T12:01:00.000Z',
    }).duplicate, true);
    const conflict = claimManagedSessionIdentitySync({
      mcHomeDir,
      sessionName: 'managed work',
      codingSessionId: 'sess_second',
      recordedAt: timestamp,
    });
    assert.equal(conflict.ok, false);
    assert.equal(conflict.identity.coding_session_id, 'sess_first');
    assert.equal(inspectManagedSessionIdentitySync({
      mcHomeDir,
      sessionName: 'managed work',
    }).identity.coding_session_id, 'sess_first');
  } finally {
    rmSync(mcHomeDir, { recursive: true, force: true });
  }
});

test('same human name has independent managed identity claims under opaque session ids', () => {
  const mcHomeDir = temporaryHome();
  try {
    const first = claimManagedSessionIdentitySync({
      mcHomeDir,
      sessionName: 'billing',
      registrySessionId: 'mcs_aaaaaaaaaaaaaaaaaaaaaaaa',
      codingSessionId: 'sess_first',
      recordedAt: timestamp,
    });
    const second = claimManagedSessionIdentitySync({
      mcHomeDir,
      sessionName: 'billing',
      registrySessionId: 'mcs_bbbbbbbbbbbbbbbbbbbbbbbb',
      codingSessionId: 'sess_second',
      recordedAt: timestamp,
    });
    assert.equal(first.ok, true);
    assert.equal(second.ok, true);
    assert.equal(inspectManagedSessionIdentitySync({
      mcHomeDir,
      sessionName: 'billing',
      registrySessionId: 'mcs_aaaaaaaaaaaaaaaaaaaaaaaa',
    }).identity.coding_session_id, 'sess_first');
    assert.equal(inspectManagedSessionIdentitySync({
      mcHomeDir,
      sessionName: 'billing',
      registrySessionId: 'mcs_bbbbbbbbbbbbbbbbbbbbbbbb',
    }).identity.coding_session_id, 'sess_second');
  } finally {
    rmSync(mcHomeDir, { recursive: true, force: true });
  }
});

test('a uniquely migrated entry can inspect its legacy name-keyed identity', () => {
  const mcHomeDir = temporaryHome();
  try {
    claimManagedSessionIdentitySync({
      mcHomeDir,
      sessionName: 'legacy-billing',
      codingSessionId: 'sess_legacy',
      recordedAt: timestamp,
    });
    const migrated = inspectManagedSessionIdentitySync({
      mcHomeDir,
      sessionName: 'legacy-billing',
      registrySessionId: 'mcs_cccccccccccccccccccccccc',
      legacySessionKey: 'legacy-billing',
    });
    assert.equal(migrated.kind, 'present');
    assert.equal(migrated.identity.coding_session_id, 'sess_legacy');
  } finally {
    rmSync(mcHomeDir, { recursive: true, force: true });
  }
});

test('a renamed migrated entry keeps its legacy managed identity claim', () => {
  const mcHomeDir = temporaryHome();
  try {
    claimManagedSessionIdentitySync({
      mcHomeDir,
      sessionName: 'legacy-before-rename',
      codingSessionId: 'sess_legacy_renamed',
      recordedAt: timestamp,
    });
    const migrated = inspectManagedSessionIdentitySync({
      mcHomeDir,
      sessionName: 'renamed-session',
      registrySessionId: 'mcs_dddddddddddddddddddddddd',
      legacySessionKey: 'legacy-before-rename',
    });
    assert.equal(migrated.kind, 'present');
    assert.equal(migrated.identity.coding_session_id, 'sess_legacy_renamed');
  } finally {
    rmSync(mcHomeDir, { recursive: true, force: true });
  }
});

test('out-of-order and post-terminal receipts are rejected', () => {
  const mcHomeDir = temporaryHome();
  try {
    const started = begin(mcHomeDir);
    assert.throws(
      () => append(mcHomeDir, started.intent, 'live', {}),
      /live-without-broker-accepted/,
    );
    append(mcHomeDir, started.intent, 'aborted', { reason: 'launch-failed-before-provider' });
    assert.throws(
      () => append(mcHomeDir, started.intent, 'domain-ready', {
        domain_generation: 'domain_1',
        manifest_digest: digestA,
      }),
      /already terminal/,
    );
  } finally {
    rmSync(mcHomeDir, { recursive: true, force: true });
  }
});

test('the crash matrix remains deterministic after every durable boundary', () => {
  for (let boundary = 0; boundary <= chain.length; boundary += 1) {
    const mcHomeDir = temporaryHome();
    try {
      const started = begin(mcHomeDir);
      for (const [phase, data] of chain.slice(0, boundary)) {
        append(mcHomeDir, started.intent, phase, data);
      }
      const interrupted = inspectManagedGenerationSync({
        mcHomeDir,
        codingSessionId: 'sess_managed',
        runtimeGeneration: firstGeneration,
      });
      assert.equal(interrupted.kind, 'present');
      assert.equal(interrupted.phase, boundary ? chain[boundary - 1][0] : 'intent');
      for (const [phase, data] of chain.slice(boundary)) {
        append(mcHomeDir, started.intent, phase, data);
      }
      assert.equal(inspectManagedGenerationSync({
        mcHomeDir,
        codingSessionId: 'sess_managed',
        runtimeGeneration: firstGeneration,
      }).phase, 'ready');
    } finally {
      rmSync(mcHomeDir, { recursive: true, force: true });
    }
  }
});

test('receipt validation rejects arbitrary or secret-bearing fields', () => {
  const receipt = buildManagedGenerationReceipt({
    phase: 'live',
    codingSessionId: 'sess_managed',
    runtimeGeneration: firstGeneration,
    intentDigest: digestA,
    recordedAt: timestamp,
    data: {},
  });
  assert.deepEqual(validateManagedGenerationReceipt({
    ...receipt,
    environment: { API_KEY: 'never' },
  }), { ok: false, reason: 'unexpected-keys' });
  assert.throws(
    () => buildManagedGenerationReceipt({
      phase: 'live',
      codingSessionId: 'sess_managed',
      runtimeGeneration: firstGeneration,
      intentDigest: digestA,
      recordedAt: timestamp,
      data: { credential: 'never' },
    }),
    /unexpected managed receipt data/,
  );
  assert.equal(buildManagedGenerationReceipt({
    phase: 'aborted',
    codingSessionId: 'sess_managed',
    runtimeGeneration: firstGeneration,
    intentDigest: digestA,
    recordedAt: timestamp,
    data: {
      reason: 'launch-not-accepted',
      failure_reason: 'managed-provider-hook-mismatch',
    },
  }).data.failure_reason, 'managed-provider-hook-mismatch');
  assert.throws(
    () => buildManagedGenerationReceipt({
      phase: 'aborted',
      codingSessionId: 'sess_managed',
      runtimeGeneration: firstGeneration,
      intentDigest: digestA,
      recordedAt: timestamp,
      data: {
        reason: 'launch-not-accepted',
        failure_reason: 'failed at /private/path with token',
      },
    }),
    /invalid managed abort failure reason/,
  );
});

test('journal rejects symlinks and insecure directories in its trusted chain', () => {
  const mcHomeDir = temporaryHome();
  const redirected = temporaryHome();
  try {
    symlinkSync(redirected, join(mcHomeDir, 'managed-sessions'));
    assert.throws(() => begin(mcHomeDir), /journal is unsafe/);
  } finally {
    rmSync(mcHomeDir, { recursive: true, force: true });
    rmSync(redirected, { recursive: true, force: true });
  }

  const insecureHome = temporaryHome();
  try {
    chmodSync(insecureHome, 0o755);
    assert.throws(() => begin(insecureHome), /journal is unsafe/);
  } finally {
    rmSync(insecureHome, { recursive: true, force: true });
  }
});

test('inspection fails closed on tampering and ignores an uncommitted temp file', () => {
  const mcHomeDir = temporaryHome();
  try {
    const started = begin(mcHomeDir);
    const sessionDir = managedSessionDirectory({
      mcHomeDir,
      codingSessionId: 'sess_managed',
    });
    writeFileSync(join(sessionDir, 'generation-claims', '.interrupted.tmp'), '{}', { mode: 0o600 });
    assert.equal(inspectManagedSessionSync({
      mcHomeDir,
      codingSessionId: 'sess_managed',
    }).kind, 'present');

    const generationDir = join(sessionDir, 'runtime-generations', firstGeneration);
    mkdirSync(generationDir, { recursive: true, mode: 0o700 });
    writeFileSync(join(generationDir, 'live.json'), JSON.stringify({
      schema: 'mc-managed-generation-receipt',
      version: 1,
      phase: 'live',
      coding_session_id: 'sess_other',
      runtime_generation: firstGeneration,
      intent_digest: started.intent.intent_digest,
      recorded_at: timestamp,
      data: {},
    }), { mode: 0o600 });
    assert.match(inspectManagedSessionSync({
      mcHomeDir,
      codingSessionId: 'sess_managed',
    }).reason, /live-binding-mismatch/);
  } finally {
    rmSync(mcHomeDir, { recursive: true, force: true });
  }
});
