import { createHash } from 'node:crypto';
import { readdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { CODEX_SESSIONS_DIR } from '../lib/codex.js';
import { mcHome } from './paths.js';
import {
  readRegistryStrict,
  withProviderSession,
  writeRegistry,
} from './registry.js';
import {
  providerArtifactPath,
  sessionHostPaths,
} from '../runtime/broker/paths.js';
import { readSessionLifecycle } from '../runtime/broker/lifecycle-journal.js';
import { readProviderArtifactSync } from '../runtime/broker/provider-artifact-journal.js';
import {
  closeLocalCodexCredentialDomain,
  inspectLegacyLocalCodexResumeAbsence,
  inspectLocalCodexCredentialDomainPresence,
  inspectQuarantinedLocalCodexCredentialDomain,
  persistManagedCodexSessionState,
} from '../vault/credential-domain/local-codex.js';
import { MANAGED_CODEX_PROVIDER_ID } from '../adapters/managed-runtime/codex-managed.js';
import {
  observe as observeCodexProviderArtifact,
  validate as validateCodexProviderArtifact,
} from '../adapters/artifacts/codex.js';
import {
  reapZombieHosts,
  scanRuntimeSidecars,
} from './sidecar-cleanup.js';
import {
  appendManagedGenerationReceiptSync,
  beginManagedGenerationSync,
  inspectManagedGenerationSync,
  inspectManagedSessionSync,
  managedTransactionFromIntent,
} from './managed-generation-journal.js';

/**
 * Import a provider transcript captured before managed custody became the
 * default. This is intentionally separate from generation recovery: no
 * synthetic provider run or receipt chain is invented. The imported archive
 * authorizes one real managed resume, whose normal launch becomes the next
 * durable generation.
 *
 * A narrowly bounded repair also covers the 0.7.7 cutover regression: when the
 * first and only managed generation was incorrectly recorded as fresh, an
 * older provider id is accepted only when every valid pre-intent host artifact
 * agrees on that exact id.
 */
export function importLegacyNativeCodexSession({
  entry,
  root = mcHome(),
  deps = {},
} = {}) {
  if (entry?.tool !== 'codex'
    || typeof entry?.coding_session_id !== 'string'
    || !entry.coding_session_id
    || typeof entry?.worktree_path !== 'string'
    || !entry.worktree_path) {
    return { ...failed('managed-native-import-inapplicable'), attempted: false };
  }

  const inspectSession = deps.inspectManagedSession || inspectManagedSessionSync;
  let session;
  try {
    session = inspectSession({
      mcHomeDir: root,
      codingSessionId: entry.coding_session_id,
    });
  } catch {
    return { ...failed('managed-native-import-journal-unreadable'), attempted: true };
  }
  if (session?.kind === 'unknown') {
    return {
      ...failed(`managed-native-import-journal-${session.reason || 'unsafe'}`),
      attempted: true,
    };
  }

  const classification = classifyNativeImport({ entry, session });
  if (!classification.applicable) {
    return {
      ...failed(classification.reason || 'managed-native-import-inapplicable'),
      attempted: false,
    };
  }

  const listed = (deps.listProviderArtifacts || listProviderArtifacts)({
    root,
    codingSessionId: entry.coding_session_id,
  });
  if (!listed.ok) {
    if (classification.repairedCutover
      && listed.reason === 'managed-native-import-artifact-missing'
      && !hasLegacyRegistryEvidence(entry)) {
      return {
        ...failed(listed.reason),
        attempted: false,
      };
    }
    if (!classification.repairedCutover
      && listed.reason === 'managed-native-import-artifact-missing') {
      // The exact native transcript fallback below owns this case.
    } else {
      return {
        ...failed(listed.reason || 'managed-native-import-artifacts-unavailable'),
        attempted: true,
      };
    }
  }
  let beforeCutoff = (listed.artifacts || []).filter((artifact) => (
    artifact.tool === 'codex'
    && (
      classification.cutoffMs === null
      || isoTime(artifact.captured_at) < classification.cutoffMs
    )
  ));
  if (beforeCutoff.length === 0
    && classification.repairedCutover
    && !hasLegacyRegistryEvidence(entry)) {
    return {
      ...failed('managed-native-import-artifact-missing'),
      attempted: false,
    };
  }
  if (beforeCutoff.length === 0
    && !classification.repairedCutover
    && classification.expectedProviderSessionId) {
    const observed = observeNativeCodexArtifact({
      entry,
      providerSessionId: classification.expectedProviderSessionId,
      sessionsDir: deps.sessionsDir || CODEX_SESSIONS_DIR,
      deps,
    });
    if (observed.ok) beforeCutoff = [observed.artifact];
    else {
      return {
        ...failed(observed.reason || 'managed-native-import-artifact-missing'),
        attempted: true,
      };
    }
  }
  if (beforeCutoff.length === 0) {
    return { ...failed('managed-native-import-artifact-missing'), attempted: true };
  }
  const providerIds = [...new Set(
    beforeCutoff.map((artifact) => artifact.provider_session_id),
  )];
  if (providerIds.length !== 1
    || (classification.expectedProviderSessionId
      && providerIds[0] !== classification.expectedProviderSessionId)
    || (classification.supersededProviderSessionId
      && providerIds[0] === classification.supersededProviderSessionId)) {
    return { ...failed('managed-native-import-artifact-ambiguous'), attempted: true };
  }

  const sessionsDir = deps.sessionsDir || CODEX_SESSIONS_DIR;
  const validate = deps.validateProviderArtifact || validateCodexProviderArtifact;
  const validated = [];
  for (const artifact of beforeCutoff) {
    const checked = validate({
      evidence: {
        cwd: entry.worktree_path,
        providerSessionId: artifact.provider_session_id,
        transcriptPath: artifact.transcript_path,
      },
      context: { sessions_dir: sessionsDir },
    });
    if (!checked?.ok) {
      return {
        ...failed(checked?.reason || 'managed-native-import-artifact-invalid'),
        attempted: true,
      };
    }
    validated.push({
      ...artifact,
      transcript_path: checked.transcriptPath || artifact.transcript_path,
    });
  }
  validated.sort((left, right) => (
    left.captured_at.localeCompare(right.captured_at)
  ));
  const artifact = validated.at(-1);
  const persist = deps.persistManagedSessionState || persistManagedCodexSessionState;
  const archived = persist({
    root,
    descriptor: {
      session_id: entry.coding_session_id,
      codex_home: dirname(sessionsDir),
    },
    providerArtifact: artifact,
  });
  if (!archived?.ok) {
    return {
      ...failed(archived?.reason || 'managed-native-import-archive-failed'),
      attempted: true,
    };
  }
  return {
    ok: true,
    attempted: true,
    imported: true,
    repaired_cutover: classification.repairedCutover,
    provider_session_id: artifact.provider_session_id,
    runtime_generation: artifact.runtime_generation,
    archive_digest: archived.state?.archive_digest || null,
  };
}

/**
 * Inspect one exact, registered managed Codex generation without opening
 * custody or mutating local state.
 */
export async function inspectManagedCodexRecovery({
  entry,
  root = mcHome(),
  registry = null,
  deps = {},
} = {}) {
  if (!entry?.name
    || entry.tool !== 'codex'
    || typeof entry.coding_session_id !== 'string'
    || !entry.coding_session_id) {
    return failed('managed-recovery-entry-invalid');
  }
  const codingSessionId = entry.coding_session_id;
  const hostPaths = (deps.sessionHostPaths || sessionHostPaths)(
    codingSessionId,
    { root },
  );
  const lifecycle = await (deps.readSessionLifecycle || readSessionLifecycle)({
    path: hostPaths.lifecyclePath,
    codingSessionId,
  }).catch(() => ({ verdict: 'unknown', record: null }));
  if (lifecycle.verdict !== 'exited' || lifecycle.record?.state !== 'exited') {
    return failed('managed-recovery-exit-unconfirmed');
  }

  const runtimeGeneration = lifecycle.record.runtime_generation;
  const artifactPath = (deps.providerArtifactPath || providerArtifactPath)(
    codingSessionId,
    runtimeGeneration,
    { root },
  );
  const artifactResult = (deps.readProviderArtifact || readProviderArtifactSync)({
    path: artifactPath,
    codingSessionId,
    runtimeGeneration,
    trustedRoot: root,
  });
  if (artifactResult?.kind !== 'present'
    || artifactResult.artifact?.tool !== 'codex') {
    return failed('managed-recovery-provider-artifact-unconfirmed');
  }

  const domain = (deps.inspectCredentialDomain
    || inspectQuarantinedLocalCodexCredentialDomain)({
    root,
    codingSessionId,
    providerArtifact: artifactResult.artifact,
  });
  if (!domain?.ok) {
    return failed(domain?.reason || 'managed-recovery-domain-unconfirmed');
  }

  const currentRegistry = registry || { entries: [entry] };
  const scan = await (deps.scanRuntimeSidecars || scanRuntimeSidecars)({
    mcDir: root,
    registry: currentRegistry,
    minAgeMs: 0,
  }).catch(() => null);
  const zombieHost = scan?.zombie_hosts?.find(
    (item) => item.session_id === codingSessionId,
  ) || null;

  return {
    ok: true,
    recoverable: true,
    name: entry.name,
    coding_session_id: codingSessionId,
    runtime_generation: runtimeGeneration,
    provider_session_id: artifactResult.artifact.provider_session_id,
    exit_observed_at: lifecycle.record.observed_at,
    actions: [
      'persist-provider-auth',
      'archive-provider-session',
      'update-provider-registry',
      ...(zombieHost ? ['retire-exited-host'] : []),
    ],
    _private: {
      descriptor: domain.descriptor,
      providerArtifact: artifactResult.artifact,
      lifecycle: lifecycle.record,
      zombieHost,
      entryIdentity: entryIdentity(entry),
      root,
    },
  };
}

/**
 * Convert one strictly verified pre-journal generation into the same durable
 * receipt chain used by all new managed launches. Every append is immutable
 * and idempotent, so interruption during import is resumed by the next open.
 */
export async function importManagedCodexRecovery({
  entry,
  localPresence = null,
  root = mcHome(),
  registry = null,
  deps = {},
} = {}) {
  const inspected = await (deps.inspectLegacyRecovery
    || inspectManagedCodexRecovery)({
    entry,
    root,
    registry,
    deps,
  });
  if (!inspected?.ok) {
    const stalePrepared = await recoverUnjournaledManagedCodexResumeDomain({
      entry,
      localPresence,
      root,
      registry,
      deps,
    });
    if (stalePrepared.attempted) return stalePrepared;
    return {
      ...(inspected || failed('managed-recovery-inspection-failed')),
      imported: false,
    };
  }
  const imported = importInspectedManagedCodexRecovery({
    inspection: inspected,
    entry,
    root,
    deps,
  });
  return { attempted: true, ...imported };
}

/**
 * Close a pre-journal resume domain whose provider never changed the restored
 * session. Positive local process-exit proof and byte-identical legacy archive
 * evidence are both required before custody persistence or cleanup.
 */
export async function recoverUnjournaledManagedCodexResumeDomain({
  entry,
  localPresence,
  root = mcHome(),
  registry = null,
  deps = {},
} = {}) {
  const providerSession = entry?.provider_sessions?.providers?.codex;
  const providerSessionId = boundedProviderId(entry?.tool_session_id)
    ? entry.tool_session_id
    : null;
  const providerGeneration = isUuidV4(entry?.tool_session_provider_generation)
    ? entry.tool_session_provider_generation
    : null;
  if (entry?.tool !== 'codex'
    || typeof entry?.coding_session_id !== 'string'
    || !entry.coding_session_id
    || !providerSessionId
    || !providerGeneration
    || providerSession?.session_id !== providerSessionId
    || providerSession?.runtime_generation !== providerGeneration
    || localPresence?.verdict !== 'exited'
    || !isUuidV4(localPresence.runtime_generation)) {
    return { ...failed('managed-legacy-prepared-recovery-inapplicable'), attempted: false };
  }

  const presence = (deps.inspectCredentialDomainPresence
    || inspectLocalCodexCredentialDomainPresence)({
    root,
    codingSessionId: entry.coding_session_id,
  });
  if (presence?.kind === 'absent') {
    return { ...failed('managed-legacy-prepared-domain-absent'), attempted: false };
  }
  if (presence?.kind !== 'present') {
    return {
      ...failed(presence?.reason || 'managed-legacy-prepared-domain-unconfirmed'),
      attempted: true,
    };
  }
  const descriptor = presence.descriptor;
  if (descriptor.provider_config_path !== join(descriptor.codex_home, 'config.toml')) {
    return { ...failed('managed-legacy-prepared-domain-not-legacy'), attempted: false };
  }

  const hostPaths = (deps.sessionHostPaths || sessionHostPaths)(
    entry.coding_session_id,
    { root },
  );
  const lifecycle = await (deps.readSessionLifecycle || readSessionLifecycle)({
    path: hostPaths.lifecyclePath,
    codingSessionId: entry.coding_session_id,
  }).catch(() => ({ verdict: 'unknown', record: null }));
  const lifecycleGeneration = lifecycle?.record?.runtime_generation;
  const exactExit = lifecycleGeneration === localPresence.runtime_generation
    && (
      lifecycle.verdict === 'exited'
      || (lifecycle.verdict === 'live'
        && localPresence.reason === 'host-process-exited')
    );
  if (!exactExit) {
    return { ...failed('managed-legacy-prepared-exit-unconfirmed'), attempted: true };
  }

  const absence = (deps.inspectLegacyProviderAbsence
    || inspectLegacyLocalCodexResumeAbsence)({
    root,
    descriptor,
    providerSessionId,
  });
  if (!absence?.ok) {
    return {
      ...failed(absence?.reason || 'managed-legacy-prepared-provider-unconfirmed'),
      attempted: true,
    };
  }

  const readRegistry = deps.readRegistry || readRegistryStrict;
  const currentRegistry = readRegistry();
  const matches = (currentRegistry?.entries || []).filter(
    (candidate) => entry.session_id
      ? candidate.session_id === entry.session_id
      : candidate.name === entry.name,
  );
  if (matches.length !== 1
    || !sameEntryIdentity(matches[0], entryIdentity(entry))
    || matches[0].tool_session_id !== providerSessionId
    || matches[0].tool_session_provider_generation !== providerGeneration) {
    return { ...failed('managed-legacy-prepared-registry-changed'), attempted: true };
  }

  const close = await (deps.closeCredentialDomain
    || closeLocalCodexCredentialDomain)({
    descriptor,
    providerArtifact: {
      schema: 'mc-provider-artifact-v1',
      coding_session_id: entry.coding_session_id,
      runtime_generation: providerGeneration,
      tool: 'codex',
      provider_session_id: providerSessionId,
      transcript_path: absence.transcript_path,
      captured_at: lifecycle.record?.observed_at || new Date().toISOString(),
    },
    portal: deps.portal,
  }).catch(() => null);
  if (!close?.ok) {
    return {
      ...failed(close?.reason || 'managed-legacy-prepared-domain-close-failed'),
      attempted: true,
    };
  }
  const retired = await (deps.reapZombieHosts || reapZombieHosts)([{
    kind: 'exited-host',
    session_id: entry.coding_session_id,
    path: hostPaths.dir,
    pid: null,
    reason: 'exact-host-process-exited',
  }]).catch(() => null);
  if (!retired?.ok || retired.removed?.length !== 1) {
    return {
      ...failed('managed-legacy-prepared-host-retirement-failed'),
      attempted: true,
      state_archived: true,
    };
  }
  return {
    ok: true,
    attempted: true,
    imported: false,
    recovered: true,
    provider_session_id: providerSessionId,
    runtime_generation: providerGeneration,
    host_retired: true,
  };
}

export function importInspectedManagedCodexRecovery({
  inspection,
  entry,
  root = inspection?._private?.root || mcHome(),
  deps = {},
} = {}) {
  const artifact = inspection?._private?.providerArtifact;
  const descriptor = inspection?._private?.descriptor;
  const runtimeGeneration = artifact?.runtime_generation;
  if (!inspection?.ok
    || artifact?.coding_session_id !== inspection.coding_session_id
    || artifact?.tool !== 'codex'
    || descriptor?.session_id !== inspection.coding_session_id
    || typeof descriptor?.generation !== 'string'
    || !/^[0-9a-f]{64}$/u.test(descriptor?.manifest_sha256 || '')
    || typeof runtimeGeneration !== 'string') {
    return failed('managed-recovery-import-binding-invalid');
  }
  const priorProviderSessionId = boundedProviderId(entry?.tool_session_id)
    && entry.tool_session_id !== artifact.provider_session_id
    ? entry.tool_session_id
    : null;
  let started;
  try {
    started = (deps.beginManagedGeneration || beginManagedGenerationSync)({
      mcHomeDir: root,
      codingSessionId: inspection.coding_session_id,
      runtimeGeneration,
      mode: priorProviderSessionId ? 'resume' : 'fresh',
      tool: artifact.tool,
      resumeProviderSessionId: priorProviderSessionId,
      recordedAt: inspection.exit_observed_at || artifact.captured_at,
    });
  } catch {
    return failed('managed-recovery-import-intent-failed');
  }
  const transaction = managedTransactionFromIntent(started.intent);
  const append = deps.appendManagedGenerationReceipt
    || appendManagedGenerationReceiptSync;
  const appendReceipt = (phase, data, recordedAt) => append({
    mcHomeDir: root,
    phase,
    codingSessionId: transaction.coding_session_id,
    runtimeGeneration: transaction.runtime_generation,
    intentDigest: transaction.intent_digest,
    recordedAt: recordedAt || inspection.exit_observed_at || artifact.captured_at,
    data,
  });
  const lifecycle = inspection._private.lifecycle || {};
  try {
    appendReceipt('domain-ready', {
      domain_generation: descriptor.generation,
      manifest_digest: descriptor.manifest_sha256,
    });
    appendReceipt('broker-accepted', {});
    appendReceipt('live', {});
    appendReceipt('provider-artifact', {
      provider_session_id: artifact.provider_session_id,
      artifact_digest: sha256(JSON.stringify(artifact)),
      tool: artifact.tool,
      transcript_path: artifact.transcript_path,
      captured_at: artifact.captured_at,
    }, artifact.captured_at);
    appendReceipt('exited', {
      exit_code: Number.isInteger(lifecycle.exit_code) ? lifecycle.exit_code : null,
      signal: typeof lifecycle.signal === 'string' ? lifecycle.signal : null,
    }, inspection.exit_observed_at || lifecycle.observed_at);
  } catch {
    return failed('managed-recovery-import-receipt-failed');
  }
  const inspectGeneration = deps.inspectManagedGeneration
    || inspectManagedGenerationSync;
  const imported = inspectGeneration({
    mcHomeDir: root,
    codingSessionId: transaction.coding_session_id,
    runtimeGeneration: transaction.runtime_generation,
  });
  if (imported?.kind !== 'present' || !imported.receipts?.exited) {
    return failed('managed-recovery-import-unconfirmed');
  }
  return {
    ok: true,
    imported: true,
    transaction,
    generation: imported,
    inspection,
  };
}

/**
 * Apply a previously inspected recovery. The fixed descriptor determines the
 * custody record and rollout; callers cannot choose a secret, path, provider,
 * or destination.
 */
export async function applyManagedCodexRecovery({
  inspection,
  portal,
  deps = {},
} = {}) {
  if (!inspection?.ok || !inspection?._private || !portal?.apiUrl || !portal?.token) {
    return failed('managed-recovery-apply-invalid');
  }
  const readRegistry = deps.readRegistry || readRegistryStrict;
  const registry = readRegistry();
  const matches = (registry?.entries || []).filter(
    (entry) => inspection._private.entryIdentity.session_id
      ? entry.session_id === inspection._private.entryIdentity.session_id
      : entry.name === inspection.name,
  );
  if (matches.length !== 1
    || !sameEntryIdentity(matches[0], inspection._private.entryIdentity)) {
    return failed('managed-recovery-registry-changed');
  }
  const imported = (deps.importInspectedManagedCodexRecovery
    || importInspectedManagedCodexRecovery)({
    inspection,
    entry: matches[0],
    deps,
  });
  if (!imported?.ok) {
    return failed(imported?.reason || 'managed-recovery-import-failed');
  }

  const close = await (deps.closeCredentialDomain
    || closeLocalCodexCredentialDomain)({
    descriptor: inspection._private.descriptor,
    providerArtifact: inspection._private.providerArtifact,
    portal,
    managedTransaction: imported.transaction,
  }).catch(() => null);
  if (!close?.ok) {
    return failed(close?.reason || 'managed-recovery-domain-close-failed');
  }

  const current = matches[0];
  const artifact = inspection._private.providerArtifact;
  const providerPatch = withProviderSession(current, 'codex', {
    session_id: artifact.provider_session_id,
    transcript_path: null,
    runtime_generation: artifact.runtime_generation,
  });
  if (!providerPatch.ok) return failed(providerPatch.reason);

  const nowIso = new Date().toISOString();
  const next = {
    ...registry,
    entries: registry.entries.map((entry) => (
      entry === current
        ? {
            ...entry,
            session_state: 'idle',
            tool_session_id: artifact.provider_session_id,
            tool_session_source: 'codex',
            tool_transcript_path: null,
            tool_session_provider_adapter: MANAGED_CODEX_PROVIDER_ID,
            tool_session_provider_generation: artifact.runtime_generation,
            provider_sessions: providerPatch.providerSessions,
            last_storage_repair_at: nowIso,
            last_storage_repair_reason: 'managed-provider-generation-recovered',
          }
        : entry
    )),
  };
  try {
    (deps.writeRegistry || writeRegistry)(next);
  } catch {
    return failed('managed-recovery-registry-write-failed');
  }

  const zombieHost = inspection._private.zombieHost;
  if (zombieHost) {
    const retired = await (deps.reapZombieHosts || reapZombieHosts)([zombieHost])
      .catch(() => null);
    if (!retired?.ok || retired.removed?.length !== 1) {
      return {
        ...failed('managed-recovery-host-retirement-failed'),
        provider_session_id: artifact.provider_session_id,
        state_archived: true,
        registry_updated: true,
      };
    }
  }

  return {
    ok: true,
    name: inspection.name,
    coding_session_id: inspection.coding_session_id,
    runtime_generation: artifact.runtime_generation,
    provider_session_id: artifact.provider_session_id,
    state_archived: true,
    registry_updated: true,
    host_retired: Boolean(zombieHost),
  };
}

export function publicManagedCodexRecovery(value) {
  if (!value || typeof value !== 'object') return value;
  const { _private, ...safe } = value;
  return safe;
}

function classifyNativeImport({ entry, session } = {}) {
  const generations = Array.isArray(session?.generations)
    ? session.generations
    : [];
  const storedProviderSessionId = boundedProviderId(entry?.tool_session_id)
    && entry.tool_session_source === 'codex'
    ? entry.tool_session_id
    : null;
  if (generations.length === 0) {
    return storedProviderSessionId
      ? {
          applicable: true,
          expectedProviderSessionId: storedProviderSessionId,
          supersededProviderSessionId: null,
          cutoffMs: null,
          repairedCutover: false,
        }
      : { applicable: false, reason: 'managed-native-import-provider-id-missing' };
  }

  const first = generations[0];
  const intentAt = isoTime(first?.intent?.recorded_at);
  const createdAt = isoTime(entry?.created_at);
  if (first?.intent?.sequence !== 1
    || first?.intent?.data?.mode !== 'fresh'
    || first?.intent?.data?.tool !== 'codex'
    || intentAt === null
    || createdAt === null
    || createdAt >= intentAt
    || !generations.every((generation, index) => (
      generation?.intent?.sequence === index + 1
      && generation?.intent?.data?.mode === 'fresh'
      && generation?.intent?.data?.tool === 'codex'
      && isoTime(generation?.intent?.recorded_at) !== null
      && isoTime(generation.intent.recorded_at) >= intentAt
    ))) {
    return { applicable: false, reason: 'managed-native-import-journal-established' };
  }
  return {
    applicable: true,
    expectedProviderSessionId: null,
    supersededProviderSessionId: null,
    cutoffMs: intentAt,
    repairedCutover: true,
  };
}

function hasLegacyRegistryEvidence(entry) {
  if (!boundedProviderId(entry?.tool_session_id)
    || entry?.tool_session_source !== 'codex') return false;
  const transcriptPath = entry?.tool_transcript_path;
  return (typeof transcriptPath === 'string' && transcriptPath.length > 0)
    || entry?.tool_session_provider_adapter !== MANAGED_CODEX_PROVIDER_ID
    || !isUuidV4(entry?.tool_session_provider_generation);
}

function listProviderArtifacts({
  root,
  codingSessionId,
} = {}) {
  const paths = sessionHostPaths(codingSessionId, { root });
  let names;
  try {
    names = readdirSync(paths.providerArtifactsDir)
      .filter((name) => (
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.json$/iu
          .test(name)
      ))
      .sort();
  } catch (error) {
    return error?.code === 'ENOENT'
      ? { ok: false, reason: 'managed-native-import-artifact-missing' }
      : { ok: false, reason: 'managed-native-import-artifacts-unreadable' };
  }
  const artifacts = [];
  for (const name of names) {
    const runtimeGeneration = name.slice(0, -'.json'.length);
    const read = readProviderArtifactSync({
      path: providerArtifactPath(codingSessionId, runtimeGeneration, { root }),
      codingSessionId,
      runtimeGeneration,
      trustedRoot: root,
    });
    if (read?.kind !== 'present') {
      return {
        ok: false,
        reason: `managed-native-import-artifact-${read?.reason || 'unconfirmed'}`,
      };
    }
    artifacts.push(read.artifact);
  }
  return { ok: true, artifacts };
}

function observeNativeCodexArtifact({
  entry,
  providerSessionId,
  sessionsDir,
  deps,
} = {}) {
  const observe = deps.observeProviderArtifact || observeCodexProviderArtifact;
  const observed = observe({
    cwd: entry.worktree_path,
    context: {
      sessions_dir: sessionsDir,
      expected_provider_session_id: providerSessionId,
    },
  });
  if (!observed?.ok
    || observed.evidence?.providerSessionId !== providerSessionId
    || typeof observed.evidence?.transcriptPath !== 'string') {
    return {
      ok: false,
      reason: observed?.reason || 'managed-native-import-artifact-missing',
    };
  }
  let capturedAt;
  try {
    const stat = deps.statFile || statSync;
    capturedAt = new Date(stat(observed.evidence.transcriptPath).mtimeMs)
      .toISOString();
  } catch {
    return { ok: false, reason: 'managed-native-import-artifact-unreadable' };
  }
  return {
    ok: true,
    artifact: {
      schema: 'mc-provider-artifact-v1',
      coding_session_id: entry.coding_session_id,
      runtime_generation: deterministicLegacyGeneration(
        entry.coding_session_id,
        providerSessionId,
      ),
      tool: 'codex',
      provider_session_id: providerSessionId,
      transcript_path: observed.evidence.transcriptPath,
      captured_at: capturedAt,
    },
  };
}

function deterministicLegacyGeneration(codingSessionId, providerSessionId) {
  const digest = sha256(
    `mc-managed-native-import-v1\0${codingSessionId}\0${providerSessionId}`,
  );
  return [
    digest.slice(0, 8),
    digest.slice(8, 12),
    `4${digest.slice(13, 16)}`,
    `8${digest.slice(17, 20)}`,
    digest.slice(20, 32),
  ].join('-');
}

function entryIdentity(entry) {
  return {
    session_id: entry.session_id || null,
    repository_id: entry.repository_id || null,
    name: entry.name,
    coding_session_id: entry.coding_session_id,
    worktree_path: entry.worktree_path || null,
    tool: entry.tool,
  };
}

function sameEntryIdentity(entry, expected) {
  return Object.entries(expected || {}).every(([key, value]) => (
    (entry?.[key] || null) === value
  ));
}

function failed(reason) {
  return { ok: false, recoverable: false, reason };
}

function boundedProviderId(value) {
  return typeof value === 'string'
    && /^[A-Za-z0-9._:-]{1,128}$/u.test(value);
}

function isUuidV4(value) {
  return typeof value === 'string'
    && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu
      .test(value);
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function isoTime(value) {
  if (typeof value !== 'string') return null;
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString() === value
    ? parsed.getTime()
    : null;
}
