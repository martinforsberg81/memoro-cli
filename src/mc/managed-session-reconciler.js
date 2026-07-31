import { createHash } from 'node:crypto';

import { mcHome } from './paths.js';
import { resolveToolInput } from '../adapters/index.js';
import { DEFAULT_TOOL } from '../lib/config.js';
import {
  abortManagedCredentialDomain,
  confirmManagedCredentialDomainAbsent,
  finalizeManagedCredentialDomain,
  inspectManagedCredentialDomainPresence,
  inspectPreparedManagedCredentialDomain,
  managedProviderArtifactContextForLaunch,
  observeManagedProviderArtifact,
  validateManagedProviderArtifact,
} from './managed-provider-registry.js';
import {
  appendManagedGenerationReceiptSync,
  inspectManagedGenerationSync,
  inspectManagedSessionSync,
  managedTransactionFromIntent,
} from './managed-generation-journal.js';

/**
 * Reconcile one logical managed session before `mc open` decides whether to
 * attach or start a provider. All process state is observational; receipt
 * chains decide which mutations are safe.
 */
export async function reconcileManagedSession({
  entry,
  inspectLocalPresence,
  root = mcHome(),
  deps = {},
} = {}) {
  const localPresence = typeof inspectLocalPresence === 'function'
    ? await Promise.resolve(inspectLocalPresence(entry)).catch(() => ({ verdict: 'unknown' }))
    : { verdict: 'unknown' };
  const codingSessionId = exact(entry?.coding_session_id);
  if (!codingSessionId) {
    return localPresence?.verdict === 'live'
      ? blocked('managed-live-runtime-without-session-identity')
      : start();
  }
  const inspectSession = deps.inspectManagedSession || inspectManagedSessionSync;
  let session;
  try {
    session = inspectSession({
      mcHomeDir: root,
      codingSessionId,
    });
  } catch {
    return blocked('managed-generation-journal-unreadable');
  }
  if (session?.kind === 'unknown') {
    return blocked(`managed-generation-journal-${session.reason || 'unsafe'}`);
  }
  if (!session?.generations?.length) {
    if (localPresence?.verdict === 'live') {
      return blocked('managed-live-runtime-journal-missing');
    }
    const tool = managedToolId(entry?.tool || DEFAULT_TOOL);
    if (!tool) return blocked('managed-provider-tool-unsupported');
    const inspectDomainPresence = deps.inspectCredentialDomainPresence
      || inspectManagedCredentialDomainPresence;
    const domain = inspectDomainPresence({ root, codingSessionId, tool });
    if (domain?.kind === 'unknown') {
      return blocked(domain.reason || 'managed-domain-presence-unknown');
    }
    if (domain?.kind === 'present') {
      return blocked('managed-legacy-or-orphan-domain-unconfirmed');
    }
    return start();
  }

  let active = session.active || null;
  if (!active) return terminalAction(session.generations);
  let generations = session.generations;

  if (localPresence?.verdict === 'live') {
    if (localPresence.runtime_generation !== active.runtime_generation
      || localPresence.session?.managed_provider !== true) {
      return blocked('managed-live-runtime-binding-mismatch');
    }
    return {
      ok: true,
      action: 'attach',
      generation: active,
      localPresence,
    };
  }

  if (active.phase === 'intent') {
    return abortIntentGeneration({
      active,
      generations: session.generations,
      root,
      deps,
    });
  }
  if (active.phase === 'domain-ready') {
    return abortUnacceptedGeneration({
      active,
      generations: session.generations,
      root,
      deps,
    });
  }
  if (!active.receipts?.exited) {
    const recovered = await recoverAcceptedGenerationExit({
      entry,
      active,
      generations,
      localPresence,
      root,
      deps,
    });
    if (!recovered?.ok) {
      return blocked(
        recovered?.reason
        || (localPresence?.verdict === 'unreachable'
          ? 'managed-live-runtime-unreachable'
          : 'managed-accepted-generation-outcome-unconfirmed'),
      );
    }
    active = recovered.active;
    generations = recovered.generations;
  }
  return finalizeExitedGeneration({
    active,
    generations,
    root,
    deps,
  });
}

async function recoverAcceptedGenerationExit({
  entry,
  active,
  generations,
  localPresence,
  root,
  deps,
}) {
  const proof = acceptedGenerationExitProof({
    active,
    generations,
    localPresence,
  });
  if (!proof.ok) return proof;

  if (!active.receipts?.live) {
    try {
      appendReceipt({
        deps,
        root,
        generation: active,
        phase: 'live',
        data: {},
        recordedAt: proof.recordedAt,
      });
    } catch {
      return { ok: false, reason: 'managed-generation-live-recovery-unconfirmed' };
    }
  }

  if (!active.receipts?.['provider-artifact']) {
    const recoveredArtifact = recoverProviderArtifact({
      entry,
      active,
      root,
      deps,
    });
    if (recoveredArtifact?.ok) {
      try {
        appendReceipt({
          deps,
          root,
          generation: active,
          phase: 'provider-artifact',
          recordedAt: recoveredArtifact.artifact.captured_at,
          data: {
            provider_session_id: recoveredArtifact.artifact.provider_session_id,
            artifact_digest: sha256(JSON.stringify(recoveredArtifact.artifact)),
            tool: recoveredArtifact.artifact.tool,
            transcript_path: recoveredArtifact.artifact.transcript_path,
            captured_at: recoveredArtifact.artifact.captured_at,
          },
        });
      } catch {
        return { ok: false, reason: 'managed-provider-artifact-recovery-unconfirmed' };
      }
    }
  }

  try {
    appendReceipt({
      deps,
      root,
      generation: active,
      phase: 'exited',
      recordedAt: proof.recordedAt,
      data: proof.exitData,
    });
  } catch {
    return { ok: false, reason: 'managed-generation-exit-receipt-unconfirmed' };
  }

  const inspectGeneration = deps.inspectManagedGeneration || inspectManagedGenerationSync;
  let completed;
  try {
    completed = inspectGeneration({
      mcHomeDir: root,
      codingSessionId: active.coding_session_id,
      runtimeGeneration: active.runtime_generation,
    });
  } catch {
    completed = null;
  }
  if (completed?.kind !== 'present' || !completed.receipts?.exited) {
    return { ok: false, reason: 'managed-generation-exit-recovery-unconfirmed' };
  }
  return {
    ok: true,
    active: completed,
    generations: [
      ...generations.slice(0, -1),
      completed,
    ],
  };
}

function acceptedGenerationExitProof({
  active,
  generations,
  localPresence,
}) {
  if (localPresence?.verdict !== 'exited') {
    return {
      ok: false,
      reason: localPresence?.verdict === 'unreachable'
        ? 'managed-live-runtime-unreachable'
        : 'managed-accepted-generation-outcome-unconfirmed',
    };
  }
  const lifecycle = localPresence.lifecycle?.record || null;
  const exactGeneration = localPresence.runtime_generation === active.runtime_generation;
  const managedSession = !localPresence.session
    || localPresence.session.managed_provider === true;
  if (exactGeneration && managedSession) {
    const exactLifecycle = lifecycle?.runtime_generation === active.runtime_generation
      ? lifecycle
      : null;
    return {
      ok: true,
      recordedAt: exactIso(exactLifecycle?.observed_at)
        ? exactLifecycle.observed_at
        : new Date().toISOString(),
      exitData: {
        exit_code: Number.isInteger(exactLifecycle?.exit_code)
          ? exactLifecycle.exit_code
          : null,
        signal: typeof exactLifecycle?.signal === 'string'
          ? exactLifecycle.signal
          : null,
      },
    };
  }

  const host = localPresence.host_runtime;
  const manifest = host?.host_manifest;
  const intentAt = isoTime(active.intent?.recorded_at);
  const acceptedAt = isoTime(active.receipts?.['broker-accepted']?.recorded_at);
  const hostAt = isoTime(manifest?.updated_at);
  const staleLifecycleGeneration = lifecycle?.runtime_generation
    ? generations.find(
      (generation) => generation.runtime_generation === lifecycle.runtime_generation,
    )
    : null;
  const staleLifecycleSafe = !lifecycle
    || (staleLifecycleGeneration?.terminal === true
      && lifecycle.runtime_generation !== active.runtime_generation);
  if (active.receipts?.live
    && active.receipts?.['broker-accepted']
    && !localPresence.session
    && host?.verdict === 'exited'
    && host.reason === 'host-process-exited'
    && manifest?.session_id === active.coding_session_id
    && Number.isSafeInteger(host.pid)
    && manifest.broker_pid === host.pid
    && intentAt !== null
    && acceptedAt !== null
    && hostAt !== null
    && hostAt >= intentAt - 60_000
    && hostAt <= acceptedAt
    && staleLifecycleSafe) {
    return {
      ok: true,
      recordedAt: new Date().toISOString(),
      exitData: {
        exit_code: null,
        signal: null,
      },
    };
  }
  return {
    ok: false,
    reason: 'managed-accepted-generation-outcome-unconfirmed',
  };
}

function recoverProviderArtifact({
  entry,
  active,
  root,
  deps,
}) {
  const tool = active.intent?.data?.tool;
  const inspectDomain = deps.inspectPreparedDomain
    || inspectPreparedManagedCredentialDomain;
  const prepared = inspectDomain({
    root,
    codingSessionId: active.coding_session_id,
    tool,
  });
  const domainReceipt = active.receipts?.['domain-ready'];
  if (!prepared?.ok
    || prepared.descriptor?.generation !== domainReceipt?.data?.domain_generation
    || prepared.descriptor?.manifest_sha256 !== domainReceipt?.data?.manifest_digest) {
    return { ok: false, reason: prepared?.reason || 'managed-recovery-domain-mismatch' };
  }
  const mode = active.intent.data.mode;
  const providerSessionId = active.intent.data.resume_provider_session_id;
  const contextBuilder = deps.managedProviderArtifactContextForLaunch
    || managedProviderArtifactContextForLaunch;
  const context = contextBuilder({
    tool,
    provider: { descriptor: prepared.descriptor },
    input: {
      argv: mode === 'resume' ? ['resume', providerSessionId] : [],
      credential_domain: prepared.descriptor,
    },
  });
  if (!context) return { ok: false, reason: 'managed-provider-artifact-context-invalid' };
  const observe = deps.observeManagedProviderArtifact || observeManagedProviderArtifact;
  const observed = observe({
    tool,
    cwd: entry?.worktree_path,
    context,
  });
  if (!observed?.ok || !observed.evidence) {
    return {
      ok: false,
      reason: observed?.reason || 'managed-provider-artifact-not-observed',
    };
  }
  const validate = deps.validateManagedProviderArtifact || validateManagedProviderArtifact;
  const checked = validate({
    tool,
    evidence: observed.evidence,
    context,
  });
  if (!checked?.ok
    || (mode === 'resume' && observed.evidence.providerSessionId !== providerSessionId)) {
    return {
      ok: false,
      reason: checked?.reason || 'managed-provider-artifact-invalid',
    };
  }
  return {
    ok: true,
    artifact: {
      schema: 'mc-provider-artifact-v1',
      coding_session_id: active.coding_session_id,
      runtime_generation: active.runtime_generation,
      tool,
      provider_session_id: observed.evidence.providerSessionId,
      transcript_path: checked.transcriptPath,
      captured_at: new Date().toISOString(),
    },
  };
}

async function abortIntentGeneration({
  active,
  generations,
  root,
  deps,
}) {
  const inspectDomainPresence = deps.inspectCredentialDomainPresence
    || inspectManagedCredentialDomainPresence;
  const domain = inspectDomainPresence({
    root,
    codingSessionId: active.coding_session_id,
    tool: active.intent.data.tool,
  });
  if (domain?.kind === 'unknown') {
    return blocked(domain.reason || 'managed-generation-domain-outcome-unconfirmed');
  }
  if (domain?.kind === 'present') {
    if (domain.descriptor?.generation !== active.runtime_generation) {
      return blocked('managed-intent-domain-binding-mismatch');
    }
    const aborted = (deps.abortCredentialDomain || abortManagedCredentialDomain)({
      descriptor: domain.descriptor,
    });
    if (!aborted?.ok) {
      return blocked(aborted?.reason || 'managed-intent-domain-abort-failed');
    }
  }
  try {
    appendReceipt({
      deps,
      root,
      generation: active,
      phase: 'aborted',
      data: { reason: 'launch-failed-before-provider' },
    });
  } catch {
    return blocked('managed-generation-abort-receipt-unconfirmed');
  }
  return terminalAction([
    ...generations.slice(0, -1),
    {
      ...active,
      terminal: true,
      phase: 'aborted',
      receipts: {
        ...active.receipts,
        aborted: { data: { reason: 'launch-failed-before-provider' } },
      },
    },
  ]);
}

async function abortUnacceptedGeneration({
  active,
  generations,
  root,
  deps,
}) {
  const inspectDomain = deps.inspectPreparedDomain
    || inspectPreparedManagedCredentialDomain;
  const prepared = inspectDomain({
    root,
    codingSessionId: active.coding_session_id,
    tool: active.intent.data.tool,
  });
  const domainReceipt = active.receipts['domain-ready'];
  if (prepared?.ok) {
    if (prepared.descriptor?.generation !== domainReceipt.data.domain_generation
      || prepared.descriptor?.manifest_sha256 !== domainReceipt.data.manifest_digest) {
      return blocked('managed-unaccepted-domain-mismatch');
    }
    const aborted = (deps.abortCredentialDomain || abortManagedCredentialDomain)({
      descriptor: prepared.descriptor,
    });
    if (!aborted?.ok) {
      return blocked(aborted?.reason || 'managed-unaccepted-domain-abort-failed');
    }
  } else {
    const absent = (deps.confirmCredentialDomainAbsent
      || confirmManagedCredentialDomainAbsent)({
      root,
      codingSessionId: active.coding_session_id,
      domainGeneration: domainReceipt.data.domain_generation,
      tool: active.intent.data.tool,
    });
    if (!absent?.ok) {
      return blocked(absent?.reason || prepared?.reason || 'managed-unaccepted-domain-unconfirmed');
    }
  }
  try {
    appendReceipt({
      deps,
      root,
      generation: active,
      phase: 'aborted',
      data: { reason: 'launch-not-accepted' },
    });
  } catch {
    return blocked('managed-generation-abort-receipt-unconfirmed');
  }
  return terminalAction([
    ...generations.slice(0, -1),
    {
      ...active,
      terminal: true,
      phase: 'aborted',
      receipts: {
        ...active.receipts,
        aborted: { data: { reason: 'launch-not-accepted' } },
      },
    },
  ]);
}

async function finalizeExitedGeneration({
  active,
  generations,
  root,
  deps,
}) {
  const providerReceipt = active.receipts['provider-artifact'];
  const providerAbsent = active.receipts['provider-absent'];
  const archiveReceipt = active.receipts['archive-ready'];

  if (active.receipts['domain-cleaned']) {
    return publishReady({ active, generations, root, deps });
  }

  const inspectDomain = deps.inspectPreparedDomain
    || inspectPreparedManagedCredentialDomain;
  const prepared = inspectDomain({
    root,
    codingSessionId: active.coding_session_id,
    tool: active.intent.data.tool,
  });
  if (!prepared?.ok) {
    if (!providerAbsent && !archiveReceipt) {
      return blocked(prepared?.reason || 'managed-finalization-domain-unavailable');
    }
    const domainReceipt = active.receipts['domain-ready'];
    const absent = (deps.confirmCredentialDomainAbsent
      || confirmManagedCredentialDomainAbsent)({
      root,
      codingSessionId: active.coding_session_id,
      domainGeneration: domainReceipt.data.domain_generation,
      tool: active.intent.data.tool,
    });
    if (!absent?.ok) return blocked(absent?.reason || 'managed-domain-cleanup-unconfirmed');
    try {
      appendReceipt({
        deps,
        root,
        generation: active,
        phase: 'domain-cleaned',
        data: { domain_generation: domainReceipt.data.domain_generation },
      });
    } catch {
      return blocked('managed-domain-cleanup-receipt-unconfirmed');
    }
    return publishReady({ active, generations, root, deps });
  }

  const domainReceipt = active.receipts['domain-ready'];
  if (prepared.descriptor.generation !== domainReceipt.data.domain_generation
    || prepared.descriptor.manifest_sha256 !== domainReceipt.data.manifest_digest) {
    return blocked('managed-finalization-domain-mismatch');
  }
  const data = providerReceipt?.data || null;
  const finalized = await (deps.closeCredentialDomain || finalizeManagedCredentialDomain)({
    descriptor: prepared.descriptor,
    providerArtifact: data
      ? {
          schema: 'mc-provider-artifact-v1',
          coding_session_id: active.coding_session_id,
          runtime_generation: active.runtime_generation,
          tool: data.tool,
          provider_session_id: data.provider_session_id,
          transcript_path: data.transcript_path,
          captured_at: data.captured_at,
        }
      : null,
    managedTransaction: managedTransactionFromIntent(active.intent),
    root,
    deps: deps.closeDeps || {},
  });
  if (!finalized?.ok) {
    return blocked(finalized?.reason || 'managed-generation-finalization-failed');
  }
  const inspectGeneration = deps.inspectManagedGeneration || inspectManagedGenerationSync;
  const completed = inspectGeneration({
    mcHomeDir: root,
    codingSessionId: active.coding_session_id,
    runtimeGeneration: active.runtime_generation,
  });
  if (completed?.kind !== 'present' || completed.phase !== 'ready') {
    return blocked('managed-generation-ready-unconfirmed');
  }
  return terminalAction([
    ...generations.slice(0, -1),
    completed,
  ]);
}

function publishReady({ active, generations, root, deps }) {
  const archive = active.receipts['archive-ready'];
  try {
    appendReceipt({
      deps,
      root,
      generation: active,
      phase: 'ready',
      data: {
        provider_session_id: archive?.data?.provider_session_id || null,
        archive_digest: archive?.data?.archive_digest || null,
      },
    });
  } catch {
    return blocked('managed-generation-ready-receipt-unconfirmed');
  }
  return terminalAction([
    ...generations.slice(0, -1),
    {
      ...active,
      terminal: true,
      phase: 'ready',
      receipts: {
        ...active.receipts,
        ready: {
          data: archive?.data || {
            provider_session_id: null,
            archive_digest: null,
          },
        },
      },
    },
  ]);
}

function appendReceipt({
  deps,
  root,
  generation,
  phase,
  data,
  recordedAt = new Date().toISOString(),
}) {
  const append = deps.appendManagedReceipt || appendManagedGenerationReceiptSync;
  return append({
    mcHomeDir: root,
    phase,
    codingSessionId: generation.coding_session_id,
    runtimeGeneration: generation.runtime_generation,
    intentDigest: generation.intent.intent_digest,
    recordedAt,
    data,
  });
}

function terminalAction(generations) {
  const readyGeneration = [...generations]
    .reverse()
    .find((generation) => (
      typeof generation.receipts?.ready?.data?.provider_session_id === 'string'
      && generation.receipts.ready.data.provider_session_id
    ));
  if (!readyGeneration) return start();
  return {
    ok: true,
    action: 'resume',
    providerSessionId: readyGeneration.receipts.ready.data.provider_session_id,
    runtimeGeneration: readyGeneration.runtime_generation,
    tool: readyGeneration.intent.data.tool,
    generation: readyGeneration,
  };
}

function start() {
  return { ok: true, action: 'start' };
}

function blocked(reason) {
  return { ok: false, action: 'blocked', reason };
}

function exact(value) {
  return typeof value === 'string' && value.length ? value : null;
}

function managedToolId(value) {
  return resolveToolInput(value)?.id || null;
}

function exactIso(value) {
  return isoTime(value) !== null;
}

function isoTime(value) {
  if (typeof value !== 'string') return null;
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString() === value
    ? parsed.getTime()
    : null;
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}
