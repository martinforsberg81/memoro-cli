import assert from 'node:assert/strict';
import {
  chmodSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { buildHandoff } from '../../../src/mc/handoff.js';
import {
  advanceHandoffSwitchJournalSync,
  beginHandoffSwitchJournalSync,
  buildHandoffSwitchJournal,
  matchesHandoffSwitchJournalAuthentication,
  readHandoffSwitchJournalSync,
  recordHandoffSwitchDiagnosticSync,
  validateHandoffSwitchJournal,
} from '../../../src/runtime/broker/handoff-switch-journal.js';

const transactionId = '73a85b7e-2ce4-4db0-8b38-16ba08de03bf';
const sourceGeneration = '4f50f5a1-4c6b-4d6a-8b5c-152c5e6b8701';
const targetGeneration = '9937ac60-46ce-42dd-9302-6533f1c6c38c';
const digest = 'd'.repeat(64);
const messageDigest = 'e'.repeat(64);
const controllerRootDigest = 'a'.repeat(64);
const controllerCapabilityDigest = 'f'.repeat(64);
const controllerRoot = 'b'.repeat(64);

function handoff() {
  return buildHandoff({
    codingSessionId: 'sess_journal1',
    sequence: 1,
    parentDigest: null,
    source: {
      kind: 'local',
      id: 'device:laptop',
      tool: 'claude-code',
      runtimeGeneration: sourceGeneration,
    },
    workspace: {
      anchor: {
        repoId: 'repo_memoro',
        ref: '1'.repeat(40),
        branch: 'sess/handoff',
      },
      digest: 'c'.repeat(64),
    },
    content: {
      goal: 'Build the provider handoff.',
      state: 'The source provider ended with a clean workspace.',
    },
  }).handoff;
}

function journal(overrides = {}) {
  return buildHandoffSwitchJournal({
    transactionId,
    codingSessionId: 'sess_journal1',
    phase: 'prepared',
    targetTool: 'codex',
    controllerRootDigest,
    controllerCapabilityDigest,
    controllerRoot,
    sourceCursor: 0,
    targetCursor: 0,
    handoff: handoff(),
    updatedAt: '2026-07-28T12:00:00.000Z',
    ...overrides,
  });
}

test('broker journal advances exact phases with private atomic storage', () => {
  const root = mkdtempSync(join(tmpdir(), 'mc-handoff-journal-'));
  try {
    const path = join(root, 'hosts', 'sess_journal1', 'handoff-switch.json');
    const begun = beginHandoffSwitchJournalSync({
      path, trustedRoot: root, journal: journal(),
    });
    assert.equal(begun.duplicate, false);
    assert.equal(statSync(path).mode & 0o777, 0o600);
    assert.equal(statSync(join(root, 'hosts', 'sess_journal1')).mode & 0o777, 0o700);

    advanceHandoffSwitchJournalSync({
      path,
      trustedRoot: root,
      controllerRoot,
      transactionId,
      expectedPhase: 'prepared',
      nextPhase: 'source_terminal_confirmed',
      updatedAt: '2026-07-28T12:01:00.000Z',
    });
    advanceHandoffSwitchJournalSync({
      path,
      trustedRoot: root,
      controllerRoot,
      transactionId,
      expectedPhase: 'source_terminal_confirmed',
      nextPhase: 'handoff_persisted',
      patch: { persisted: { sequence: 1, digest } },
      updatedAt: '2026-07-28T12:02:00.000Z',
    });
    advanceHandoffSwitchJournalSync({
      path,
      trustedRoot: root,
      controllerRoot,
      transactionId,
      expectedPhase: 'handoff_persisted',
      nextPhase: 'handoff_persisted',
      patch: {
        target_latest_sequence: 1,
        target_message_digest: messageDigest,
      },
      updatedAt: '2026-07-28T12:03:00.000Z',
    });
    advanceHandoffSwitchJournalSync({
      path,
      trustedRoot: root,
      controllerRoot,
      transactionId,
      expectedPhase: 'handoff_persisted',
      nextPhase: 'target_launch_started',
      updatedAt: '2026-07-28T12:04:00.000Z',
    });
    advanceHandoffSwitchJournalSync({
      path,
      trustedRoot: root,
      controllerRoot,
      transactionId,
      expectedPhase: 'target_launch_started',
      nextPhase: 'target_launch_started',
      patch: { target_runtime_generation: targetGeneration },
      updatedAt: '2026-07-28T12:05:00.000Z',
    });
    recordHandoffSwitchDiagnosticSync({
      path,
      trustedRoot: root,
      controllerRoot,
      transactionId,
      code: 'handoff-delivery-in-progress',
      observedAt: '2026-07-28T12:05:30.000Z',
    });
    advanceHandoffSwitchJournalSync({
      path,
      trustedRoot: root,
      controllerRoot,
      transactionId,
      expectedPhase: 'target_launch_started',
      nextPhase: 'delivery_acknowledged',
      updatedAt: '2026-07-28T12:06:00.000Z',
    });

    const read = readHandoffSwitchJournalSync({ path, trustedRoot: root });
    assert.equal(read.kind, 'present');
    assert.equal(read.journal.phase, 'delivery_acknowledged');
    assert.equal(read.journal.target_runtime_generation, targetGeneration);
    assert.equal(
      matchesHandoffSwitchJournalAuthentication(read.journal, controllerRoot),
      true,
    );
    assert.equal(matchesHandoffSwitchJournalAuthentication({
      ...read.journal,
      phase: 'prepared',
    }, controllerRoot), false);
    assert.deepEqual(read.journal.diagnostics.map((item) => item.code), [
      'transaction-prepared',
      'phase-source-terminal-confirmed',
      'phase-handoff-persisted',
      'phase-target-launch-started',
      'handoff-delivery-in-progress',
      'phase-delivery-acknowledged',
    ]);
    const raw = readFileSync(path, 'utf8');
    assert.doesNotMatch(raw, /transcript|provider_session|authorization|token|secret|environment|launch_args|pty/i);
    assert.doesNotMatch(raw, /controller-capability-raw-canary/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('journal is a single-writer lease and rejects unsafe storage', () => {
  const root = mkdtempSync(join(tmpdir(), 'mc-handoff-journal-'));
  const redirected = mkdtempSync(join(tmpdir(), 'mc-handoff-redirect-'));
  try {
    const path = join(root, 'hosts', 'sess_journal1', 'handoff-switch.json');
    beginHandoffSwitchJournalSync({ path, trustedRoot: root, journal: journal() });
    assert.throws(() => beginHandoffSwitchJournalSync({
      path,
      trustedRoot: root,
      journal: journal({
        transactionId: '7c8d5e91-01d3-4ed3-90e4-e0f5ebbc747a',
      }),
    }), /already active/);
    chmodSync(path, 0o644);
    assert.equal(readHandoffSwitchJournalSync({ path, trustedRoot: root }).kind, 'unknown');

    rmSync(join(root, 'hosts'), { recursive: true, force: true });
    symlinkSync(redirected, join(root, 'hosts'));
    assert.throws(() => beginHandoffSwitchJournalSync({
      path,
      trustedRoot: root,
      journal: journal(),
    }), /unsafe/);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(redirected, { recursive: true, force: true });
  }
});

test('validation rejects unknown fields and inconsistent delivery proof', () => {
  assert.deepEqual(validateHandoffSwitchJournal({
    ...journal(),
    transcript: 'must never persist',
  }), { ok: false, reason: 'unexpected-keys' });
  assert.equal(validateHandoffSwitchJournal({
    ...journal({
      phase: 'delivery_acknowledged',
      persisted: { sequence: 1, digest },
      targetLatestSequence: 1,
      targetMessageDigest: messageDigest,
      targetRuntimeGeneration: targetGeneration,
    }),
    target_runtime_generation: null,
  }).ok, false);
});

test('journal accepts adapter-shaped provider ids and binds managed target custody', () => {
  const futureHandoff = buildHandoff({
    codingSessionId: 'sess_journal1',
    sequence: 1,
    parentDigest: null,
    source: {
      kind: 'local',
      id: 'device:laptop',
      tool: 'future-source',
      runtimeGeneration: sourceGeneration,
    },
    workspace: {
      anchor: {
        repoId: 'repo_memoro',
        ref: '1'.repeat(40),
        branch: 'sess/handoff',
      },
      digest: 'c'.repeat(64),
    },
    content: { state: 'Continue through a registered provider adapter.' },
  });
  assert.equal(futureHandoff.ok, true);

  const built = buildHandoffSwitchJournal({
    transactionId,
    codingSessionId: 'sess_journal1',
    phase: 'prepared',
    targetTool: 'future-target',
    targetCustody: 'managed',
    controllerRootDigest,
    controllerCapabilityDigest,
    controllerRoot,
    sourceCursor: 0,
    targetCursor: 0,
    handoff: futureHandoff.handoff,
    updatedAt: '2026-07-28T12:00:00.000Z',
  });
  assert.equal(built.target_tool, 'future-target');
  assert.equal(built.target_custody, 'managed');
});
