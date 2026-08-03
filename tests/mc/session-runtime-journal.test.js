import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import {
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  abortRuntimeGenerationSync,
  acceptRuntimeGenerationSync,
  beginRuntimeGenerationSync,
  bindRuntimeConversationSync,
  completeRuntimeGenerationSync,
  decideSessionRuntimeAction,
  failRuntimeGenerationSync,
  inspectSessionRuntimeSync,
  markRuntimeGenerationLiveSync,
  rebuildSessionRuntimeProjectionSync,
  recordRuntimeGenerationExitSync,
  validateConversationRecord,
  validateGenerationIntent,
  validateGenerationReceipt,
} from '../../src/mc/session-runtime-journal.js';
import {
  createSessionHomeSync,
  readSessionHomeSync,
  sessionHomePaths,
} from '../../src/mc/session-home.js';
import { createWorkspaceAssociationSync } from '../../src/mc/workspace-record.js';

const mcSessionId = 'mcs_000000000000000000000001';
const otherSessionId = 'mcs_000000000000000000000002';
const conversationOne = 'mcc_000000000000000000000001';
const conversationTwo = 'mcc_000000000000000000000002';
const conversationThree = 'mcc_000000000000000000000003';
const generationOne = 'mcg_000000000000000000000001';
const generationTwo = 'mcg_000000000000000000000002';
const generationThree = 'mcg_000000000000000000000003';
const workspaceOne = 'mcw_000000000000000000000001';
const handoffOne = 'a'.repeat(64);
const handoffTwo = 'b'.repeat(64);

let temporaryRoots = [];

afterEach(() => {
  for (const root of temporaryRoots) rmSync(root, { recursive: true, force: true });
  temporaryRoots = [];
});

function temporaryHome() {
  const root = mkdtempSync(join(tmpdir(), 'mc-session-runtime-'));
  temporaryRoots.push(root);
  return root;
}

function clock() {
  let value = Date.parse('2026-08-02T21:00:00.000Z');
  return () => {
    const current = new Date(value).toISOString();
    value += 1000;
    return current;
  };
}

function createSession(mcHomeDir, id = mcSessionId, name = 'runtime-test') {
  return createSessionHomeSync({
    mcHomeDir,
    mcSessionId: id,
    sourceId: 'machine_test',
    name,
    now: () => '2026-08-02T20:59:00.000Z',
  });
}

function begin(mcHomeDir, now, overrides = {}) {
  return beginRuntimeGenerationSync({
    mcHomeDir,
    mcSessionId,
    generationId: generationOne,
    action: 'start',
    tool: 'codex',
    launchCwd: '/projects/one',
    now,
    ...overrides,
  });
}

function makeFreshConversation(mcHomeDir, now) {
  begin(mcHomeDir, now);
  acceptRuntimeGenerationSync({ mcHomeDir, mcSessionId, generationId: generationOne, now });
  markRuntimeGenerationLiveSync({ mcHomeDir, mcSessionId, generationId: generationOne, now });
  bindRuntimeConversationSync({
    mcHomeDir,
    mcSessionId,
    generationId: generationOne,
    conversationId: conversationOne,
    handle: 'codex-handle-1',
    now,
  });
  recordRuntimeGenerationExitSync({
    mcHomeDir,
    mcSessionId,
    generationId: generationOne,
    exitCode: 0,
    now,
  });
  completeRuntimeGenerationSync({
    mcHomeDir,
    mcSessionId,
    generationId: generationOne,
    conversationId: conversationOne,
    now,
  });
}

test('journals fresh and resumed generations under one mc session home', () => {
  const mcHomeDir = temporaryHome();
  const now = clock();
  createSession(mcHomeDir);
  makeFreshConversation(mcHomeDir, now);

  const paths = sessionHomePaths({ mcHomeDir, mcSessionId });
  assert.deepEqual(readdirSync(paths.generationsPath).sort(), [
    generationOne,
    `${generationOne}.json`,
  ]);
  assert.deepEqual(readdirSync(paths.conversationsPath), [`${conversationOne}.json`]);
  assert.ok(paths.generationsPath.includes(`/sessions/${mcSessionId}/generations`));
  assert.equal(readSessionHomeSync({ mcHomeDir, mcSessionId }).projection.runtime_state, 'exited');

  assert.deepEqual(
    decideSessionRuntimeAction(inspectSessionRuntimeSync({ mcHomeDir, mcSessionId })),
    { action: 'resume', conversation_id: conversationOne, tool: 'codex' },
  );
  beginRuntimeGenerationSync({
    mcHomeDir,
    mcSessionId,
    generationId: generationTwo,
    action: 'resume',
    tool: 'codex',
    launchCwd: '/projects/two',
    resumeConversationId: conversationOne,
    now,
  });
  acceptRuntimeGenerationSync({ mcHomeDir, mcSessionId, generationId: generationTwo, now });
  markRuntimeGenerationLiveSync({ mcHomeDir, mcSessionId, generationId: generationTwo, now });
  assert.throws(() => bindRuntimeConversationSync({
    mcHomeDir,
    mcSessionId,
    generationId: generationTwo,
    conversationId: conversationTwo,
    handle: 'implicit-fallback-handle',
    now,
  }), (error) => error.reason === 'resume-cannot-create-conversation');
  recordRuntimeGenerationExitSync({
    mcHomeDir,
    mcSessionId,
    generationId: generationTwo,
    exitCode: 0,
    now,
  });
  completeRuntimeGenerationSync({
    mcHomeDir,
    mcSessionId,
    generationId: generationTwo,
    conversationId: conversationOne,
    now,
  });

  const snapshot = inspectSessionRuntimeSync({ mcHomeDir, mcSessionId });
  assert.equal(snapshot.kind, 'present');
  assert.equal(snapshot.generations.length, 2);
  assert.deepEqual(snapshot.generations.map((item) => item.intent.launch_cwd), [
    '/projects/one',
    '/projects/two',
  ]);
  assert.ok(snapshot.generations.every((item) => item.intent.mc_session_id === mcSessionId));
  assert.equal(snapshot.conversations.length, 1);
});

test('uses the unfinished journal as the one-live-generation claim', () => {
  const mcHomeDir = temporaryHome();
  const now = clock();
  createSession(mcHomeDir);
  begin(mcHomeDir, now);

  assert.throws(() => beginRuntimeGenerationSync({
    mcHomeDir,
    mcSessionId,
    generationId: generationTwo,
    action: 'start',
    tool: 'codex',
    launchCwd: '/projects/one',
    now,
  }), (error) => error.reason === 'live-generation-claim-conflict');
  acceptRuntimeGenerationSync({ mcHomeDir, mcSessionId, generationId: generationOne, now });
  assert.throws(() => beginRuntimeGenerationSync({
    mcHomeDir,
    mcSessionId,
    generationId: generationTwo,
    action: 'replace',
    tool: 'codex',
    launchCwd: '/projects/one',
    previousGenerationId: generationOne,
    replacementReason: 'timeout',
    now,
  }), (error) => error.reason === 'live-generation-claim-conflict');

  const snapshot = inspectSessionRuntimeSync({ mcHomeDir, mcSessionId });
  assert.equal(snapshot.generations.length, 1);
  assert.equal(snapshot.active_generation.intent.generation_id, generationOne);
  assert.equal(readSessionHomeSync({ mcHomeDir, mcSessionId }).projection.runtime_state, 'starting');
});

test('binds an optional launch workspace to the same session without making it identity', () => {
  const mcHomeDir = temporaryHome();
  const now = clock();
  createSession(mcHomeDir);
  assert.throws(() => begin(mcHomeDir, now, {
    workspaceId: workspaceOne,
  }), (error) => error.reason === 'workspace-absent');

  createWorkspaceAssociationSync({
    mcHomeDir,
    mcSessionId,
    workspaceId: workspaceOne,
    kind: 'directory',
    currentPath: '/projects/one',
    now,
  });
  const generation = begin(mcHomeDir, now, { workspaceId: workspaceOne });
  assert.equal(generation.intent.workspace_id, workspaceOne);
  assert.equal(generation.intent.mc_session_id, mcSessionId);
  assert.equal(generation.intent.launch_cwd, '/projects/one');
});

test('distinguishes planned, accepted, live, and exited crash recovery', () => {
  const mcHomeDir = temporaryHome();
  const now = clock();
  createSession(mcHomeDir);
  begin(mcHomeDir, now);
  assert.deepEqual(
    decideSessionRuntimeAction(inspectSessionRuntimeSync({ mcHomeDir, mcSessionId })),
    { action: 'launch-planned-generation', generation_id: generationOne },
  );

  acceptRuntimeGenerationSync({ mcHomeDir, mcSessionId, generationId: generationOne, now });
  assert.deepEqual(
    decideSessionRuntimeAction(inspectSessionRuntimeSync({ mcHomeDir, mcSessionId })),
    { action: 'reconcile-accepted-outcome', generation_id: generationOne },
  );

  markRuntimeGenerationLiveSync({ mcHomeDir, mcSessionId, generationId: generationOne, now });
  assert.deepEqual(
    decideSessionRuntimeAction(inspectSessionRuntimeSync({ mcHomeDir, mcSessionId })),
    { action: 'attach', generation_id: generationOne },
  );
  recordRuntimeGenerationExitSync({
    mcHomeDir,
    mcSessionId,
    generationId: generationOne,
    signal: 'SIGTERM',
    now,
  });
  assert.deepEqual(
    decideSessionRuntimeAction(inspectSessionRuntimeSync({ mcHomeDir, mcSessionId })),
    { action: 'resolve-missing-conversation', generation_id: generationOne },
  );
  assert.throws(() => completeRuntimeGenerationSync({
    mcHomeDir,
    mcSessionId,
    generationId: generationOne,
    conversationId: conversationOne,
    now,
  }), (error) => error.reason === 'generation-conversation-missing');
});

test('replays receipts and conversation binding idempotently but rejects conflicts', () => {
  const mcHomeDir = temporaryHome();
  const now = clock();
  createSession(mcHomeDir);
  begin(mcHomeDir, now);
  acceptRuntimeGenerationSync({ mcHomeDir, mcSessionId, generationId: generationOne, now });
  acceptRuntimeGenerationSync({ mcHomeDir, mcSessionId, generationId: generationOne, now });
  markRuntimeGenerationLiveSync({ mcHomeDir, mcSessionId, generationId: generationOne, now });
  const first = bindRuntimeConversationSync({
    mcHomeDir,
    mcSessionId,
    generationId: generationOne,
    conversationId: conversationOne,
    handle: 'stable-handle',
    now,
  });
  const replay = bindRuntimeConversationSync({
    mcHomeDir,
    mcSessionId,
    generationId: generationOne,
    conversationId: conversationTwo,
    handle: 'stable-handle',
    now,
  });
  assert.equal(replay.conversation_id, first.conversation_id);
  assert.throws(() => bindRuntimeConversationSync({
    mcHomeDir,
    mcSessionId,
    generationId: generationOne,
    conversationId: conversationTwo,
    handle: 'conflicting-handle',
    now,
  }), (error) => error.reason === 'generation-conversation-conflict');

  recordRuntimeGenerationExitSync({
    mcHomeDir,
    mcSessionId,
    generationId: generationOne,
    exitCode: 0,
    now,
  });
  recordRuntimeGenerationExitSync({
    mcHomeDir,
    mcSessionId,
    generationId: generationOne,
    exitCode: 0,
    now,
  });
  assert.throws(() => recordRuntimeGenerationExitSync({
    mcHomeDir,
    mcSessionId,
    generationId: generationOne,
    exitCode: 1,
    now,
  }), (error) => error.reason === 'generation-phase-conflict');
  const snapshot = inspectSessionRuntimeSync({ mcHomeDir, mcSessionId });
  assert.deepEqual(snapshot.generations[0].receipts.map((item) => item.phase), [
    'accepted',
    'live',
    'exited',
  ]);
});

test('requires explicit replacement after a failed generation without a handle', () => {
  const mcHomeDir = temporaryHome();
  const now = clock();
  createSession(mcHomeDir);
  begin(mcHomeDir, now);
  acceptRuntimeGenerationSync({ mcHomeDir, mcSessionId, generationId: generationOne, now });
  failRuntimeGenerationSync({
    mcHomeDir,
    mcSessionId,
    generationId: generationOne,
    reason: 'accepted-process-absence-proven',
    now,
  });
  assert.deepEqual(
    decideSessionRuntimeAction(inspectSessionRuntimeSync({ mcHomeDir, mcSessionId })),
    { action: 'explicit-replacement-required', previous_generation_id: generationOne },
  );
  assert.throws(() => beginRuntimeGenerationSync({
    mcHomeDir,
    mcSessionId,
    generationId: generationTwo,
    action: 'replace',
    tool: 'codex',
    launchCwd: '/projects/one',
    previousGenerationId: generationOne,
    now,
  }), (error) => error.reason === 'replacement-requires-reason');

  const replacement = beginRuntimeGenerationSync({
    mcHomeDir,
    mcSessionId,
    generationId: generationTwo,
    action: 'replace',
    tool: 'codex',
    launchCwd: '/projects/one',
    previousGenerationId: generationOne,
    replacementReason: 'conversation-handle-unavailable',
    now,
  });
  assert.equal(replacement.intent.previous_generation_id, generationOne);
  assert.equal(replacement.intent.action, 'replace');
});

test('records Codex to Claude and Claude to Codex switches without changing session identity', () => {
  const mcHomeDir = temporaryHome();
  const now = clock();
  createSession(mcHomeDir);
  makeFreshConversation(mcHomeDir, now);

  assert.deepEqual(
    decideSessionRuntimeAction(inspectSessionRuntimeSync({ mcHomeDir, mcSessionId }), { tool: 'claude' }),
    {
      action: 'switch',
      previous_conversation_id: conversationOne,
      source_tool: 'codex',
      target_tool: 'claude',
      requires_handoff: true,
    },
  );
  assert.throws(() => beginRuntimeGenerationSync({
    mcHomeDir,
    mcSessionId,
    generationId: generationTwo,
    action: 'switch',
    tool: 'claude',
    launchCwd: '/projects/two',
    previousConversationId: conversationOne,
    now,
  }), (error) => error.reason === 'switch-requires-handoff');
  beginRuntimeGenerationSync({
    mcHomeDir,
    mcSessionId,
    generationId: generationTwo,
    action: 'switch',
    tool: 'claude',
    launchCwd: '/projects/two',
    previousConversationId: conversationOne,
    handoffSha256: handoffOne,
    now,
  });
  acceptRuntimeGenerationSync({ mcHomeDir, mcSessionId, generationId: generationTwo, now });
  markRuntimeGenerationLiveSync({ mcHomeDir, mcSessionId, generationId: generationTwo, now });
  bindRuntimeConversationSync({
    mcHomeDir,
    mcSessionId,
    generationId: generationTwo,
    conversationId: conversationTwo,
    handle: 'claude-handle-1',
    now,
  });
  recordRuntimeGenerationExitSync({
    mcHomeDir,
    mcSessionId,
    generationId: generationTwo,
    exitCode: 0,
    now,
  });
  completeRuntimeGenerationSync({
    mcHomeDir,
    mcSessionId,
    generationId: generationTwo,
    conversationId: conversationTwo,
    now,
  });

  beginRuntimeGenerationSync({
    mcHomeDir,
    mcSessionId,
    generationId: generationThree,
    action: 'switch',
    tool: 'codex',
    launchCwd: '/notes',
    previousConversationId: conversationTwo,
    handoffSha256: handoffTwo,
    now,
  });
  acceptRuntimeGenerationSync({ mcHomeDir, mcSessionId, generationId: generationThree, now });
  markRuntimeGenerationLiveSync({ mcHomeDir, mcSessionId, generationId: generationThree, now });
  bindRuntimeConversationSync({
    mcHomeDir,
    mcSessionId,
    generationId: generationThree,
    conversationId: conversationThree,
    handle: 'codex-handle-2',
    now,
  });

  const snapshot = inspectSessionRuntimeSync({ mcHomeDir, mcSessionId });
  assert.equal(snapshot.mc_session_id, mcSessionId);
  assert.deepEqual(snapshot.generations.map((item) => item.intent.tool), [
    'codex',
    'claude',
    'codex',
  ]);
  assert.deepEqual(snapshot.conversations[1].relation, {
    kind: 'switch',
    previous_conversation_id: conversationOne,
    previous_generation_id: null,
    handoff_sha256: handoffOne,
  });
  assert.deepEqual(snapshot.conversations[2].relation, {
    kind: 'switch',
    previous_conversation_id: conversationTwo,
    previous_generation_id: null,
    handoff_sha256: handoffTwo,
  });
});

test('fails closed on duplicate handles and invalid replacement or switch evidence', () => {
  const mcHomeDir = temporaryHome();
  const now = clock();
  createSession(mcHomeDir);
  makeFreshConversation(mcHomeDir, now);
  beginRuntimeGenerationSync({
    mcHomeDir,
    mcSessionId,
    generationId: generationTwo,
    action: 'replace',
    tool: 'codex',
    launchCwd: '/projects/one',
    previousConversationId: conversationOne,
    replacementReason: 'user-requested-replacement',
    now,
  });
  acceptRuntimeGenerationSync({ mcHomeDir, mcSessionId, generationId: generationTwo, now });
  markRuntimeGenerationLiveSync({ mcHomeDir, mcSessionId, generationId: generationTwo, now });
  assert.throws(() => bindRuntimeConversationSync({
    mcHomeDir,
    mcSessionId,
    generationId: generationTwo,
    conversationId: conversationTwo,
    handle: 'codex-handle-1',
    now,
  }), (error) => error.reason === 'conversation-handle-conflict');
  const replacement = bindRuntimeConversationSync({
    mcHomeDir,
    mcSessionId,
    generationId: generationTwo,
    conversationId: conversationTwo,
    handle: 'codex-handle-2',
    now,
  });
  assert.deepEqual(replacement.relation, {
    kind: 'replace',
    previous_conversation_id: conversationOne,
    previous_generation_id: null,
    handoff_sha256: null,
  });
  abortOrFailLive(mcHomeDir, now, generationTwo);

  assert.throws(() => beginRuntimeGenerationSync({
    mcHomeDir,
    mcSessionId,
    generationId: generationThree,
    action: 'switch',
    tool: 'codex',
    launchCwd: '/projects/one',
    previousConversationId: conversationOne,
    handoffSha256: handoffOne,
    now,
  }), (error) => error.reason === 'switch-tool-must-change');
  assert.throws(() => beginRuntimeGenerationSync({
    mcHomeDir,
    mcSessionId,
    generationId: generationThree,
    action: 'resume',
    tool: 'claude',
    launchCwd: '/projects/one',
    resumeConversationId: conversationOne,
    now,
  }), (error) => error.reason === 'resume-tool-mismatch');
});

test('rebuilds a stale projection entirely from the durable journal', () => {
  const mcHomeDir = temporaryHome();
  const now = clock();
  createSession(mcHomeDir);
  begin(mcHomeDir, now);
  acceptRuntimeGenerationSync({ mcHomeDir, mcSessionId, generationId: generationOne, now });
  markRuntimeGenerationLiveSync({ mcHomeDir, mcSessionId, generationId: generationOne, now });
  const paths = sessionHomePaths({ mcHomeDir, mcSessionId });
  const session = readSessionHomeSync({ mcHomeDir, mcSessionId });
  writeFileSync(paths.projectionPath, `${JSON.stringify({
    ...session.projection,
    revision: session.projection.revision + 1,
    runtime_state: 'none',
    active_runtime_generation: null,
    tool: null,
    updated_at: now(),
  })}\n`, { mode: 0o600 });

  const stale = inspectSessionRuntimeSync({ mcHomeDir, mcSessionId });
  assert.equal(stale.projection_matches, false);
  const repaired = rebuildSessionRuntimeProjectionSync({ mcHomeDir, mcSessionId, now });
  assert.equal(repaired.runtime_state, 'running');
  assert.equal(repaired.active_runtime_generation, generationOne);
  assert.equal(inspectSessionRuntimeSync({ mcHomeDir, mcSessionId }).projection_matches, true);
});

test('isolates corrupt session journals and rejects authority or payload-shaped input', () => {
  const mcHomeDir = temporaryHome();
  const now = clock();
  createSession(mcHomeDir);
  createSession(mcHomeDir, otherSessionId, 'healthy-runtime');
  assert.throws(() => beginRuntimeGenerationSync({
    mcHomeDir,
    mcSessionId,
    generationId: generationOne,
    action: 'start',
    tool: 'codex',
    launchCwd: '/projects/one',
    environment: { TOKEN: 'do-not-store' },
    argv: ['--dangerous'],
    transcript: 'do-not-store',
    pty_output: 'do-not-store',
    now,
  }), (error) => error.reason === 'runtime-input-unexpected-keys');
  begin(mcHomeDir, now);
  assert.throws(() => failRuntimeGenerationSync({
    mcHomeDir,
    mcSessionId,
    generationId: generationOne,
    reason: 'do-not-store raw value',
    now,
  }), (error) => error.reason === 'generation-receipt-invalid-fields');

  const paths = sessionHomePaths({ mcHomeDir, mcSessionId });
  const intentPath = join(paths.generationsPath, `${generationOne}.json`);
  const intent = JSON.parse(readFileSync(intentPath, 'utf8'));
  writeFileSync(intentPath, `${JSON.stringify({ ...intent, argv: ['forged'] })}\n`, { mode: 0o600 });
  assert.equal(inspectSessionRuntimeSync({ mcHomeDir, mcSessionId }).reason,
    'generation-intent-generation-intent-unexpected-keys');
  assert.equal(inspectSessionRuntimeSync({ mcHomeDir, mcSessionId: otherSessionId }).kind, 'present');

  assert.equal(validateGenerationIntent({ ...intent, environment: {} }).ok, false);
  assert.equal(validateConversationRecord({ credential: 'forbidden' }).ok, false);
  assert.equal(validateGenerationReceipt({ transcript: 'forbidden' }).ok, false);
  const durableText = readSessionText(paths.home);
  for (const forbidden of ['do-not-store', '--dangerous', 'pty_output', 'transcript']) {
    assert.equal(durableText.includes(forbidden), false);
  }
});

test('can explicitly abort only an unaccepted planned generation', () => {
  const mcHomeDir = temporaryHome();
  const now = clock();
  createSession(mcHomeDir);
  begin(mcHomeDir, now);
  abortRuntimeGenerationSync({
    mcHomeDir,
    mcSessionId,
    generationId: generationOne,
    reason: 'launch-cancelled',
    now,
  });
  assert.equal(inspectSessionRuntimeSync({ mcHomeDir, mcSessionId }).generations[0].phase, 'aborted');
  assert.throws(() => acceptRuntimeGenerationSync({
    mcHomeDir,
    mcSessionId,
    generationId: generationOne,
    now,
  }), (error) => error.reason === 'generation-receipt-invalid-transition');
});

function abortOrFailLive(mcHomeDir, now, generationId) {
  failRuntimeGenerationSync({
    mcHomeDir,
    mcSessionId,
    generationId,
    reason: 'runtime-failure-proven',
    now,
  });
}

function readSessionText(directory) {
  let result = '';
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) result += readSessionText(path);
    if (entry.isFile() && entry.name.endsWith('.json')) result += readFileSync(path, 'utf8');
  }
  return result;
}
