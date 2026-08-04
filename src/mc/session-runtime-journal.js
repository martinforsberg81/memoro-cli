import { randomBytes } from 'node:crypto';
import {
  lstatSync,
  readdirSync,
} from 'node:fs';
import { join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';

import { mcHome } from './paths.js';
import {
  inspectPrivateDirectoryChainSync,
  publishImmutablePrivateJsonSync,
  readPrivateJsonSync,
  replacePrivateJsonSync,
} from './private-state.js';
import { withLocksSync, processIsAlive } from './session-home-lock.js';
import { sessionHomePaths } from './session-home-paths.js';
import {
  SESSION_HOME_VERSION,
  SESSION_PROJECTION_SCHEMA,
  assertMcSessionId,
  assertValid,
  validateIso,
  validateSessionProjection,
} from './session-home-schema.js';
import { readSessionHomeSync } from './session-home.js';
import { readWorkspaceAssociationSync } from './workspace-record.js';
import {
  CONVERSATION_ID_RE,
  GENERATION_ID_RE,
  assertConversationId,
  assertGenerationId,
  mintConversationId,
  mintGenerationId,
} from './session-record-ids.js';
import {
  assertConversationHandle,
  assertSha256,
  assertRuntimeValid,
  assertTool,
  buildConversationRecord,
  buildGenerationIntent,
  buildGenerationReceipt,
  isTerminalGenerationPhase,
  relationForIntent,
  runtimeProjectionState,
  sessionRuntimeError,
  validateConversationRecord,
  validateGenerationIntent,
  validateGenerationReceipt,
  validateReceiptHistory,
} from './session-runtime-schema.js';

export {
  RUNTIME_ACTIONS,
  RUNTIME_RECEIPT_PHASES,
  SESSION_CONVERSATION_SCHEMA,
  SESSION_GENERATION_INTENT_SCHEMA,
  SESSION_GENERATION_RECEIPT_SCHEMA,
  SESSION_RUNTIME_VERSION,
  generationIntentDigest,
  validateConversationRecord,
  validateGenerationIntent,
  validateGenerationReceipt,
} from './session-runtime-schema.js';

export {
  CONVERSATION_ID_RE,
  GENERATION_ID_RE,
  mintConversationId,
  mintGenerationId,
} from './session-record-ids.js';

const RECEIPT_FILE_RE = /^(\d{12})\.json$/u;
const MAX_GENERATIONS = 4096;
const MAX_CONVERSATIONS = 4096;
const MAX_RECEIPTS_PER_GENERATION = 16;

export function beginRuntimeGenerationSync(options = {}) {
  assertOptionKeys(options, [
    'mcHomeDir',
    'mcSessionId',
    'generationId',
    'action',
    'tool',
    'workspaceId',
    'launchCwd',
    'resumeConversationId',
    'previousConversationId',
    'previousGenerationId',
    'replacementReason',
    'handoffSha256',
    'now',
    'random',
    'isAlive',
  ]);
  const {
    mcHomeDir = mcHome(),
    mcSessionId,
    action,
    tool,
    workspaceId = null,
    launchCwd,
    resumeConversationId = null,
    previousConversationId = null,
    previousGenerationId = null,
    replacementReason = null,
    handoffSha256 = null,
    now = () => new Date().toISOString(),
    random = randomBytes,
    isAlive = processIsAlive,
  } = options;
  const generationId = options.generationId || mintGenerationId(random);
  assertMcSessionId(mcSessionId);
  assertGenerationId(generationId);
  assertTool(tool);
  const paths = sessionHomePaths({ mcHomeDir, mcSessionId });

  return withLocksSync([paths.mutationLockPath], {
    trustedRoot: paths.mcHomeDir,
    purpose: 'begin-runtime-generation',
    isAlive,
    random,
  }, () => {
    const session = requireOpenSession(paths.mcHomeDir, mcSessionId);
    const snapshot = requireRuntimeSnapshot(paths.mcHomeDir, mcSessionId);
    if (snapshot.active_generation !== null) {
      throw sessionRuntimeError('live-generation-claim-conflict');
    }
    if (snapshot.generations.some((item) => item.intent.generation_id === generationId)) {
      throw sessionRuntimeError('generation-id-conflict');
    }
    validateRequestedAction({
      snapshot,
      action,
      tool,
      resumeConversationId,
      previousConversationId,
      previousGenerationId,
      replacementReason,
      handoffSha256,
    });
    const recordedAt = validateIso(now());
    const latest = snapshot.generations.at(-1);
    const latestRecordedAt = latest?.receipts.at(-1)?.recorded_at || latest?.intent.recorded_at;
    if (latestRecordedAt && Date.parse(recordedAt) < Date.parse(latestRecordedAt)) {
      throw sessionRuntimeError('generation-time-regression');
    }
    if (workspaceId !== null) {
      const workspace = readWorkspaceAssociationSync({
        mcHomeDir: paths.mcHomeDir,
        mcSessionId,
        workspaceId,
      });
      if (workspace.kind !== 'present') {
        throw sessionRuntimeError(`workspace-${workspace.reason || workspace.kind}`);
      }
    }
    const intent = buildGenerationIntent({
      generationId,
      mcSessionId,
      sequence: snapshot.generations.length + 1,
      action,
      tool,
      workspaceId,
      launchCwd,
      resumeConversationId,
      previousConversationId,
      previousGenerationId,
      replacementReason,
      handoffSha256,
      recordedAt,
    });
    try {
      publishImmutablePrivateJsonSync({
        path: generationIntentPath(paths, generationId),
        value: intent,
        trustedRoot: paths.mcHomeDir,
        random,
      });
    } catch (error) {
      if (error?.code === 'EEXIST') throw sessionRuntimeError('generation-id-conflict');
      throw error;
    }
    const after = requireRuntimeSnapshot(paths.mcHomeDir, mcSessionId);
    writeDerivedProjection({ paths, session, snapshot: after, recordedAt, random });
    return findGeneration(after, generationId);
  });
}

export function acceptRuntimeGenerationSync(options = {}) {
  return appendGenerationPhase(options, {
    name: 'accept-runtime-generation',
    phase: 'accepted',
    allowedKeys: [],
    data: () => ({}),
  });
}

export function markRuntimeGenerationLiveSync(options = {}) {
  return appendGenerationPhase(options, {
    name: 'mark-runtime-generation-live',
    phase: 'live',
    allowedKeys: [],
    data: () => ({}),
  });
}

export function recordRuntimeGenerationExitSync(options = {}) {
  return appendGenerationPhase(options, {
    name: 'record-runtime-generation-exit',
    phase: 'exited',
    allowedKeys: ['exitCode', 'signal'],
    data: ({ exitCode = null, signal = null }) => ({
      exit_code: exitCode,
      signal,
    }),
  });
}

export function failRuntimeGenerationSync(options = {}) {
  return appendGenerationPhase(options, {
    name: 'fail-runtime-generation',
    phase: 'failed',
    allowedKeys: ['reason'],
    data: ({ reason }) => ({ reason }),
  });
}

export function abortRuntimeGenerationSync(options = {}) {
  return appendGenerationPhase(options, {
    name: 'abort-runtime-generation',
    phase: 'aborted',
    allowedKeys: ['reason'],
    data: ({ reason }) => ({ reason }),
  });
}

export function completeRuntimeGenerationSync(options = {}) {
  assertOptionKeys(options, mutationOptionKeys(['conversationId']));
  const {
    mcHomeDir = mcHome(),
    mcSessionId,
    generationId,
    conversationId,
    now = () => new Date().toISOString(),
    random = randomBytes,
    isAlive = processIsAlive,
  } = options;
  assertMcSessionId(mcSessionId);
  assertGenerationId(generationId);
  assertConversationId(conversationId);
  const paths = sessionHomePaths({ mcHomeDir, mcSessionId });

  return withLocksSync([paths.mutationLockPath], {
    trustedRoot: paths.mcHomeDir,
    purpose: 'complete-runtime-generation',
    isAlive,
    random,
  }, () => {
    const session = requireSession(paths.mcHomeDir, mcSessionId);
    const snapshot = requireRuntimeSnapshot(paths.mcHomeDir, mcSessionId);
    const generation = findGeneration(snapshot, generationId);
    const expectedConversationId = effectiveConversationId(snapshot, generation);
    if (expectedConversationId === null) {
      throw sessionRuntimeError('generation-conversation-missing');
    }
    if (conversationId !== expectedConversationId) {
      throw sessionRuntimeError('generation-conversation-conflict');
    }
    return appendPhaseUnderLock({
      paths,
      session,
      snapshot,
      generation,
      phase: 'completed',
      data: { conversation_id: conversationId },
      recordedAt: validateIso(now()),
      random,
    });
  });
}

export function bindRuntimeConversationSync(options = {}) {
  assertOptionKeys(options, [
    'mcHomeDir',
    'mcSessionId',
    'generationId',
    'conversationId',
    'handle',
    'now',
    'random',
    'isAlive',
  ]);
  const {
    mcHomeDir = mcHome(),
    mcSessionId,
    generationId,
    handle,
    now = () => new Date().toISOString(),
    random = randomBytes,
    isAlive = processIsAlive,
  } = options;
  const conversationId = options.conversationId || mintConversationId(random);
  assertMcSessionId(mcSessionId);
  assertGenerationId(generationId);
  assertConversationId(conversationId);
  assertConversationHandle(handle);
  const paths = sessionHomePaths({ mcHomeDir, mcSessionId });

  return withLocksSync([paths.mutationLockPath], {
    trustedRoot: paths.mcHomeDir,
    purpose: 'bind-runtime-conversation',
    isAlive,
    random,
  }, () => {
    const session = requireSession(paths.mcHomeDir, mcSessionId);
    const snapshot = requireRuntimeSnapshot(paths.mcHomeDir, mcSessionId);
    const generation = findGeneration(snapshot, generationId);
    if (generation.intent.action === 'resume') {
      throw sessionRuntimeError('resume-cannot-create-conversation');
    }
    if (generation.phase !== 'live' && generation.phase !== 'exited') {
      throw sessionRuntimeError('conversation-binding-invalid-phase');
    }
    const existingForGeneration = snapshot.conversations.find(
      (item) => item.origin_generation_id === generationId,
    );
    if (existingForGeneration) {
      if (existingForGeneration.tool === generation.intent.tool
        && existingForGeneration.handle === handle) return existingForGeneration;
      throw sessionRuntimeError('generation-conversation-conflict');
    }
    const reusedHandle = snapshot.conversations.find(
      (item) => item.tool === generation.intent.tool && item.handle === handle,
    );
    if (reusedHandle) throw sessionRuntimeError('conversation-handle-conflict');
    if (snapshot.conversations.some((item) => item.conversation_id === conversationId)) {
      throw sessionRuntimeError('conversation-id-conflict');
    }
    const recordedAt = validateIso(now());
    const latestRecordedAt = generation.receipts.at(-1)?.recorded_at
      || generation.intent.recorded_at;
    if (Date.parse(recordedAt) < Date.parse(latestRecordedAt)) {
      throw sessionRuntimeError('conversation-time-regression');
    }
    const conversation = buildConversationRecord({
      conversationId,
      mcSessionId,
      tool: generation.intent.tool,
      handle,
      originGenerationId: generationId,
      relation: relationForIntent(generation.intent),
      recordedAt,
    });
    try {
      publishImmutablePrivateJsonSync({
        path: conversationPath(paths, conversationId),
        value: conversation,
        trustedRoot: paths.mcHomeDir,
        random,
      });
    } catch (error) {
      if (error?.code === 'EEXIST') throw sessionRuntimeError('conversation-id-conflict');
      throw error;
    }
    const after = requireRuntimeSnapshot(paths.mcHomeDir, mcSessionId);
    writeDerivedProjection({ paths, session, snapshot: after, recordedAt, random });
    return after.conversations.find((item) => item.conversation_id === conversationId);
  });
}

/**
 * Publish one bounded historical conversation without pretending that the
 * migrator launched or observed a new tool process. The `imported` receipt is
 * terminal and can only be created by this explicit cutover operation.
 *
 * Every identifier and timestamp is supplied by the immutable migration plan,
 * so a crash after any individual immutable write is safely resumable.
 */
export function importRuntimeConversationSync(options = {}) {
  assertOptionKeys(options, [
    'mcHomeDir',
    'mcSessionId',
    'generationId',
    'conversationId',
    'action',
    'tool',
    'workspaceId',
    'launchCwd',
    'previousConversationId',
    'previousGenerationId',
    'replacementReason',
    'handoffSha256',
    'handle',
    'legacyEvidenceSha256',
    'recordedAt',
    'afterWrite',
    'random',
    'isAlive',
  ]);
  const {
    mcHomeDir = mcHome(),
    mcSessionId,
    generationId,
    conversationId,
    action,
    tool,
    workspaceId = null,
    launchCwd,
    previousConversationId = null,
    previousGenerationId = null,
    replacementReason = null,
    handoffSha256 = null,
    handle,
    legacyEvidenceSha256,
    recordedAt,
    afterWrite = null,
    random = randomBytes,
    isAlive = processIsAlive,
  } = options;
  assertMcSessionId(mcSessionId);
  assertGenerationId(generationId);
  assertConversationId(conversationId);
  assertTool(tool);
  assertConversationHandle(handle);
  assertSha256(legacyEvidenceSha256, 'legacy evidence sha256');
  const timestamp = validateIso(recordedAt);
  const paths = sessionHomePaths({ mcHomeDir, mcSessionId });

  return withLocksSync([paths.mutationLockPath], {
    trustedRoot: paths.mcHomeDir,
    purpose: 'import-runtime-conversation',
    isAlive,
    random,
  }, () => {
    const session = requireOpenSession(paths.mcHomeDir, mcSessionId);
    let snapshot = requireRuntimeSnapshot(paths.mcHomeDir, mcSessionId);
    let generation = snapshot.generations.find(
      (item) => item.intent.generation_id === generationId,
    );
    if (!generation) {
      if (snapshot.active_generation !== null) {
        throw sessionRuntimeError('live-generation-claim-conflict');
      }
      validateRequestedAction({
        snapshot,
        action,
        tool,
        resumeConversationId: null,
        previousConversationId,
        previousGenerationId,
        replacementReason,
        handoffSha256,
      });
      if (workspaceId !== null) {
        const workspace = readWorkspaceAssociationSync({
          mcHomeDir: paths.mcHomeDir,
          mcSessionId,
          workspaceId,
        });
        if (workspace.kind !== 'present') {
          throw sessionRuntimeError(`workspace-${workspace.reason || workspace.kind}`);
        }
      }
      const intent = buildGenerationIntent({
        generationId,
        mcSessionId,
        sequence: snapshot.generations.length + 1,
        action,
        tool,
        workspaceId,
        launchCwd,
        resumeConversationId: null,
        previousConversationId,
        previousGenerationId,
        replacementReason,
        handoffSha256,
        recordedAt: timestamp,
      });
      publishImmutablePrivateJsonSync({
        path: generationIntentPath(paths, generationId),
        value: intent,
        trustedRoot: paths.mcHomeDir,
        random,
      });
      afterWrite?.('intent');
      snapshot = requireRuntimeSnapshot(paths.mcHomeDir, mcSessionId);
      generation = findGeneration(snapshot, generationId);
    }

    const expectedIntent = buildGenerationIntent({
      generationId,
      mcSessionId,
      sequence: generation.intent.sequence,
      action,
      tool,
      workspaceId,
      launchCwd,
      resumeConversationId: null,
      previousConversationId,
      previousGenerationId,
      replacementReason,
      handoffSha256,
      recordedAt: timestamp,
    });
    if (!isDeepStrictEqual(generation.intent, expectedIntent)) {
      throw sessionRuntimeError('import-generation-conflict');
    }

    const expectedConversation = buildConversationRecord({
      conversationId,
      mcSessionId,
      tool,
      handle,
      originGenerationId: generationId,
      relation: relationForIntent(expectedIntent),
      recordedAt: timestamp,
    });
    const currentConversation = snapshot.conversations.find(
      (item) => item.conversation_id === conversationId,
    );
    if (currentConversation && !isDeepStrictEqual(currentConversation, expectedConversation)) {
      throw sessionRuntimeError('import-conversation-conflict');
    }
    if (!currentConversation) {
      const reused = snapshot.conversations.find(
        (item) => item.tool === tool && item.handle === handle,
      );
      if (reused) throw sessionRuntimeError('conversation-handle-conflict');
      publishImmutablePrivateJsonSync({
        path: conversationPath(paths, conversationId),
        value: expectedConversation,
        trustedRoot: paths.mcHomeDir,
        random,
      });
      afterWrite?.('conversation');
      snapshot = requireRuntimeSnapshot(paths.mcHomeDir, mcSessionId);
      generation = findGeneration(snapshot, generationId);
    }

    const expectedReceipt = buildGenerationReceipt({
      ordinal: 1,
      phase: 'imported',
      generationId,
      mcSessionId,
      intentSha256: expectedIntent.intent_sha256,
      recordedAt: timestamp,
      data: {
        conversation_id: conversationId,
        legacy_evidence_sha256: legacyEvidenceSha256,
      },
    });
    if (generation.receipts.length === 0) {
      publishImmutablePrivateJsonSync({
        path: generationReceiptPath(paths, generationId, 1),
        value: expectedReceipt,
        trustedRoot: paths.mcHomeDir,
        random,
      });
      afterWrite?.('receipt');
    } else if (generation.receipts.length !== 1
      || !isDeepStrictEqual(generation.receipts[0], expectedReceipt)) {
      throw sessionRuntimeError('import-receipt-conflict');
    }

    const after = requireRuntimeSnapshot(paths.mcHomeDir, mcSessionId);
    writeDerivedProjection({ paths, session, snapshot: after, recordedAt: timestamp, random });
    afterWrite?.('projection');
    return {
      generation: findGeneration(after, generationId),
      conversation: after.conversations.find((item) => item.conversation_id === conversationId),
    };
  });
}

export function inspectSessionRuntimeSync({ mcHomeDir = mcHome(), mcSessionId } = {}) {
  try {
    assertMcSessionId(mcSessionId);
  } catch {
    return unknown('invalid-session-id');
  }
  let paths;
  try {
    paths = sessionHomePaths({ mcHomeDir, mcSessionId });
  } catch {
    return unknown('invalid-private-root');
  }
  const session = readSessionHomeSync({ mcHomeDir: paths.mcHomeDir, mcSessionId });
  if (session.kind !== 'present') return unknown(`session-${session.reason || session.kind}`);
  for (const [label, directory] of [
    ['conversations', paths.conversationsPath],
    ['generations', paths.generationsPath],
  ]) {
    const safe = inspectPrivateDirectoryChainSync({
      trustedRoot: paths.mcHomeDir,
      directory,
    });
    if (!safe.ok) return unknown(`unsafe-${label}-${safe.reason}`);
  }

  const conversationsRead = readConversations(paths, mcSessionId);
  if (!conversationsRead.ok) return unknown(conversationsRead.reason, conversationsRead.extra);
  const generationsRead = readGenerations(paths, mcSessionId);
  if (!generationsRead.ok) return unknown(generationsRead.reason, generationsRead.extra);
  const validated = validateRuntimeRelationships(
    conversationsRead.values,
    generationsRead.values,
  );
  if (!validated.ok) return unknown(validated.reason, validated.extra);

  const active = validated.generations.filter((item) => !isTerminalGenerationPhase(item.phase));
  if (active.length > 1) return unknown('multiple-live-generation-claims');
  if (active.length === 1
    && active[0].intent.sequence !== validated.generations.length) {
    return unknown('generation-after-live-claim');
  }
  const latest = validated.generations.at(-1) || null;
  const expectedProjection = latest === null
    ? {
      runtime_state: 'none',
      active_runtime_generation: null,
      tool: null,
    }
    : {
      runtime_state: runtimeProjectionState(latest.phase),
      active_runtime_generation: latest.intent.generation_id,
      tool: latest.intent.tool,
    };
  return {
    kind: 'present',
    mc_session_id: mcSessionId,
    conversations: validated.conversations,
    generations: validated.generations,
    active_generation: active[0] || null,
    expected_projection: expectedProjection,
    projection_matches: projectionMatches(session.projection, expectedProjection),
  };
}

export function readRuntimeConversationSync({
  mcHomeDir = mcHome(),
  mcSessionId,
  conversationId,
} = {}) {
  try {
    assertConversationId(conversationId);
  } catch {
    return unknown('invalid-conversation-id');
  }
  const snapshot = inspectSessionRuntimeSync({ mcHomeDir, mcSessionId });
  if (snapshot.kind !== 'present') return snapshot;
  const conversation = snapshot.conversations.find((item) => item.conversation_id === conversationId);
  return conversation ? { kind: 'present', value: conversation } : { kind: 'absent' };
}

export function listRuntimeConversationsSync({ mcHomeDir = mcHome(), mcSessionId } = {}) {
  const snapshot = inspectSessionRuntimeSync({ mcHomeDir, mcSessionId });
  return snapshot.kind === 'present'
    ? { conversations: snapshot.conversations, issues: [] }
    : { conversations: [], issues: [{ reason: snapshot.reason || snapshot.kind }] };
}

export function rebuildSessionRuntimeProjectionSync(options = {}) {
  assertOptionKeys(options, ['mcHomeDir', 'mcSessionId', 'now', 'random', 'isAlive']);
  const {
    mcHomeDir = mcHome(),
    mcSessionId,
    now = () => new Date().toISOString(),
    random = randomBytes,
    isAlive = processIsAlive,
  } = options;
  assertMcSessionId(mcSessionId);
  const paths = sessionHomePaths({ mcHomeDir, mcSessionId });
  return withLocksSync([paths.mutationLockPath], {
    trustedRoot: paths.mcHomeDir,
    purpose: 'rebuild-runtime-projection',
    isAlive,
    random,
  }, () => {
    const session = requireSession(paths.mcHomeDir, mcSessionId);
    const snapshot = requireRuntimeSnapshot(paths.mcHomeDir, mcSessionId);
    return writeDerivedProjection({
      paths,
      session,
      snapshot,
      recordedAt: validateIso(now()),
      random,
    });
  });
}

export function decideSessionRuntimeAction(snapshot, { tool = null } = {}) {
  if (snapshot?.kind !== 'present') {
    return { action: 'manual-repair', reason: snapshot?.reason || 'runtime-state-unavailable' };
  }
  if (tool !== null) assertTool(tool);
  const active = snapshot.active_generation;
  if (active) {
    if (active.phase === 'planned') {
      return { action: 'launch-planned-generation', generation_id: active.intent.generation_id };
    }
    if (active.phase === 'accepted') {
      return { action: 'reconcile-accepted-outcome', generation_id: active.intent.generation_id };
    }
    if (active.phase === 'live') {
      return { action: 'attach', generation_id: active.intent.generation_id };
    }
    const conversationId = effectiveConversationId(snapshot, active);
    return conversationId === null
      ? {
        action: 'resolve-missing-conversation',
        generation_id: active.intent.generation_id,
      }
      : {
        action: 'finalize-exit',
        generation_id: active.intent.generation_id,
        conversation_id: conversationId,
      };
  }
  const latest = snapshot.generations.at(-1) || null;
  if (latest === null) return { action: 'start' };
  if (latest.phase !== 'completed' && latest.phase !== 'imported') {
    // A generation that failed or was aborted bound no conversation, so there
    // is nothing to replace and nothing for the user to decide. Demanding an
    // explicit `--replace` here turned mc's own failed launch into the user's
    // homework: a session whose first launch crashed could never be opened
    // again without a flag, for a conversation that never existed.
    //
    // What survives a failed attempt is whatever conversation the session had
    // before it. Resume that if there is one; otherwise this is a start.
    const previous = lastBoundConversation(snapshot);
    if (previous === null) {
      // A first launch that failed still consumed the session's one `start`,
      // so the next attempt supersedes that generation instead. It replaces
      // nothing a user would miss.
      return {
        action: 'replace-failed-generation',
        previous_generation_id: latest.intent.generation_id,
      };
    }
    if (tool !== null && tool !== previous.tool) {
      return {
        action: 'switch',
        previous_conversation_id: previous.conversation_id,
        source_tool: previous.tool,
        target_tool: tool,
        requires_handoff: true,
      };
    }
    return {
      action: 'resume',
      conversation_id: previous.conversation_id,
      tool: previous.tool,
    };
  }
  const conversationId = latest.receipts.at(-1).data.conversation_id;
  const conversation = snapshot.conversations.find((item) => item.conversation_id === conversationId);
  if (!conversation) return {
    action: 'manual-repair',
    reason: latest.phase === 'imported'
      ? 'imported-conversation-missing'
      : 'completed-conversation-missing',
  };
  if (tool !== null && tool !== conversation.tool) {
    return {
      action: 'switch',
      previous_conversation_id: conversationId,
      source_tool: conversation.tool,
      target_tool: tool,
      requires_handoff: true,
    };
  }
  return {
    action: 'resume',
    conversation_id: conversationId,
    tool: conversation.tool,
  };
}

/**
 * The most recent conversation this session actually bound, independent of
 * whether the generation that produced it is the newest one.
 */
function lastBoundConversation(snapshot) {
  return snapshot.conversations.at(-1) || null;
}

function appendGenerationPhase(options, definition) {
  assertOptionKeys(options, mutationOptionKeys(definition.allowedKeys));
  const {
    mcHomeDir = mcHome(),
    mcSessionId,
    generationId,
    now = () => new Date().toISOString(),
    random = randomBytes,
    isAlive = processIsAlive,
  } = options;
  assertMcSessionId(mcSessionId);
  assertGenerationId(generationId);
  const data = definition.data(options);
  const paths = sessionHomePaths({ mcHomeDir, mcSessionId });
  return withLocksSync([paths.mutationLockPath], {
    trustedRoot: paths.mcHomeDir,
    purpose: definition.name,
    isAlive,
    random,
  }, () => {
    const session = requireSession(paths.mcHomeDir, mcSessionId);
    const snapshot = requireRuntimeSnapshot(paths.mcHomeDir, mcSessionId);
    const generation = findGeneration(snapshot, generationId);
    return appendPhaseUnderLock({
      paths,
      session,
      snapshot,
      generation,
      phase: definition.phase,
      data,
      recordedAt: validateIso(now()),
      random,
    });
  });
}

function appendPhaseUnderLock({
  paths,
  session,
  snapshot,
  generation,
  phase,
  data,
  recordedAt,
  random,
}) {
  const existing = generation.receipts.find((receipt) => receipt.phase === phase);
  if (existing) {
    if (!deepEqual(existing.data, data)) throw sessionRuntimeError('generation-phase-conflict');
    writeDerivedProjection({ paths, session, snapshot, recordedAt, random });
    return generation;
  }
  const receipt = buildGenerationReceipt({
    ordinal: generation.receipts.length + 1,
    phase,
    generationId: generation.intent.generation_id,
    mcSessionId: generation.intent.mc_session_id,
    intentSha256: generation.intent.intent_sha256,
    recordedAt,
    data,
  });
  assertRuntimeValid(validateReceiptHistory(
    generation.intent,
    [...generation.receipts, receipt],
  ));
  try {
    publishImmutablePrivateJsonSync({
      path: generationReceiptPath(paths, generation.intent.generation_id, receipt.ordinal),
      value: receipt,
      trustedRoot: paths.mcHomeDir,
      random,
    });
  } catch (error) {
    if (error?.code === 'EEXIST') throw sessionRuntimeError('generation-receipt-conflict');
    throw error;
  }
  const after = requireRuntimeSnapshot(paths.mcHomeDir, generation.intent.mc_session_id);
  writeDerivedProjection({ paths, session, snapshot: after, recordedAt, random });
  return findGeneration(after, generation.intent.generation_id);
}

function readConversations(paths, mcSessionId) {
  let names;
  try {
    names = readdirSync(paths.conversationsPath).sort();
  } catch {
    return invalid('unreadable-conversations-directory');
  }
  if (names.length > MAX_CONVERSATIONS) return invalid('conversation-limit-exceeded');
  const values = [];
  for (const name of names) {
    const match = /^(mcc_[a-f0-9]{24})\.json$/u.exec(name);
    if (!match) return invalid('unexpected-conversation-entry', { entry: name });
    const read = readPrivateJsonSync({
      path: join(paths.conversationsPath, name),
      trustedRoot: paths.mcHomeDir,
      validate: validateConversationRecord,
    });
    if (read.kind !== 'present') {
      return invalid(`conversation-${read.reason || read.kind}`, { conversation_id: match[1] });
    }
    if (read.value.conversation_id !== match[1]
      || read.value.mc_session_id !== mcSessionId) {
      return invalid('conversation-binding-mismatch', { conversation_id: match[1] });
    }
    values.push(read.value);
  }
  return { ok: true, values };
}

function readGenerations(paths, mcSessionId) {
  let names;
  try {
    names = readdirSync(paths.generationsPath).sort();
  } catch {
    return invalid('unreadable-generations-directory');
  }
  const intentIds = new Set();
  const receiptDirectoryIds = new Set();
  for (const name of names) {
    let stat;
    try { stat = lstatSync(join(paths.generationsPath, name)); } catch {
      return invalid('unreadable-generation-entry', { entry: name });
    }
    const intentMatch = /^(mcg_[a-f0-9]{24})\.json$/u.exec(name);
    if (intentMatch && stat.isFile() && !stat.isSymbolicLink()) {
      intentIds.add(intentMatch[1]);
      continue;
    }
    if (GENERATION_ID_RE.test(name) && stat.isDirectory() && !stat.isSymbolicLink()) {
      receiptDirectoryIds.add(name);
      continue;
    }
    return invalid('unexpected-generation-entry', { entry: name });
  }
  if (intentIds.size > MAX_GENERATIONS) return invalid('generation-limit-exceeded');
  for (const generationId of receiptDirectoryIds) {
    if (!intentIds.has(generationId)) {
      return invalid('generation-receipts-without-intent', { generation_id: generationId });
    }
  }
  const values = [];
  for (const generationId of [...intentIds].sort()) {
    const read = readPrivateJsonSync({
      path: generationIntentPath(paths, generationId),
      trustedRoot: paths.mcHomeDir,
      validate: validateGenerationIntent,
    });
    if (read.kind !== 'present') {
      return invalid(`generation-intent-${read.reason || read.kind}`, { generation_id: generationId });
    }
    if (read.value.generation_id !== generationId
      || read.value.mc_session_id !== mcSessionId) {
      return invalid('generation-intent-binding-mismatch', { generation_id: generationId });
    }
    const receipts = receiptDirectoryIds.has(generationId)
      ? readReceipts(paths, read.value)
      : { ok: true, values: [] };
    if (!receipts.ok) return receipts;
    const history = validateReceiptHistory(read.value, receipts.values);
    if (!history.ok) return invalid(history.reason, { generation_id: generationId });
    values.push({ intent: read.value, receipts: receipts.values, phase: history.value.phase });
  }
  values.sort((left, right) => left.intent.sequence - right.intent.sequence);
  for (let index = 0; index < values.length; index += 1) {
    if (values[index].intent.sequence !== index + 1) {
      return invalid('generation-sequence-gap');
    }
  }
  return { ok: true, values };
}

function readReceipts(paths, intent) {
  const directory = generationReceiptDirectory(paths, intent.generation_id);
  const safe = inspectPrivateDirectoryChainSync({ trustedRoot: paths.mcHomeDir, directory });
  if (!safe.ok) return invalid(`generation-receipts-${safe.reason}`);
  let names;
  try { names = readdirSync(directory).sort(); } catch {
    return invalid('unreadable-generation-receipts');
  }
  if (names.length > MAX_RECEIPTS_PER_GENERATION) {
    return invalid('generation-receipt-limit-exceeded');
  }
  const values = [];
  for (const name of names) {
    const match = RECEIPT_FILE_RE.exec(name);
    if (!match || Number(match[1]) < 1) {
      return invalid('unexpected-generation-receipt-entry', { entry: name });
    }
    const read = readPrivateJsonSync({
      path: join(directory, name),
      trustedRoot: paths.mcHomeDir,
      validate: validateGenerationReceipt,
    });
    if (read.kind !== 'present') {
      return invalid(`generation-receipt-${read.reason || read.kind}`, { entry: name });
    }
    if (read.value.ordinal !== Number(match[1])) {
      return invalid('generation-receipt-filename-mismatch', { entry: name });
    }
    values.push(read.value);
  }
  values.sort((left, right) => left.ordinal - right.ordinal);
  return { ok: true, values };
}

function validateRuntimeRelationships(conversations, generations) {
  const generationById = new Map(generations.map((item) => [item.intent.generation_id, item]));
  const conversationById = new Map();
  const conversationByOrigin = new Map();
  const handles = new Set();
  for (const conversation of conversations) {
    if (conversationById.has(conversation.conversation_id)) {
      return invalid('duplicate-conversation-id');
    }
    const handleKey = `${conversation.tool}\0${conversation.handle}`;
    if (handles.has(handleKey)) return invalid('duplicate-conversation-handle');
    handles.add(handleKey);
    const origin = generationById.get(conversation.origin_generation_id);
    if (!origin) return invalid('conversation-origin-missing');
    if (origin.intent.action === 'resume'
      || origin.intent.tool !== conversation.tool
      || Date.parse(conversation.recorded_at) < Date.parse(origin.intent.recorded_at)
      || !deepEqual(relationForIntent(origin.intent), conversation.relation)) {
      return invalid('conversation-origin-mismatch');
    }
    if (conversationByOrigin.has(conversation.origin_generation_id)) {
      return invalid('multiple-conversations-for-generation');
    }
    conversationById.set(conversation.conversation_id, conversation);
    conversationByOrigin.set(conversation.origin_generation_id, conversation);
  }

  for (const generation of generations) {
    const { intent } = generation;
    if (intent.action === 'start' && intent.sequence !== 1) {
      return invalid('start-generation-not-initial');
    }
    if (intent.action === 'resume') {
      const resumed = conversationById.get(intent.resume_conversation_id);
      if (!resumed || resumed.tool !== intent.tool
        || generationById.get(resumed.origin_generation_id).intent.sequence >= intent.sequence) {
        return invalid('resume-conversation-mismatch');
      }
    }
    if (intent.previous_conversation_id !== null) {
      const previous = conversationById.get(intent.previous_conversation_id);
      if (!previous
        || generationById.get(previous.origin_generation_id).intent.sequence >= intent.sequence) {
        return invalid('previous-conversation-mismatch');
      }
      if (intent.action === 'replace' && previous.tool !== intent.tool) {
        return invalid('replacement-tool-mismatch');
      }
      if (intent.action === 'switch' && previous.tool === intent.tool) {
        return invalid('switch-tool-mismatch');
      }
    }
    if (intent.previous_generation_id !== null) {
      const previous = generationById.get(intent.previous_generation_id);
      if (!previous
        || previous.intent.sequence >= intent.sequence
        || !isTerminalGenerationPhase(previous.phase)
        || previous.phase === 'completed'
        || previous.phase === 'imported') {
        return invalid('previous-generation-mismatch');
      }
    }
    const completion = generation.receipts.find(
      (receipt) => receipt.phase === 'completed' || receipt.phase === 'imported',
    );
    if (completion) {
      const expected = intent.action === 'resume'
        ? intent.resume_conversation_id
        : conversationByOrigin.get(intent.generation_id)?.conversation_id || null;
      if (completion.data.conversation_id !== expected) {
        return invalid('completed-conversation-mismatch');
      }
    }
  }
  return {
    ok: true,
    conversations: [...conversations].sort((left, right) => (
      left.recorded_at.localeCompare(right.recorded_at)
      || left.conversation_id.localeCompare(right.conversation_id)
    )),
    generations,
  };
}

function validateRequestedAction({
  snapshot,
  action,
  tool,
  resumeConversationId,
  previousConversationId,
  previousGenerationId,
  replacementReason,
  handoffSha256,
}) {
  if (action === 'start') {
    if (snapshot.generations.length !== 0 || snapshot.conversations.length !== 0) {
      throw sessionRuntimeError('start-requires-empty-session-runtime');
    }
    return;
  }
  if (action === 'resume') {
    const conversation = snapshot.conversations.find(
      (item) => item.conversation_id === resumeConversationId,
    );
    if (!conversation) throw sessionRuntimeError('resume-conversation-missing');
    if (conversation.tool !== tool) throw sessionRuntimeError('resume-tool-mismatch');
    return;
  }
  if (action === 'replace') {
    if (typeof replacementReason !== 'string' || replacementReason.length === 0) {
      throw sessionRuntimeError('replacement-requires-reason');
    }
    if (previousConversationId !== null) {
      const conversation = snapshot.conversations.find(
        (item) => item.conversation_id === previousConversationId,
      );
      if (!conversation) throw sessionRuntimeError('replacement-conversation-missing');
      if (conversation.tool !== tool) throw sessionRuntimeError('replacement-tool-mismatch');
      return;
    }
    const generation = snapshot.generations.find(
      (item) => item.intent.generation_id === previousGenerationId,
    );
    if (!generation || !isTerminalGenerationPhase(generation.phase)
      || generation.phase === 'completed'
      || generation.phase === 'imported') {
      throw sessionRuntimeError('replacement-generation-unproven');
    }
    return;
  }
  if (action === 'switch') {
    const conversation = snapshot.conversations.find(
      (item) => item.conversation_id === previousConversationId,
    );
    if (!conversation) throw sessionRuntimeError('switch-conversation-missing');
    if (conversation.tool === tool) throw sessionRuntimeError('switch-tool-must-change');
    if (handoffSha256 === null) throw sessionRuntimeError('switch-requires-handoff');
    return;
  }
  throw sessionRuntimeError('unsupported-runtime-action');
}

function writeDerivedProjection({ paths, session, snapshot, recordedAt, random }) {
  const expected = snapshot.expected_projection;
  if (projectionMatches(session.projection, expected)) return session.projection;
  const projection = {
    schema: SESSION_PROJECTION_SCHEMA,
    version: SESSION_HOME_VERSION,
    mc_session_id: session.mc_session_id,
    revision: session.projection.revision + 1,
    lifecycle: session.projection.lifecycle,
    runtime_state: expected.runtime_state,
    active_runtime_generation: expected.active_runtime_generation,
    tool: expected.tool,
    updated_at: recordedAt,
  };
  assertValid(validateSessionProjection(projection));
  replacePrivateJsonSync({
    path: paths.projectionPath,
    value: projection,
    trustedRoot: paths.mcHomeDir,
    random,
  });
  return projection;
}

function effectiveConversationId(snapshot, generation) {
  if (generation.intent.action === 'resume') return generation.intent.resume_conversation_id;
  return snapshot.conversations.find(
    (item) => item.origin_generation_id === generation.intent.generation_id,
  )?.conversation_id || null;
}

function projectionMatches(projection, expected) {
  return projection.runtime_state === expected.runtime_state
    && projection.active_runtime_generation === expected.active_runtime_generation
    && projection.tool === expected.tool;
}

function findGeneration(snapshot, generationId) {
  const generation = snapshot.generations.find(
    (item) => item.intent.generation_id === generationId,
  );
  if (!generation) throw sessionRuntimeError('generation-missing');
  return generation;
}

function requireRuntimeSnapshot(mcHomeDir, mcSessionId) {
  const snapshot = inspectSessionRuntimeSync({ mcHomeDir, mcSessionId });
  if (snapshot.kind !== 'present') throw sessionRuntimeError(snapshot.reason || snapshot.kind);
  return snapshot;
}

function requireSession(mcHomeDir, mcSessionId) {
  const session = readSessionHomeSync({ mcHomeDir, mcSessionId });
  if (session.kind !== 'present') throw sessionRuntimeError(`session-${session.reason || session.kind}`);
  return session;
}

function requireOpenSession(mcHomeDir, mcSessionId) {
  const session = requireSession(mcHomeDir, mcSessionId);
  if (session.projection.lifecycle !== 'open') throw sessionRuntimeError('session-archived');
  return session;
}

function generationIntentPath(paths, generationId) {
  return join(paths.generationsPath, `${generationId}.json`);
}

function generationReceiptDirectory(paths, generationId) {
  return join(paths.generationsPath, generationId);
}

function generationReceiptPath(paths, generationId, ordinal) {
  return join(
    generationReceiptDirectory(paths, generationId),
    `${String(ordinal).padStart(12, '0')}.json`,
  );
}

function conversationPath(paths, conversationId) {
  return join(paths.conversationsPath, `${conversationId}.json`);
}

function mutationOptionKeys(extra) {
  return [
    'mcHomeDir',
    'mcSessionId',
    'generationId',
    ...extra,
    'now',
    'random',
    'isAlive',
  ];
}

function assertOptionKeys(options, allowed) {
  const permitted = new Set(allowed);
  const unexpected = Object.keys(options).filter((key) => !permitted.has(key));
  if (unexpected.length > 0) throw sessionRuntimeError('runtime-input-unexpected-keys');
}

function deepEqual(left, right) {
  return isDeepStrictEqual(left, right);
}

function invalid(reason, extra = {}) {
  return { ok: false, reason, extra };
}

function unknown(reason, extra = {}) {
  return { kind: 'unknown', reason, ...extra };
}
