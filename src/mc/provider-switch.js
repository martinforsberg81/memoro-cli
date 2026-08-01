import { hostname } from 'node:os';
import { createHash, randomUUID } from 'node:crypto';

import { resolveToolInput } from '../adapters/index.js';
import { readConfig, getApiUrl } from '../lib/config.js';
import { derivePublicRepoRef, deriveRepoName, getRepoContext } from '../lib/git-context.js';
import {
  patchProviderSessionSequenceIfPresent,
  providerSessionFor,
  upsertEntry,
  withProviderSession,
} from './registry.js';
import {
  inspectManagedProviderHandoffSource,
  MANAGED_PROVIDER_HANDOFF_SOURCE_SCHEMA,
} from './managed-provider-registry.js';
import { resolveBootstrapIdentity } from './connections/identity.js';
import {
  buildSessionHeartbeatPayload,
  postHeartbeatWithRetry,
  sourceForTool,
} from './broker/session-sidecars.js';
import { requestBroker } from './broker/client.js';
import {
  ensureSessionHostRunning,
  requestForSession,
} from './broker/session-hosts.js';
import {
  providerArtifactPath,
  sessionHostPaths,
} from './broker/paths.js';
import { readProviderArtifactSync } from './broker/provider-artifact-journal.js';
import {
  buildHandoffSwitchJournal,
  readHandoffSwitchJournalSync,
} from './broker/handoff-switch-journal.js';
import { mcHome } from './paths.js';
import { resolveSessionSourceIdentity } from './session-projector.js';
import { buildDeterministicHandoff } from './handoff-candidate.js';
import {
  fetchStrictHandoffContext,
  persistSessionHandoff,
  renderHandoffUserMessage,
} from './handoff-client.js';
import {
  deriveHandoffControllerCapability,
  deriveHandoffControllerRoot,
  handoffControllerCapabilityDigest,
  matchesHandoffControllerCapability,
} from './handoff-controller-capability.js';

const HANDOFF_ALREADY_PERSISTED_PHASES = new Set([
  'handoff_persisted',
  'target_launch_started',
  'delivery_acknowledged',
  'consumed_committed',
  'complete',
]);

export async function prepareProviderSwitch({
  entry,
  targetTool,
  targetCustody = 'native',
  localPresence,
  apiArgv = [],
  env = process.env,
  deps = {},
} = {}) {
  const sourceTool = resolveToolInput(entry?.tool);
  if (!sourceTool || !targetTool || sourceTool.id === targetTool.id) {
    return failure('handoff-switch-tools-invalid');
  }
  const codingSessionId = exact(entry?.coding_session_id);
  if (!codingSessionId) return failure('handoff-source-not-exited');
  const sourceProvider = providerSessionFor(entry, sourceTool.id);
  const sourceGeneration = exact(sourceProvider?.runtime_generation);
  const sourceProof = await proveProviderSwitchSource({
    entry,
    sourceTool,
    sourceProvider,
    deps,
  });
  if (!sourceProof.ok || !sourceGeneration) {
    return failure('handoff-source-artifact-unconfirmed');
  }
  if (!['native', 'managed'].includes(targetCustody)) {
    return failure('handoff-target-custody-invalid');
  }
  let sourceSession = localPresence.session
    || durableExitedSource({ sourceTool, sourceGeneration, localPresence, deps });
  const sourceCursor = providerCursor(sourceProvider);
  const targetCursor = providerCursor(providerSessionFor(entry, targetTool.id));
  if (sourceCursor === null || targetCursor === null) {
    return failure('handoff-provider-cursor-invalid');
  }
  const auth = await resolveSwitchIdentity({ apiArgv, env, deps });
  if (!auth.ok) return auth;
  const controllerRoot = deriveHandoffControllerRoot({
    token: auth.token,
    codingSessionId,
  });
  if (!controllerRoot) {
    return failure('handoff-controller-capability-unavailable');
  }

  const journalAccess = await resolveSwitchJournalAccess({
    entry,
    localPresence,
    sessionControllerCapability: controllerRoot,
    ensureWhenAbsent: true,
    deps,
  });
  if (journalAccess.inactive) {
    return failure('handoff-switch-journal-unavailable');
  }
  if (!journalAccess.ok) return journalAccess;
  const { brokerRequest, existing } = journalAccess;
  if (existing?.ok !== true) return failure('handoff-switch-journal-unavailable');
  let auditedSourceContext = null;
  if (!existing.journal) {
    const audit = await auditMissingSwitchJournal({
      entry,
      localPresence,
      auth,
      includeContext: true,
      deps,
    });
    if (!audit.ok) return audit;
    auditedSourceContext = audit.sourceContext || null;
  }
  if (existing.journal && existing.journal.phase !== 'complete') {
    return recoverProviderSwitch({
      entry,
      targetTool,
      targetCustody,
      localPresence,
      apiArgv,
      env,
      deps,
    });
  }
  const repoContext = await (deps.getRepoContext || getRepoContext)(entry.worktree_path);
  if (!repoContext) return failure('handoff-workspace-unavailable');
  if (localPresence?.verdict !== 'exited'
    || !sourceSession || exact(sourceSession.runtime_generation) !== sourceGeneration
    || exact(localPresence.runtime_generation) !== sourceGeneration
    || sourceForTool(sourceSession.tool) !== sourceTool.id
    || !safeId(sourceSession.source_id)) {
    return failure('handoff-source-runtime-unconfirmed');
  }

  const sourceContext = auditedSourceContext || await (
    deps.fetchStrictHandoffContext || fetchStrictHandoffContext
  )({
    apiUrl: auth.apiUrl,
    token: auth.token,
    codingSessionId,
    consumedSequence: sourceCursor,
    repo: derivePublicRepoRef(repoContext) || deriveRepoName(repoContext),
    tool: sourceTool.id,
    sessionName: entry.name,
    branch: repoContext.branch,
    memoroFetch: deps.memoroFetch,
  });
  if (!sourceContext.ok || sourceContext.handoffs.length !== 0
    || sourceContext.continuity.latestSequence !== sourceCursor) {
    return failure(sourceContext.code || 'handoff-source-cursor-uncommitted');
  }

  const source = {
    kind: 'local',
    id: sourceSession.source_id,
    tool: sourceTool.id,
    runtimeGeneration: sourceGeneration,
  };
  const candidate = await (deps.buildDeterministicHandoff || buildDeterministicHandoff)({
    entry,
    source,
    sequence: sourceContext.continuity.latestSequence + 1,
    parentDigest: sourceContext.continuity.latestDigest,
    cwd: entry.worktree_path,
    repoContext,
    deps: deps.candidateDeps || deps,
  });
  if (!candidate.ok) return candidate;
  const now = deps.now || (() => new Date().toISOString());
  const transactionId = (deps.randomUUID || randomUUID)();
  const controllerCapability = controllerCapabilityFor({
    root: controllerRoot,
    transactionId,
  });
  const controllerRootDigest = handoffControllerCapabilityDigest(controllerRoot);
  const controllerCapabilityDigest = handoffControllerCapabilityDigest(
    controllerCapability,
  );
  if (!controllerRoot || !controllerRootDigest
    || !controllerCapability || !controllerCapabilityDigest) {
    return failure('handoff-controller-capability-unavailable');
  }
  let journal;
  try {
    journal = buildHandoffSwitchJournal({
      transactionId,
      codingSessionId,
      phase: 'prepared',
      targetTool: targetTool.id,
      targetCustody,
      controllerRootDigest,
      controllerCapabilityDigest,
      controllerRoot,
      sourceCursor,
      targetCursor,
      handoff: candidate.handoff,
      updatedAt: isoNow(now),
    });
  } catch {
    return failure('handoff-switch-journal-invalid');
  }
  const begun = await brokerRequest({
    type: 'handoff_switch_begin',
    id: codingSessionId,
    journal,
    controller_capability: controllerCapability,
  }).catch(() => null);
  if (begun?.ok !== true) return failure(begun?.reason || 'handoff-switch-begin-failed');

  return continueProviderSwitch({
    entry,
    targetTool,
    sourceTool,
    sourceSession,
    repoContext,
    auth,
    brokerRequest: bindControllerCapability(
      brokerRequest,
      controllerCapability,
      controllerRoot,
    ),
    journal: begun.journal,
    controllerCapability,
    sessionControllerCapability: controllerRoot,
    deps,
  });
}

async function auditMissingSwitchJournal({
  entry,
  localPresence,
  auth,
  includeContext = false,
  allowUnavailableCapability = false,
  deps = {},
} = {}) {
  const sourceTool = resolveToolInput(entry?.tool);
  const sourceProvider = providerSessionFor(entry, sourceTool?.id);
  const sourceCursor = providerCursor(sourceProvider);
  if (!sourceTool || !exact(sourceProvider?.session_id)
    || !exact(sourceProvider?.runtime_generation) || sourceCursor === null) {
    return { ok: true, active: false };
  }
  if (sourceCursor > 0) {
    return failure('handoff-switch-journal-integrity-lost');
  }
  if (localPresence?.verdict !== 'exited') {
    return { ok: true, active: false };
  }
  const repoContext = await (deps.getRepoContext || getRepoContext)(
    entry.worktree_path,
  );
  if (!repoContext) return failure('handoff-switch-journal-audit-unavailable');
  const context = await (deps.fetchStrictHandoffContext
    || fetchStrictHandoffContext)({
    apiUrl: auth.apiUrl,
    token: auth.token,
    codingSessionId: entry.coding_session_id,
    consumedSequence: sourceCursor,
    repo: derivePublicRepoRef(repoContext) || deriveRepoName(repoContext),
    tool: sourceTool.id,
    sessionName: entry.name,
    branch: repoContext.branch,
    memoroFetch: deps.memoroFetch,
  });
  if (!context.ok) {
    if (context.code === 'handoff-capability-unavailable') {
      return allowUnavailableCapability
        ? {
            ok: true,
            active: false,
            handoffCapability: 'unavailable',
          }
        : failure('handoff-capability-unavailable');
    }
    return failure('handoff-switch-journal-audit-unavailable');
  }
  if (context.handoffs.length > 0) {
    return failure('handoff-switch-journal-integrity-lost');
  }
  const latestSequence = context.continuity?.latestSequence;
  if (!Number.isSafeInteger(latestSequence) || latestSequence < 0) {
    return failure('handoff-switch-journal-audit-unavailable');
  }
  return latestSequence > 0
    ? failure('handoff-switch-journal-integrity-lost')
    : {
        ok: true,
        active: false,
        ...(includeContext ? { sourceContext: context } : {}),
      };
}

/**
 * Resume an already journaled switch without replaying a broker-acknowledged
 * user turn. This is deliberately safe to call from a plain `mc open`: no
 * journal means no action, while an active journal supplies the exact target.
 */
export async function recoverProviderSwitch({
  entry,
  targetTool = null,
  targetCustody = 'native',
  localPresence = null,
  apiArgv = [],
  env = process.env,
  deps = {},
} = {}) {
  const codingSessionId = exact(entry?.coding_session_id);
  if (!codingSessionId) return { ok: true, active: false };
  const sourceTool = resolveToolInput(entry?.tool);
  const sameProviderResume = Boolean(sourceTool)
    && (!targetTool || targetTool.id === sourceTool.id);
  const auth = await resolveSwitchIdentity({ apiArgv, env, deps });
  if (!auth.ok) return auth;
  const controllerRoot = deriveHandoffControllerRoot({
    token: auth.token,
    codingSessionId,
  });
  if (!controllerRoot) {
    return failure('handoff-controller-capability-unavailable');
  }
  const journalAccess = await resolveSwitchJournalAccess({
    entry,
    localPresence,
    sessionControllerCapability: controllerRoot,
    deps,
  });
  if (journalAccess.inactive) {
    return auditMissingSwitchJournal({
      entry,
      localPresence,
      auth,
      allowUnavailableCapability: sameProviderResume,
      deps,
    });
  }
  if (!journalAccess.ok) return journalAccess;
  const { brokerRequest: rawBrokerRequest, existing } = journalAccess;
  const journal = existing.journal;
  if (!journal) {
    return auditMissingSwitchJournal({
      entry,
      localPresence,
      auth,
      allowUnavailableCapability: sameProviderResume,
      deps,
    });
  }
  if (journal.phase === 'complete') {
    return { ok: true, active: false, journal };
  }
  const journalTargetCustody = journal.target_custody || 'native';
  if (!['native', 'managed'].includes(targetCustody)
    || journalTargetCustody !== targetCustody) {
    return failure('handoff-target-custody-conflict');
  }

  const recoveredTargetTool = resolveToolInput(journal.target_tool);
  const journalSourceTool = resolveToolInput(journal.handoff?.source?.tool);
  if (!recoveredTargetTool || !journalSourceTool
    || recoveredTargetTool.id === journalSourceTool.id
    || (targetTool && targetTool.id !== recoveredTargetTool.id)) {
    return failure('handoff-switch-journal-conflict');
  }
  const sourceProvider = providerSessionFor(entry, journalSourceTool.id);
  const sourceGeneration = exact(sourceProvider?.runtime_generation);
  const sourceProof = await proveProviderSwitchSource({
    entry,
    sourceTool: journalSourceTool,
    sourceProvider,
    deps,
  });
  if (!sourceProof.ok || !sourceGeneration
    || sourceGeneration !== journal.handoff?.source?.runtime_generation) {
    return failure('handoff-source-artifact-unconfirmed');
  }
  const sourceCursor = providerCursor(sourceProvider);
  const targetCursor = providerCursor(providerSessionFor(entry, recoveredTargetTool.id));
  if (sourceCursor === null || targetCursor === null) {
    return failure('handoff-provider-cursor-invalid');
  }
  const sourceSession = {
    runtime_generation: journal.handoff.source.runtime_generation,
    source_id: journal.handoff.source.id,
    source_kind: journal.handoff.source.kind,
    tool: journal.handoff.source.tool,
  };
  if (!safeId(sourceSession.source_id)) {
    return failure('handoff-switch-journal-conflict');
  }
  const controllerCapability = controllerCapabilityFor({
    root: controllerRoot,
    transactionId: journal.transaction_id,
  });
  if (!matchesHandoffControllerCapability(
    controllerRoot,
    journal.controller_root_digest,
  ) || !matchesHandoffControllerCapability(
    controllerCapability,
    journal.controller_capability_digest,
  )) {
    return failure('handoff-controller-capability-unavailable');
  }
  const brokerRequest = bindControllerCapability(
    rawBrokerRequest,
    controllerCapability,
    controllerRoot,
  );

  if (['delivery_acknowledged', 'consumed_committed'].includes(journal.phase)) {
    if (!recoveryCursorMatches({
      journal,
      sourceCursor,
      targetCursor,
      deliveryAcknowledged: true,
    })) {
      return failure('handoff-switch-journal-conflict');
    }
    const exactLiveTarget = localPresence?.verdict === 'live'
      && exact(localPresence.runtime_generation) === journal.target_runtime_generation
      && sourceForTool(localPresence.session?.tool) === recoveredTargetTool.id;
    const exactExitedTarget = localPresence?.verdict === 'exited'
      && exact(localPresence.runtime_generation) === journal.target_runtime_generation;
    if (localPresence && !exactLiveTarget && !exactExitedTarget) {
      return failure('handoff-target-runtime-unconfirmed');
    }
    return {
      ok: true,
      active: true,
      recoveredDelivery: true,
      targetTool: recoveredTargetTool,
      brokerSocketPath: (deps.sessionHostPaths || sessionHostPaths)(codingSessionId).socketPath,
      transaction: transactionProjection(journal, {
        controllerCapability,
        sessionControllerCapability: controllerRoot,
      }),
      journal,
    };
  }
  if (journal.phase === 'target_launch_started'
    && journal.target_runtime_generation) {
    if (!recoveryCursorMatches({ journal, sourceCursor, targetCursor })) {
      return failure('handoff-switch-journal-conflict');
    }
    const exactLiveTarget = localPresence?.verdict === 'live'
      && exact(localPresence.runtime_generation) === journal.target_runtime_generation
      && sourceForTool(localPresence.session?.tool) === recoveredTargetTool.id;
    const code = exactLiveTarget
      ? 'handoff-delivery-in-progress'
      : 'handoff-delivery-ambiguous';
    await recordSwitchDiagnostic({
      brokerRequest,
      codingSessionId: entry.coding_session_id,
      transactionId: journal.transaction_id,
      code,
      now: deps.now,
    });
    return failure(code);
  }

  const repoContext = await (deps.getRepoContext || getRepoContext)(entry.worktree_path);
  if (!repoContext) return failure('handoff-workspace-unavailable');
  const recovered = await recoverPreparedProviderSwitch({
    entry,
    targetTool: recoveredTargetTool,
    sourceTool: journalSourceTool,
    sourceSession,
    sourceCursor,
    targetCursor,
    journal,
    repoContext,
    auth,
    brokerRequest,
    controllerCapability,
    sessionControllerCapability: controllerRoot,
    localPresence,
    deps,
  });
  return recovered.ok
    ? {
        ...recovered,
        active: true,
        targetTool: recoveredTargetTool,
        brokerSocketPath: (deps.sessionHostPaths || sessionHostPaths)(codingSessionId).socketPath,
      }
    : recovered;
}

export async function commitProviderSwitchDelivery({
  entry,
  targetTool,
  transaction,
  targetCustody = transaction?.target_custody || 'native',
  sessionControllerCapability,
  brokerSocketPath = null,
  deps = {},
} = {}) {
  const sessionControllerRoot = sessionControllerCapability
    || transaction?.session_controller_capability;
  if (!entry?.name || !targetTool?.id || !transaction?.transaction_id
    || transaction.target_tool !== targetTool.id
    || !handoffControllerCapabilityDigest(transaction.controller_capability)
    || !handoffControllerCapabilityDigest(sessionControllerRoot)
    || transaction.require_target_artifact !== true
    || (transaction.target_custody || 'native') !== targetCustody
    || !['native', 'managed'].includes(targetCustody)
    || !Number.isSafeInteger(transaction.target_latest_sequence)) {
    return failure('handoff-delivery-commit-input-invalid');
  }
  const request = deps.brokerRequest || (
    (message) => (deps.requestBroker || requestBroker)(
      message,
      brokerSocketPath ? { socketPath: brokerSocketPath } : undefined,
    )
  );
  const current = await request({
    type: 'handoff_switch_read',
    id: entry.coding_session_id,
    session_controller_capability: sessionControllerRoot,
  }).catch(() => null);
  if (current?.ok !== true
    || current.journal?.transaction_id !== transaction.transaction_id
    || current.journal?.target_tool !== targetTool.id
    || (current.journal?.target_custody || 'native') !== targetCustody
    || !matchesHandoffControllerCapability(
      transaction.controller_capability,
      current.journal?.controller_capability_digest,
    )
    || current.journal?.target_latest_sequence !== transaction.target_latest_sequence
    || !['delivery_acknowledged', 'consumed_committed', 'complete'].includes(
      current.journal?.phase,
  )) {
    return failure('handoff-delivery-proof-unavailable');
  }
  const artifactResult = (deps.readProviderArtifact || readProviderArtifactSync)({
    path: providerArtifactPath(
      entry.coding_session_id,
      current.journal.target_runtime_generation,
    ),
    codingSessionId: entry.coding_session_id,
    runtimeGeneration: current.journal.target_runtime_generation,
    trustedRoot: (deps.mcHome || mcHome)(),
  });
  if (artifactResult?.kind === 'present'
    && artifactResult.artifact?.tool !== targetTool.id) {
    return failure('handoff-target-artifact-conflict');
  }
  if (artifactResult?.kind === 'unknown') {
    return failure('handoff-target-artifact-unconfirmed');
  }
  if (artifactResult?.kind !== 'present') {
    return failure('handoff-target-artifact-unconfirmed');
  }
  const commitCursor = deps.patchProviderSessionSequenceIfPresent
    || patchProviderSessionSequenceIfPresent;
  const committed = commitCursor(
    entry.session_id || entry.name,
    targetTool.id,
    transaction.target_latest_sequence,
  );
  if (!committed?.ok) return failure(committed?.reason || 'handoff-cursor-commit-failed');
  let committedEntry = committed.entry;
  if (artifactResult?.kind === 'present') {
    const providerPatch = withProviderSession(
      committedEntry,
      targetTool.id,
      {
        session_id: artifactResult.artifact.provider_session_id,
        transcript_path: targetCustody === 'managed'
          ? null
          : artifactResult.artifact.transcript_path,
        runtime_generation: artifactResult.artifact.runtime_generation,
      },
    );
    if (!providerPatch.ok) {
      return failure(providerPatch.reason || 'handoff-target-artifact-invalid');
    }
    committedEntry = {
      ...committedEntry,
      provider_sessions: providerPatch.providerSessions,
    };
  }
  let journal = current.journal;
  if (journal.phase === 'delivery_acknowledged') {
    const advanced = await advance(request, {
      id: entry.coding_session_id,
      transactionId: transaction.transaction_id,
      expectedPhase: 'delivery_acknowledged',
      nextPhase: 'consumed_committed',
      controllerCapability: transaction.controller_capability,
      now: deps.now,
    });
    if (!advanced.ok) return advanced;
    journal = advanced.journal;
  }
  const upsert = deps.upsertEntry || upsertEntry;
  const toolPatch = {
    name: entry.name,
    ...(entry.session_id ? { session_id: entry.session_id } : {}),
    ...(entry.repository_id ? { repository_id: entry.repository_id } : {}),
    tool: targetTool.shortName,
    tool_session_id: null,
    tool_session_source: null,
    tool_transcript_path: null,
    tool_session_provider_adapter: null,
    tool_session_provider_generation: null,
    ...(committedEntry?.provider_sessions
      ? { provider_sessions: committedEntry.provider_sessions }
      : {}),
  };
  let switchedEntry;
  try {
    switchedEntry = upsert(toolPatch);
  } catch {
    return failure('handoff-tool-switch-commit-failed');
  }
  if (journal.phase === 'consumed_committed') {
    const completed = await advance(request, {
      id: entry.coding_session_id,
      transactionId: transaction.transaction_id,
      expectedPhase: 'consumed_committed',
      nextPhase: 'complete',
      controllerCapability: transaction.controller_capability,
      now: deps.now,
    });
    if (!completed.ok) return completed;
    journal = completed.journal;
  }
  return {
    ok: true,
    entry: { ...committedEntry, ...toolPatch, ...(switchedEntry || {}) },
    journal,
  };
}

async function recoverPreparedProviderSwitch({
  entry,
  targetTool,
  sourceTool,
  sourceSession,
  sourceCursor,
  targetCursor,
  journal,
  repoContext,
  auth,
  brokerRequest,
  controllerCapability,
  sessionControllerCapability,
  localPresence = null,
  deps,
}) {
  if (journal.coding_session_id !== entry.coding_session_id
    || journal.target_tool !== targetTool.id
    || journal.handoff?.source?.tool !== sourceTool.id
    || journal.handoff?.source?.runtime_generation !== sourceSession.runtime_generation
    || !recoveryCursorMatches({ journal, sourceCursor, targetCursor })) {
    return failure('handoff-switch-journal-conflict');
  }
  if (journal.phase === 'target_launch_started') {
    if (journal.target_runtime_generation) {
      const exactLiveTarget = localPresence?.verdict === 'live'
        && exact(localPresence.runtime_generation) === journal.target_runtime_generation
        && sourceForTool(localPresence.session?.tool) === targetTool.id;
      const code = exactLiveTarget
        ? 'handoff-delivery-in-progress'
        : 'handoff-delivery-ambiguous';
      await recordSwitchDiagnostic({
        brokerRequest,
        codingSessionId: entry.coding_session_id,
        transactionId: journal.transaction_id,
        code,
        now: deps.now,
      });
      return failure(code);
    }
    const sourceCommitted = (deps.patchProviderSessionSequenceIfPresent
      || patchProviderSessionSequenceIfPresent)(
      entry.session_id || entry.name,
      sourceTool.id,
      journal.persisted.sequence,
    );
    if (!sourceCommitted?.ok) {
      return failure(sourceCommitted?.reason || 'handoff-source-cursor-commit-failed');
    }
    const targetContext = await (deps.fetchStrictHandoffContext
      || fetchStrictHandoffContext)({
      apiUrl: auth.apiUrl,
      token: auth.token,
      codingSessionId: entry.coding_session_id,
      consumedSequence: journal.target_cursor,
      repo: derivePublicRepoRef(repoContext) || deriveRepoName(repoContext),
      tool: targetTool.id,
      sessionName: entry.name,
      branch: repoContext.branch,
      memoroFetch: deps.memoroFetch,
    });
    if (!targetContext.ok
      || targetContext.continuity.latestSequence !== journal.target_latest_sequence
      || targetContext.handoffs.length < 1) {
      return failure(targetContext.code || 'handoff-target-context-invalid');
    }
    const rendered = (deps.renderHandoffUserMessage || renderHandoffUserMessage)(
      targetContext.handoffs,
    );
    if (rendered.ok
      && digestText(rendered.message) !== journal.target_message_digest) {
      return failure('handoff-target-message-mismatch');
    }
    return rendered.ok
      ? {
          ok: true,
          entry: sourceCommitted.entry,
          journal,
          message: rendered.message,
          transaction: transactionProjection(journal, {
            controllerCapability,
            sessionControllerCapability,
          }),
        }
      : rendered;
  }
  if (['delivery_acknowledged', 'consumed_committed'].includes(journal.phase)) {
    const exactLiveTarget = localPresence?.verdict === 'live'
      && exact(localPresence.runtime_generation) === journal.target_runtime_generation
      && sourceForTool(localPresence.session?.tool) === targetTool.id;
    const exactExitedTarget = localPresence?.verdict === 'exited'
      && exact(localPresence.runtime_generation) === journal.target_runtime_generation;
    if (localPresence && !exactLiveTarget && !exactExitedTarget) {
      return failure('handoff-target-runtime-unconfirmed');
    }
    return {
      ok: true,
      recoveredDelivery: true,
      transaction: transactionProjection(journal, {
        controllerCapability,
        sessionControllerCapability,
      }),
      journal,
    };
  }
  return continueProviderSwitch({
    entry,
    targetTool,
    sourceTool,
    sourceSession,
    repoContext,
    auth,
    brokerRequest,
    journal,
    controllerCapability,
    sessionControllerCapability,
    deps,
  });
}

async function continueProviderSwitch({
  entry,
  targetTool,
  sourceTool,
  sourceSession,
  repoContext,
  auth,
  brokerRequest,
  journal,
  controllerCapability,
  sessionControllerCapability,
  deps,
}) {
  let current = journal;
  let fencePublished = false;
  if (current.phase === 'prepared') {
    const removed = await brokerRequest({
      type: 'remove_session',
      id: entry.coding_session_id,
    }).catch(() => null);
    if (removed?.ok !== true) return failure(removed?.reason || 'handoff-source-finalization-failed');
    const sealed = await publishTerminalFence({
      entry,
      sourceTool,
      sourceSession,
      repoContext,
      auth,
      deps,
    });
    if (!sealed.ok) return sealed;
    fencePublished = true;
    const advanced = await advance(brokerRequest, {
      id: entry.coding_session_id,
      transactionId: current.transaction_id,
      expectedPhase: 'prepared',
      nextPhase: 'source_terminal_confirmed',
      now: deps.now,
    });
    if (!advanced.ok) return advanced;
    current = advanced.journal;
  }
  if (current.phase === 'source_terminal_confirmed') {
    // The server proves terminality from a heartbeat that expires. The journal
    // phase records that we established it once; it cannot keep it true. A
    // switch that stalls past the heartbeat TTL — a rejected handoff, an
    // offline laptop — would otherwise be wedged forever, because the fence is
    // only published while leaving 'prepared' and this phase never returns
    // there. Re-publish before every attempt: the source generation is already
    // terminal, so restating it is idempotent and cannot revive the provider.
    if (!fencePublished) {
      const resealed = await publishTerminalFence({
        entry,
        sourceTool,
        sourceSession,
        repoContext,
        auth,
        deps,
      });
      if (!resealed.ok) return resealed;
      fencePublished = true;
    }
    const persisted = await (deps.persistSessionHandoff || persistSessionHandoff)({
      apiUrl: auth.apiUrl,
      token: auth.token,
      handoff: current.handoff,
      memoroFetch: deps.memoroFetch,
    });
    if (!persisted.ok) return persisted;
    const advanced = await advance(brokerRequest, {
      id: entry.coding_session_id,
      transactionId: current.transaction_id,
      expectedPhase: 'source_terminal_confirmed',
      nextPhase: 'handoff_persisted',
      patch: {
        persisted: {
          sequence: persisted.sequence,
          digest: persisted.digest,
        },
      },
      now: deps.now,
    });
    if (!advanced.ok) return advanced;
    current = advanced.journal;
  }
  if (current.phase !== 'handoff_persisted') {
    return failure('handoff-switch-phase-invalid');
  }
  const commitCursor = deps.patchProviderSessionSequenceIfPresent
    || patchProviderSessionSequenceIfPresent;
  const sourceCommitted = commitCursor(
    entry.session_id || entry.name,
    sourceTool.id,
    current.persisted.sequence,
  );
  if (!sourceCommitted?.ok) {
    return failure(sourceCommitted?.reason || 'handoff-source-cursor-commit-failed');
  }
  const targetContext = await (deps.fetchStrictHandoffContext || fetchStrictHandoffContext)({
    apiUrl: auth.apiUrl,
    token: auth.token,
    codingSessionId: entry.coding_session_id,
    consumedSequence: current.target_cursor,
    repo: derivePublicRepoRef(repoContext) || deriveRepoName(repoContext),
    tool: targetTool.id,
    sessionName: entry.name,
    branch: repoContext.branch,
    memoroFetch: deps.memoroFetch,
  });
  if (!targetContext.ok
    || targetContext.continuity.latestSequence < current.persisted.sequence
    || targetContext.handoffs.length < 1) {
    return failure(targetContext.code || 'handoff-target-context-invalid');
  }
  const rendered = (deps.renderHandoffUserMessage || renderHandoffUserMessage)(
    targetContext.handoffs,
  );
  if (!rendered.ok) return rendered;
  const targetMessageDigest = digestText(rendered.message);
  if (current.target_latest_sequence !== targetContext.continuity.latestSequence
    || current.target_message_digest !== targetMessageDigest) {
    const patched = await advance(brokerRequest, {
      id: entry.coding_session_id,
      transactionId: current.transaction_id,
      expectedPhase: 'handoff_persisted',
      nextPhase: 'handoff_persisted',
      patch: {
        target_latest_sequence: targetContext.continuity.latestSequence,
        target_message_digest: targetMessageDigest,
      },
      now: deps.now,
    });
    if (!patched.ok) return patched;
    current = patched.journal;
  }
  const launchStarted = await advance(brokerRequest, {
    id: entry.coding_session_id,
    transactionId: current.transaction_id,
    expectedPhase: 'handoff_persisted',
    nextPhase: 'target_launch_started',
    now: deps.now,
  });
  if (!launchStarted.ok) return launchStarted;
  return {
    ok: true,
    entry: sourceCommitted.entry,
    journal: launchStarted.journal,
    message: rendered.message,
    transaction: transactionProjection(launchStarted.journal, {
      controllerCapability,
      sessionControllerCapability,
    }),
  };
}

async function publishTerminalFence({
  entry,
  sourceTool,
  sourceSession,
  repoContext,
  auth,
  deps,
}) {
  const nowValue = isoNow(deps.now || (() => new Date().toISOString()));
  const posted = await (deps.postHeartbeatWithRetry || postHeartbeatWithRetry)({
    apiUrl: auth.apiUrl,
    token: auth.token,
    payload: buildSessionHeartbeatPayload({
      codingSessionId: entry.coding_session_id,
      runtimeGeneration: sourceSession.runtime_generation,
      presenceState: 'terminal',
      machineId: (deps.hostname || hostname)(),
      sourceIdentity: {
        source_id: sourceSession.source_id,
        source_kind: sourceSession.source_kind || 'local',
        source_name: null,
        cloud_session_id: null,
      },
      source: sourceTool.id,
      repo: derivePublicRepoRef(repoContext) || deriveRepoName(repoContext),
      branch: repoContext.branch,
      at: nowValue,
      label: entry.name,
    }),
    memoroFetchImpl: deps.memoroFetch,
    sleepImpl: deps.sleep,
    retryIntervalMs: deps.retryIntervalMs,
    maxAttempts: 3,
  });
  return posted
    ? { ok: true }
    : failure('handoff-terminal-fence-unconfirmed');
}

async function resolveSwitchIdentity({ apiArgv, env, deps }) {
  let config;
  try {
    config = await (deps.readConfig || readConfig)();
  } catch {
    return failure('handoff-auth-unavailable');
  }
  const apiUrl = (deps.getApiUrl || getApiUrl)(apiArgv) || config?.apiUrl;
  const identity = await (deps.resolveBootstrapIdentity || resolveBootstrapIdentity)({
    env,
    apiUrl,
    getSecret: deps.getSecret,
  });
  return identity?.token
    ? { ok: true, apiUrl, token: identity.token }
    : failure('handoff-auth-unavailable');
}

async function advance(request, {
  id,
  transactionId,
  expectedPhase,
  nextPhase,
  patch = {},
  controllerCapability = null,
  now = () => new Date().toISOString(),
}) {
  const result = await request({
    type: 'handoff_switch_advance',
    id,
    transaction_id: transactionId,
    expected_phase: expectedPhase,
    next_phase: nextPhase,
    patch,
    ...(controllerCapability
      ? { controller_capability: controllerCapability }
      : {}),
    updated_at: isoNow(now),
  }).catch(() => null);
  return result?.ok
    ? { ok: true, journal: result.journal }
    : failure(result?.reason || 'handoff-switch-advance-failed');
}

async function recordSwitchDiagnostic({
  brokerRequest,
  codingSessionId,
  transactionId,
  code,
  now = () => new Date().toISOString(),
} = {}) {
  await brokerRequest({
    type: 'handoff_switch_diagnose',
    id: codingSessionId,
    transaction_id: transactionId,
    code,
    observed_at: isoNow(now),
  }).catch(() => null);
}

function transactionProjection(journal, {
  controllerCapability,
  sessionControllerCapability,
} = {}) {
  return {
    transaction_id: journal.transaction_id,
    target_tool: journal.target_tool,
    target_custody: journal.target_custody || 'native',
    target_latest_sequence: journal.target_latest_sequence,
    controller_capability: controllerCapability,
    session_controller_capability: sessionControllerCapability,
    require_target_artifact: true,
  };
}

async function proveProviderSwitchSource({
  entry,
  sourceTool,
  sourceProvider,
  deps = {},
} = {}) {
  const providerSessionId = exact(sourceProvider?.session_id);
  const runtimeGeneration = exact(sourceProvider?.runtime_generation);
  if (!providerSessionId || !runtimeGeneration) {
    return failure('handoff-source-artifact-unconfirmed');
  }
  const registryClaimsManaged = exact(entry?.tool_session_provider_adapter) != null
    && resolveToolInput(entry?.tool)?.id === sourceTool?.id;
  if (!registryClaimsManaged && exact(sourceProvider?.transcript_path)) {
    return {
      ok: true,
      custody: 'native',
      providerSessionId,
      runtimeGeneration,
    };
  }
  const inspect = deps.inspectManagedProviderHandoffSource
    || inspectManagedProviderHandoffSource;
  let proof;
  try {
    proof = await Promise.resolve(inspect({
      tool: sourceTool?.id,
      codingSessionId: entry?.coding_session_id,
      providerSessionId,
      runtimeGeneration,
      root: (deps.mcHome || mcHome)(),
      deps: deps.managedHandoffSourceDeps || {},
    }));
  } catch {
    proof = null;
  }
  if (proof?.schema !== MANAGED_PROVIDER_HANDOFF_SOURCE_SCHEMA
    || proof.ok !== true
    || proof.tool_id !== sourceTool?.id
    || proof.coding_session_id !== entry?.coding_session_id
    || proof.provider_session_id !== providerSessionId
    || proof.runtime_generation !== runtimeGeneration
    || !/^[a-f0-9]{64}$/u.test(proof.archive_digest || '')) {
    return failure('handoff-source-artifact-unconfirmed');
  }
  return {
    ok: true,
    custody: 'managed',
    providerSessionId,
    runtimeGeneration,
    archiveDigest: proof.archive_digest,
  };
}

function recoveryCursorMatches({
  journal,
  sourceCursor,
  targetCursor,
  deliveryAcknowledged = false,
} = {}) {
  const sourceMatches = journal?.source_cursor === sourceCursor
    || (HANDOFF_ALREADY_PERSISTED_PHASES.has(journal?.phase)
      && journal?.persisted?.sequence === sourceCursor);
  const targetMatches = journal?.target_cursor === targetCursor
    || (deliveryAcknowledged
      && journal?.target_latest_sequence === targetCursor);
  return sourceMatches && targetMatches;
}

function resolveSwitchBrokerRequest({
  entry,
  localPresence,
  sessionControllerCapability = null,
  deps = {},
} = {}) {
  if (deps.brokerRequest) {
    return (message) => deps.brokerRequest({
      ...message,
      ...(message?.type === 'handoff_switch_read'
        && sessionControllerCapability
        ? { session_controller_capability: sessionControllerCapability }
        : {}),
    });
  }
  const codingSessionId = exact(entry?.coding_session_id);
  const fallbackSocketPath = codingSessionId
    ? (deps.sessionHostPaths || sessionHostPaths)(codingSessionId).socketPath
    : null;
  return requestForSession(localPresence?.session || {
    broker_socket_path: exact(entry?.broker_socket_path) || fallbackSocketPath,
  }, {
    request: deps.requestBroker || requestBroker,
    controllerCapability: sessionControllerCapability,
  });
}

function controllerCapabilityFor({
  root,
  transactionId,
} = {}) {
  return deriveHandoffControllerCapability({ root, transactionId });
}

function bindControllerCapability(
  request,
  controllerCapability,
  sessionControllerCapability,
) {
  return (message) => request({
    ...message,
    controller_capability: controllerCapability,
    session_controller_capability: sessionControllerCapability,
  });
}

async function resolveSwitchJournalAccess({
  entry,
  localPresence,
  sessionControllerCapability,
  ensureWhenAbsent = false,
  deps = {},
} = {}) {
  const codingSessionId = exact(entry?.coding_session_id);
  let brokerRequest = resolveSwitchBrokerRequest({
    entry,
    localPresence,
    sessionControllerCapability,
    deps,
  });
  let existing = await brokerRequest({
    type: 'handoff_switch_read',
    id: codingSessionId,
  }).catch(() => null);
  if (existing?.ok === true) return { ok: true, brokerRequest, existing };
  if (deps.brokerRequest) return failure('handoff-switch-journal-unavailable');

  const paths = (deps.sessionHostPaths || sessionHostPaths)(codingSessionId);
  const local = (deps.readHandoffSwitchJournalSync || readHandoffSwitchJournalSync)({
    path: paths.handoffSwitchPath,
    trustedRoot: (deps.mcHome || mcHome)(),
  });
  if (local.kind === 'absent' && !ensureWhenAbsent) {
    return { ok: true, inactive: true };
  }
  if (!['absent', 'present'].includes(local.kind)
    || localPresence?.verdict !== 'exited') {
    return failure('handoff-switch-journal-unavailable');
  }
  const ensured = await (deps.ensureSessionHostRunning || ensureSessionHostRunning)({
    sessionId: codingSessionId,
    controllerBinding: {
      schema: 'mc-broker-controller-bootstrap-v1',
      session_id: codingSessionId,
      session_controller_capability: sessionControllerCapability,
    },
    paths,
    request: deps.requestBroker || requestBroker,
  }).catch(() => null);
  if (!ensured?.ok) return failure('handoff-switch-journal-unavailable');
  brokerRequest = requestForSession({
    broker_socket_path: paths.socketPath,
  }, {
    request: deps.requestBroker || requestBroker,
    controllerCapability: sessionControllerCapability,
  });
  existing = await brokerRequest({
    type: 'handoff_switch_read',
    id: codingSessionId,
  }).catch(() => null);
  return existing?.ok === true
    ? { ok: true, brokerRequest, existing }
    : failure('handoff-switch-journal-unavailable');
}

function providerCursor(value) {
  const cursor = value?.last_consumed_handoff_sequence ?? 0;
  return Number.isSafeInteger(cursor) && cursor >= 0 ? cursor : null;
}

function isoNow(now) {
  const value = typeof now === 'function' ? now() : now;
  const parsed = value instanceof Date ? value : new Date(value);
  return Number.isFinite(parsed.getTime())
    ? parsed.toISOString()
    : new Date().toISOString();
}

function safeId(value) {
  return typeof value === 'string' && /^[A-Za-z0-9._:-]{1,128}$/.test(value);
}

/**
 * Rebuild the exited source from durable evidence when no live broker session
 * remains — after a restart, a broker crash, or a host replaced since the
 * provider ran. The broker writes its lifecycle journal precisely so terminal
 * state outlives the process that observed it, so a switch must not depend on
 * that process still being around.
 *
 * This weakens nothing. The journal carries a positive `state: exited` for one
 * exact generation, and the caller still requires that generation to equal the
 * one the registry recorded for this provider. What is rebuilt is only the
 * identity of the machine: the source kind is local, which means this host by
 * definition, and the same value is used for both the terminal fence and the
 * handoff, so the server's seal stays internally consistent. A cloud source is
 * never rebuilt this way — its identity belongs to the runtime that held it.
 */
function durableExitedSource({ sourceTool, sourceGeneration, localPresence, deps = {} } = {}) {
  if (localPresence?.verdict !== 'exited' || localPresence.session) return null;
  const journaled = exact(localPresence.lifecycle?.record?.runtime_generation);
  if (!journaled || journaled !== sourceGeneration) return null;
  if (exact(localPresence.lifecycle?.record?.state) !== 'exited') return null;
  const identity = (deps.resolveSessionSourceIdentity || resolveSessionSourceIdentity)({
    machineId: (deps.hostname || hostname)(),
  });
  if (identity?.source_kind !== 'local' || !safeId(identity.source_id)) return null;
  return {
    tool: sourceTool.id,
    runtime_generation: sourceGeneration,
    source_id: identity.source_id,
    source_kind: 'local',
  };
}

function exact(value) {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function digestText(value) {
  return createHash('sha256').update(String(value), 'utf8').digest('hex');
}

function failure(code) {
  return { ok: false, code };
}
