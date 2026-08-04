import { createHash, randomBytes } from 'node:crypto';
import {
  chmodSync,
  closeSync,
  constants,
  existsSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  readSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { isDeepStrictEqual } from 'node:util';

import { canonicalToolId } from '../adapters/index.js';
import { validateJournal as validateLifecycleJournal } from '../runtime/broker/lifecycle-journal.js';
import { mcHome } from './paths.js';
import {
  inspectManagedSessionIdentitySync,
  inspectManagedSessionSync,
} from './managed-generation-journal.js';
import {
  ensurePrivateDirectoryChainSync,
  fsyncDirectorySync,
  publishImmutablePrivateJsonSync,
  readPrivateJsonSync,
} from './private-state.js';
import { migrateRegistry, normalizeToolSessions } from './registry.js';
import {
  createSessionHomeSync,
  readSessionHomeSync,
  sessionHomePaths,
} from './session-home.js';
import {
  MC_SESSION_ID_RE,
  normalizeSessionName,
  validateSessionMetadata,
} from './session-home-schema.js';
import { processIsAlive } from './session-home-lock.js';
import { readNameClaimSync, removeNameClaimIfOwned } from './session-name-catalog.js';
import {
  CONVERSATION_ID_RE,
  GENERATION_ID_RE,
  mintConversationId,
  mintGenerationId,
  mintWorkspaceId,
  WORKSPACE_ID_RE,
} from './session-record-ids.js';
import {
  importRuntimeConversationSync,
  inspectSessionRuntimeSync,
} from './session-runtime-journal.js';
import {
  SESSION_LEGACY_REFERENCE_SCHEMA,
  SESSION_LEGACY_REFERENCE_VERSION,
  readSessionLegacyReferenceSync,
  validateSessionLegacyReference,
  writeSessionLegacyReferenceSync,
} from './session-legacy-reference.js';
import {
  WORKSPACE_RECORD_SCHEMA,
  WORKSPACE_RECORD_VERSION,
  createWorkspaceAssociationSync,
  listWorkspaceAssociationsSync,
  validateWorkspaceRecord,
} from './workspace-record.js';
import {
  SESSION_CUTOVER_COMPLETE_SCHEMA,
  SESSION_CUTOVER_ROLLBACK_SCHEMA,
  SESSION_CUTOVER_STARTED_SCHEMA,
  SESSION_CUTOVER_VERSION,
  readSessionCutoverCompletionSync,
  readSessionCutoverRollbackSync,
  readSessionCutoverStartedSync,
  sessionCutoverCompletionPath,
  sessionCutoverStartedPath,
  sessionCutoverRoot,
} from './session-cutover-interlock.js';

export const SESSION_CUTOVER_PLAN_SCHEMA = 'mc-session-cutover-plan';
export const SESSION_CUTOVER_BACKUP_SCHEMA = 'mc-session-cutover-backup';
export const SESSION_CUTOVER_RECEIPT_SCHEMA = 'mc-session-cutover-receipt';
export { SESSION_CUTOVER_ROLLBACK_SCHEMA } from './session-cutover-interlock.js';

const SHA256 = /^[a-f0-9]{64}$/u;
const SOURCE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const SAFE_ID = /^[A-Za-z0-9._:-]{1,256}$/u;
const TOOL = /^[a-z][a-z0-9_-]{0,63}$/u;
const CONVERSATION_HANDLE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u;
const MAX_REGISTRY_BYTES = 4 * 1024 * 1024;
const MAX_BACKUP_BYTES = 16 * 1024 * 1024;
const MAX_BACKUP_FILE_BYTES = 256 * 1024;
const MAX_TREE_BYTES = 2 * 1024 * 1024 * 1024;
const MAX_TREE_ENTRIES = 50_000;

const LEGACY_TARGETS = Object.freeze([
  { key: 'global-broker-socket', relative_path: 'broker.sock', authority_kind: 'endpoint' },
  { key: 'global-provider-artifact-socket', relative_path: 'provider-artifact.sock', authority_kind: 'endpoint' },
  { key: 'global-broker-pid', relative_path: 'broker.pid', authority_kind: 'endpoint' },
  { key: 'cloud-broker-pid', relative_path: 'broker-cloud.pid', authority_kind: 'endpoint' },
  { key: 'runtime-hosts', relative_path: 'hosts', authority_kind: 'directory' },
  { key: 'managed-identities', relative_path: 'managed-session-identities', authority_kind: 'directory' },
  { key: 'managed-generations', relative_path: 'managed-sessions', authority_kind: 'directory' },
  { key: 'managed-provider-state', relative_path: 'managed-provider-state', authority_kind: 'directory' },
  { key: 'registry', relative_path: 'registry.json', authority_kind: 'file' },
]);

export function createSessionCutoverPlanSync({
  mcHomeDir = mcHome(),
  sourceId,
  now = () => new Date().toISOString(),
  random = randomBytes,
  isAlive = processIsAlive,
  afterWrite = null,
} = {}) {
  const root = normalizedRoot(mcHomeDir);
  assertSourceId(sourceId);
  const paths = cutoverPaths(root);
  ensurePrivateDirectoryChainSync({ trustedRoot: root, directory: paths.root });

  const existing = readCutoverPlanSync({ mcHomeDir: root });
  if (existing.kind === 'present') {
    if (existing.value.source_id !== sourceId) throw cutoverError('source-id-conflict');
    ensureBackupSync(existing.value, { mcHomeDir: root, afterWrite });
    return existing.value;
  }
  if (existing.kind === 'unknown') throw cutoverError(existing.reason);
  if (readSessionCutoverCompletionSync({ mcHomeDir: root }).kind !== 'absent') {
    throw cutoverError('cutover-already-complete');
  }

  const createdAt = exactIso(now());
  const sources = LEGACY_TARGETS.map((target) => snapshotLegacyTargetSync(root, target));
  const registrySource = sources.find((source) => source.key === 'registry');
  const registry = readLegacyRegistrySync(root, registrySource, random);
  const lifecycle = inspectLegacyLifecycleSync({ mcHomeDir: root, registry, isAlive });
  if (lifecycle.blockers.length > 0) {
    const error = cutoverError('live-incompatible-runtimes');
    error.sessions = lifecycle.blockers;
    error.blocking = lifecycle.blocking;
    throw error;
  }

  const names = new Set();
  const sessions = registry.entries.map((entry, entryIndex) => {
    const normalizedName = normalizeSessionName(entry.name);
    if (names.has(normalizedName)) throw cutoverError('duplicate-session-name');
    names.add(normalizedName);
    return planSession({
      root,
      entry,
      entryIndex,
      sourceId,
      createdAt,
      registrySha256: registrySource.content_sha256,
      legacySessionId: registry.legacy_session_ids?.[entryIndex] ?? entry.session_id,
      lifecycle: lifecycle.bySession.get(entry.coding_session_id) || null,
      random,
    });
  });
  const backupItems = collectBackupItems(sources);
  const unsigned = {
    schema: SESSION_CUTOVER_PLAN_SCHEMA,
    version: SESSION_CUTOVER_VERSION,
    source_id: sourceId,
    created_at: createdAt,
    sources,
    backup_items: backupItems,
    sessions,
  };
  const plan = { ...unsigned, plan_sha256: digestValue(unsigned) };
  validateCutoverPlanOrThrow(plan);
  publishImmutablePrivateJsonSync({
    path: paths.planPath,
    value: plan,
    trustedRoot: root,
    random,
  });
  afterWrite?.('plan');
  ensureBackupSync(plan, { mcHomeDir: root, afterWrite });
  return plan;
}

/**
 * Answer "can this machine migrate, and if not, what exactly is in the way"
 * without writing anything. A refusal the user cannot inspect is
 * indistinguishable from a broken tool, which is how the old interlock read
 * from the outside: one error code, no subject, no remedy.
 */
export function inspectSessionCutoverReadinessSync({
  mcHomeDir = mcHome(),
  isAlive = processIsAlive,
} = {}) {
  const root = normalizedRoot(mcHomeDir);
  const completion = readSessionCutoverCompletionSync({ mcHomeDir: root });
  if (completion.kind === 'unknown') throw cutoverError(completion.reason);
  if (completion.kind === 'present') {
    return { state: 'complete', completion: completion.value, legacy_sessions: 0, blocking: [] };
  }
  const registryPath = join(root, 'registry.json');
  const registry = readLegacyRegistrySync(
    root,
    { exists: existsNoFollow(registryPath) },
    randomBytes,
  );
  const lifecycle = inspectLegacyLifecycleSync({ mcHomeDir: root, registry, isAlive });
  return {
    state: lifecycle.blocking.length > 0 ? 'blocked' : 'ready',
    completion: null,
    legacy_sessions: (registry.entries || []).length,
    blocking: lifecycle.blocking,
  };
}

export function applySessionCutoverSync({
  mcHomeDir = mcHome(),
  now = () => new Date().toISOString(),
  random = randomBytes,
  isAlive = processIsAlive,
  afterWrite = null,
} = {}) {
  const root = normalizedRoot(mcHomeDir);
  const completion = readSessionCutoverCompletionSync({ mcHomeDir: root });
  if (completion.kind === 'present') return { ok: true, duplicate: true, completion: completion.value };
  if (completion.kind === 'unknown') throw cutoverError(completion.reason);
  if (readRollbackSync(root).kind === 'present') throw cutoverError('cutover-rolled-back');
  const plan = requireCutoverPlan(root);
  requireBackup(root, plan);

  const cutoverStarted = plan.sources.some((source) => (
    existsNoFollow(quarantinePath(root, source)) || validBlocker(root, plan, source)
  ));
  if (!cutoverStarted) {
    const lifecycle = inspectLegacyLifecycleSync({
      mcHomeDir: root,
      registry: { entries: plan.sessions.map((session) => session.registry_projection) },
      isAlive,
    });
    if (lifecycle.blockers.length > 0) {
      const error = cutoverError('live-incompatible-runtimes');
      error.sessions = lifecycle.blockers;
      error.blocking = lifecycle.blocking;
      throw error;
    }
    verifyLegacySourcesUnchangedSync(root, plan.sources);
  }

  const startedRead = readSessionCutoverStartedSync({ mcHomeDir: root });
  if (startedRead.kind === 'absent') {
    const started = {
      schema: SESSION_CUTOVER_STARTED_SCHEMA,
      version: SESSION_CUTOVER_VERSION,
      plan_sha256: plan.plan_sha256,
      started_at: exactIso(now()),
    };
    publishImmutablePrivateJsonSync({
      path: sessionCutoverStartedPath(root),
      value: started,
      trustedRoot: root,
      random,
    });
    afterWrite?.('started');
  } else if (startedRead.kind !== 'present'
    || startedRead.value.plan_sha256 !== plan.plan_sha256) {
    throw cutoverError('cutover-started-receipt-conflict');
  }

  for (const source of plan.sources) {
    quarantineLegacyTargetSync({ root, plan, source, afterWrite });
    writeStepReceiptSync({ root, plan, step: `quarantine:${source.key}`, now, random });
    afterWrite?.(`quarantine:${source.key}:receipt`);
  }
  for (const session of plan.sessions) {
    importPlannedSessionSync({ root, plan, session, random, afterWrite });
    writeStepReceiptSync({ root, plan, step: `session:${session.mc_session_id}`, now, random });
    afterWrite?.(`session:${session.mc_session_id}`);
  }
  verifyAppliedCutoverSync({ root, plan });
  const value = {
    schema: SESSION_CUTOVER_COMPLETE_SCHEMA,
    version: SESSION_CUTOVER_VERSION,
    plan_sha256: plan.plan_sha256,
    source_id: plan.source_id,
    completed_at: exactIso(now()),
    session_count: plan.sessions.length,
  };
  publishImmutablePrivateJsonSync({
    path: sessionCutoverCompletionPath(root),
    value,
    trustedRoot: root,
    random,
  });
  afterWrite?.('complete');
  return { ok: true, duplicate: false, completion: value };
}

export function rollbackSessionCutoverSync({
  mcHomeDir = mcHome(),
  now = () => new Date().toISOString(),
  random = randomBytes,
  afterWrite = null,
} = {}) {
  const root = normalizedRoot(mcHomeDir);
  if (readSessionCutoverCompletionSync({ mcHomeDir: root }).kind !== 'absent') {
    throw cutoverError('rollback-after-publication-refused');
  }
  const prior = readRollbackSync(root);
  if (prior.kind === 'present') return { ok: true, duplicate: true, rollback: prior.value };
  if (prior.kind === 'unknown') throw cutoverError(prior.reason);
  const plan = requireCutoverPlan(root);

  for (const session of [...plan.sessions].reverse()) {
    removeImportedSessionSync({ root, plan, session, afterWrite });
    afterWrite?.(`rollback-session:${session.mc_session_id}:complete`);
  }
  for (const source of [...plan.sources].reverse()) {
    restoreLegacyTargetSync({ root, plan, source });
    afterWrite?.(`rollback-source:${source.key}`);
  }
  const value = {
    schema: SESSION_CUTOVER_ROLLBACK_SCHEMA,
    version: SESSION_CUTOVER_VERSION,
    plan_sha256: plan.plan_sha256,
    rolled_back_at: exactIso(now()),
  };
  publishImmutablePrivateJsonSync({
    path: cutoverPaths(root).rollbackPath,
    value,
    trustedRoot: root,
    random,
  });
  afterWrite?.('rollback');
  return { ok: true, duplicate: false, rollback: value };
}

export function inspectSessionCutoverSync({ mcHomeDir = mcHome() } = {}) {
  const root = normalizedRoot(mcHomeDir);
  const plan = readCutoverPlanSync({ mcHomeDir: root });
  const backup = readBackupManifestSync(root);
  const started = readSessionCutoverStartedSync({ mcHomeDir: root });
  const completion = readSessionCutoverCompletionSync({ mcHomeDir: root });
  const rollback = readRollbackSync(root);
  const state = completion.kind === 'present'
    ? 'complete'
    : rollback.kind === 'present'
      ? 'rolled-back'
      : started.kind === 'present'
        ? 'applying'
        : plan.kind === 'present'
          ? 'planned'
          : 'absent';
  return { state, plan, backup, started, completion, rollback };
}

export function readCutoverPlanSync({ mcHomeDir = mcHome() } = {}) {
  const root = normalizedRoot(mcHomeDir);
  return readPrivateJsonSync({
    path: cutoverPaths(root).planPath,
    trustedRoot: root,
    validate: validateCutoverPlan,
    maxBytes: 4 * 1024 * 1024,
  });
}

function planSession({
  root,
  entry,
  entryIndex,
  sourceId,
  createdAt,
  registrySha256,
  legacySessionId,
  lifecycle,
  random,
}) {
  if (!MC_SESSION_ID_RE.test(entry.session_id || '')) throw cutoverError('invalid-session-id');
  const objective = entry.session_objective ?? null;
  if (objective !== null && (typeof objective !== 'string'
    || objective.length > 2048 || objective.includes('\u0000'))) {
    throw cutoverError('invalid-session-objective');
  }
  const rawPaths = [entry.worktree_path, entry.primary_worktree]
    .filter((value, index, values) => value != null && values.indexOf(value) === index);
  for (const path of rawPaths) {
    if (!canonicalAbsolutePath(path)) throw cutoverError('invalid-workspace-path');
  }
  const preferredLaunchCwd = rawPaths[0] || null;
  const repository = entry.repository_id
    ? {
        repository_identity: entry.repository_id,
        public_ref: publicRef(entry.repository_identity?.canonical),
        git_common_dir: null,
      }
    : null;
  const checkout = entry.branch
    ? { git_dir: null, branch: entry.branch, head_sha: null }
    : null;
  const workspaces = rawPaths.map((path, index) => ({
    workspace_id: mintWorkspaceId(random),
    kind: path === entry.worktree_path && repository && checkout
      ? 'worktree'
      : repository
        ? 'repository'
        : 'directory',
    current_path: path,
    path_state: existsSync(path) ? 'present' : 'missing',
    repository,
    checkout: path === entry.worktree_path && repository && checkout ? checkout : null,
    preferred_launch: index === 0,
  }));

  const normalized = normalizeToolSessions(entry);
  if (!normalized.ok) throw cutoverError(`tool-session-${normalized.reason}`);
  const handles = new Map();
  for (const [tool, value] of Object.entries(normalized.providerSessions.providers)) {
    const canonicalTool = canonicalToolId(tool) || tool;
    if (value.session_id) {
      const prior = handles.get(canonicalTool);
      if (prior && prior.handle !== value.session_id) {
        throw cutoverError('tool-session-canonical-conflict');
      }
      handles.set(canonicalTool, {
        tool: canonicalTool,
        handle: value.session_id,
        evidence_sha256: digestValue(value),
      });
    }
  }

  const identities = [];
  const managedGenerations = [];
  if (entry.coding_session_id) {
    if (!SAFE_ID.test(entry.coding_session_id)) throw cutoverError('invalid-coding-session-id');
    const identity = inspectManagedSessionIdentitySync({
      mcHomeDir: root,
      sessionName: entry.name,
      registrySessionId: entry.session_id,
      legacySessionKey: entry.legacy_session_key || null,
    });
    if (identity.kind === 'unknown') throw cutoverError(`managed-identity-${identity.reason}`);
    if (identity.kind === 'present') {
      // Managed identities are keyed by session name, so reusing a name
      // leaves the previous session's identity sitting under it. The registry
      // entry is the current truth; a disagreeing identity is a leftover, and
      // refusing the whole migration over one of them stranded every other
      // session on the machine. It is recorded as stale and deliberately not
      // bound — binding the wrong identity would hand a session another
      // session's provider credentials, which is the risk actually worth
      // failing closed on.
      const bound = identity.identity.coding_session_id === entry.coding_session_id
        && identity.identity.session_name === entry.name;
      identities.push(reference('managed-identity', entry.coding_session_id, entry.session_id,
        bound ? 'bound' : 'stale', digestValue(identity.identity)));
    }
    const managed = inspectManagedSessionSync({ mcHomeDir: root, codingSessionId: entry.coding_session_id });
    if (managed.kind === 'unknown') throw cutoverError(`managed-generation-${managed.reason}`);
    // A session that was resumed, replaced, or switched tools holds a
    // different provider conversation in each generation. That is its
    // history, not a contradiction — treating any disagreement as a conflict
    // meant an ordinary long-lived session could never be migrated at all.
    // The registry's own tool_sessions win, because that is the conversation
    // the session was using when it stopped; a generation only supplies a
    // handle for a tool the registry never recorded, and the most recent
    // generation is the one that speaks for it. Every generation is still
    // preserved individually as a reference below.
    const generationHandles = new Map();
    for (const generation of managed.generations || []) {
      const artifact = generation.receipts?.['provider-artifact'];
      if (artifact) {
        const artifactTool = canonicalToolId(artifact.data.tool) || artifact.data.tool;
        generationHandles.set(artifactTool, {
          tool: artifactTool,
          handle: artifact.data.provider_session_id,
          evidence_sha256: digestValue(artifact),
        });
      }
      managedGenerations.push(reference(
        'managed-generation',
        generation.runtime_generation,
        null,
        generation.phase,
        digestValue({ intent: generation.intent, receipts: generation.receipts }),
      ));
    }
    for (const [tool, value] of generationHandles) {
      if (!handles.has(tool)) handles.set(tool, value);
    }
  }
  if (handles.size > 0 && preferredLaunchCwd === null) {
    throw cutoverError('conversation-workspace-missing');
  }

  const conversations = [...handles.values()]
    .sort((left, right) => left.tool.localeCompare(right.tool))
    .map((item) => ({
      ...item,
      generation_id: mintGenerationId(random),
      conversation_id: mintConversationId(random),
    }));
  const runtimeHosts = lifecycle
    ? [reference('runtime-lifecycle', lifecycle.runtime_generation, null,
      lifecycle.state, lifecycle.source_sha256)]
    : [];
  const projectionState = typeof entry.session_state === 'string' ? entry.session_state : null;
  const sessionCreatedAt = validIso(entry.created_at) ? entry.created_at : createdAt;
  const target = {
    mc_session_id: entry.session_id,
    source_id: sourceId,
    name: entry.name,
    objective,
    preferred_launch_cwd: preferredLaunchCwd,
    created_at: sessionCreatedAt,
    workspaces,
    conversations,
    registry_projection: {
      session_id: entry.session_id,
      name: entry.name,
      coding_session_id: entry.coding_session_id || null,
      session_state: projectionState,
      tool: canonicalToolId(entry.tool) || entry.tool || 'codex',
    },
    legacy_references: {
      registry: {
        entry_index: entryIndex,
        source_sha256: registrySha256,
        legacy_session_id: safeId(legacySessionId),
        coding_session_id: entry.coding_session_id || null,
      },
      identities,
      managed_generations: managedGenerations,
      runtime_hosts: runtimeHosts,
      projections: [reference('registry-projection', entry.session_id, entry.session_id,
        projectionState, digestValue({
          session_state: entry.session_state ?? null,
          tool: entry.tool ?? null,
          branch: entry.branch ?? null,
          worktree_path: entry.worktree_path ?? null,
        }))],
    },
  };
  const preexisting = readSessionHomeSync({ mcHomeDir: root, mcSessionId: target.mc_session_id });
  if (preexisting.kind !== 'absent') throw cutoverError('target-session-already-exists');
  const metadataCheck = validateSessionMetadata({
    schema: 'mc-session-metadata',
    version: 1,
    mc_session_id: target.mc_session_id,
    revision: 1,
    name_revision: 1,
    name: target.name,
    normalized_name: normalizeSessionName(target.name),
    objective: target.objective,
    preferred_launch_cwd: target.preferred_launch_cwd,
    created_at: target.created_at,
    updated_at: target.created_at,
  });
  if (!metadataCheck.ok) throw cutoverError(metadataCheck.reason);
  return target;
}

function importPlannedSessionSync({ root, plan, session, random, afterWrite }) {
  let current = readSessionHomeSync({ mcHomeDir: root, mcSessionId: session.mc_session_id });
  if (current.kind === 'absent') {
    current = createSessionHomeSync({
      mcHomeDir: root,
      mcSessionId: session.mc_session_id,
      sourceId: session.source_id,
      name: session.name,
      objective: session.objective,
      preferredLaunchCwd: session.preferred_launch_cwd,
      now: () => session.created_at,
      random,
    });
    afterWrite?.(`session:${session.mc_session_id}:home`);
  }
  if (current.kind !== 'present'
    || current.catalog_state !== 'ready'
    || current.identity.owner.source_id !== session.source_id
    || current.metadata.name !== session.name
    || current.metadata.objective !== session.objective
    || current.metadata.preferred_launch_cwd !== session.preferred_launch_cwd
    || current.metadata.created_at !== session.created_at) {
    throw cutoverError('target-session-conflict');
  }

  const listed = listWorkspaceAssociationsSync({ mcHomeDir: root, mcSessionId: session.mc_session_id });
  if (listed.issues.length > 0) throw cutoverError('target-workspace-state-unsafe');
  const byId = new Map(listed.workspaces.map((workspace) => [workspace.workspace_id, workspace]));
  for (const workspace of session.workspaces) {
    const existing = byId.get(workspace.workspace_id);
    if (!existing) {
      createWorkspaceAssociationSync({
        mcHomeDir: root,
        mcSessionId: session.mc_session_id,
        workspaceId: workspace.workspace_id,
        kind: workspace.kind,
        currentPath: workspace.current_path,
        pathState: workspace.path_state,
        repository: workspace.repository,
        checkout: workspace.checkout,
        ownership: { kind: 'external' },
        preferredLaunch: workspace.preferred_launch,
        now: () => session.created_at,
        random,
      });
      afterWrite?.(`session:${session.mc_session_id}:workspace:${workspace.workspace_id}`);
      continue;
    }
    if (existing.current_path !== workspace.current_path
      || existing.kind !== workspace.kind
      || !isDeepStrictEqual(existing.repository, workspace.repository)
      || !isDeepStrictEqual(existing.checkout, workspace.checkout)
      || existing.ownership.kind !== 'external') {
      throw cutoverError('target-workspace-conflict');
    }
  }

  let previous = null;
  for (const conversation of session.conversations) {
    const action = previous === null
      ? 'start'
      : previous.tool === conversation.tool
        ? 'replace'
        : 'switch';
    importRuntimeConversationSync({
      mcHomeDir: root,
      mcSessionId: session.mc_session_id,
      generationId: conversation.generation_id,
      conversationId: conversation.conversation_id,
      action,
      tool: conversation.tool,
      workspaceId: session.workspaces[0]?.workspace_id || null,
      launchCwd: session.preferred_launch_cwd,
      previousConversationId: previous?.conversation_id || null,
      previousGenerationId: null,
      replacementReason: action === 'replace' ? 'legacy-migration' : null,
      handoffSha256: action === 'switch'
        ? digestValue({ plan_sha256: plan.plan_sha256, generation_id: conversation.generation_id })
        : null,
      handle: conversation.handle,
      legacyEvidenceSha256: conversation.evidence_sha256,
      recordedAt: plan.created_at,
      afterWrite: (label) => {
        afterWrite?.(
          `session:${session.mc_session_id}:runtime:${conversation.generation_id}:${label}`,
        );
      },
      random,
    });
    previous = conversation;
  }

  const legacyValue = {
    schema: SESSION_LEGACY_REFERENCE_SCHEMA,
    version: SESSION_LEGACY_REFERENCE_VERSION,
    mc_session_id: session.mc_session_id,
    migration_plan_sha256: plan.plan_sha256,
    ...session.legacy_references,
  };
  const existingReference = readSessionLegacyReferenceSync({
    mcHomeDir: root,
    mcSessionId: session.mc_session_id,
  });
  if (existingReference.kind === 'absent') {
    writeSessionLegacyReferenceSync({
      mcHomeDir: root,
      mcSessionId: session.mc_session_id,
      value: legacyValue,
      random,
    });
    afterWrite?.(`session:${session.mc_session_id}:legacy-reference`);
  } else if (existingReference.kind !== 'present'
    || !isDeepStrictEqual(existingReference.value, legacyValue)) {
    throw cutoverError('target-legacy-reference-conflict');
  }
}

function verifyAppliedCutoverSync({ root, plan }) {
  for (const source of plan.sources) {
    if (!validBlocker(root, plan, source)) throw cutoverError(`interlock-${source.key}-missing`);
    if (source.exists) {
      const quarantine = quarantinePath(root, source);
      const snapshot = snapshotPathSync(quarantine, source.key, source.authority_kind);
      if (snapshot.digest !== source.digest) throw cutoverError(`quarantine-${source.key}-mismatch`);
    }
  }
  for (const session of plan.sessions) {
    const read = readSessionHomeSync({ mcHomeDir: root, mcSessionId: session.mc_session_id });
    const runtime = inspectSessionRuntimeSync({ mcHomeDir: root, mcSessionId: session.mc_session_id });
    const referenceRead = readSessionLegacyReferenceSync({ mcHomeDir: root, mcSessionId: session.mc_session_id });
    if (read.kind !== 'present' || read.catalog_state !== 'ready'
      || runtime.kind !== 'present' || runtime.active_generation !== null
      || runtime.conversations.length !== session.conversations.length
      || referenceRead.kind !== 'present'
      || referenceRead.value.migration_plan_sha256 !== plan.plan_sha256) {
      throw cutoverError(`session-${session.mc_session_id}-verification-failed`);
    }
  }
}

function removeImportedSessionSync({ root, plan, session, afterWrite }) {
  const paths = sessionHomePaths({
    mcHomeDir: root,
    mcSessionId: session.mc_session_id,
    normalizedName: normalizeSessionName(session.name),
  });
  const rollbackHome = join(cutoverPaths(root).rollbackSessionsRoot, session.mc_session_id);
  const read = readSessionHomeSync({ mcHomeDir: root, mcSessionId: session.mc_session_id });
  if (read.kind === 'unknown') throw cutoverError('rollback-session-ownership-unproven');
  if (read.kind === 'present') {
    const referenceRead = readSessionLegacyReferenceSync({
      mcHomeDir: root,
      mcSessionId: session.mc_session_id,
    });
    if (read.identity.owner.source_id !== session.source_id
      || read.metadata.name !== session.name
      || read.metadata.objective !== session.objective
      || read.metadata.preferred_launch_cwd !== session.preferred_launch_cwd
      || read.metadata.created_at !== session.created_at
      || read.metadata.revision !== 1
      || read.metadata.name_revision !== 1
      || (referenceRead.kind === 'present'
        && referenceRead.value.migration_plan_sha256 !== plan.plan_sha256)
      || referenceRead.kind === 'unknown') {
      throw cutoverError('rollback-session-ownership-unproven');
    }
    if (existsNoFollow(rollbackHome)) throw cutoverError('rollback-session-quarantine-conflict');
    ensurePrivateDirectoryChainSync({
      trustedRoot: root,
      directory: cutoverPaths(root).rollbackSessionsRoot,
    });
    renameSync(paths.home, rollbackHome);
    fsyncDirectorySync(paths.sessionsRoot);
    fsyncDirectorySync(cutoverPaths(root).rollbackSessionsRoot);
    afterWrite?.(`rollback-session:${session.mc_session_id}:home-quarantined`);
  } else if (existsNoFollow(rollbackHome) && !isDirectoryNoFollow(rollbackHome)) {
    throw cutoverError('rollback-session-ownership-unproven');
  }
  const claim = readNameClaimSync({
    mcHomeDir: root,
    normalizedName: normalizeSessionName(session.name),
  });
  if (claim.kind === 'unknown'
    || (claim.kind === 'present'
      && (claim.value.mc_session_id !== session.mc_session_id
        || claim.value.name_revision !== 1))) {
    throw cutoverError('rollback-name-claim-ownership-unproven');
  }
  if (claim.kind === 'present'
    && !removeNameClaimIfOwned(paths, session.mc_session_id, 1)) {
    throw cutoverError('rollback-name-claim-remove-failed');
  }
  if (claim.kind === 'present') {
    afterWrite?.(`rollback-session:${session.mc_session_id}:name-claim-removed`);
  }
}

function quarantineLegacyTargetSync({ root, plan, source, afterWrite }) {
  const path = join(root, source.relative_path);
  const quarantine = quarantinePath(root, source);
  const blocker = validBlocker(root, plan, source);
  const quarantineExists = existsNoFollow(quarantine);
  if (blocker) {
    if (source.exists && !quarantineExists) throw cutoverError(`quarantine-${source.key}-missing`);
    return;
  }
  if (quarantineExists) {
    if (existsNoFollow(path)) throw cutoverError(`quarantine-${source.key}-source-conflict`);
    const snapshot = snapshotPathSync(quarantine, source.key, source.authority_kind);
    if (snapshot.digest !== source.digest) throw cutoverError(`quarantine-${source.key}-mismatch`);
    installBlocker(root, plan, source);
    afterWrite?.(`quarantine:${source.key}:interlock`);
    return;
  }
  if (source.exists) {
    const current = snapshotPathSync(path, source.key, source.authority_kind);
    if (current.digest !== source.digest) throw cutoverError(`legacy-source-${source.key}-changed`);
    ensurePrivateDirectoryChainSync({ trustedRoot: root, directory: dirname(quarantine) });
    renameSync(path, quarantine);
    fsyncDirectorySync(dirname(path));
    fsyncDirectorySync(dirname(quarantine));
    afterWrite?.(`quarantine:${source.key}:moved`);
  } else if (existsNoFollow(path)) {
    throw cutoverError(`legacy-source-${source.key}-appeared`);
  }
  installBlocker(root, plan, source);
  afterWrite?.(`quarantine:${source.key}:interlock`);
}

function verifyLegacySourcesUnchangedSync(root, sources) {
  for (const source of sources) {
    const path = join(root, source.relative_path);
    if (!source.exists) {
      if (existsNoFollow(path)) throw cutoverError(`legacy-source-${source.key}-appeared`);
      continue;
    }
    if (!existsNoFollow(path)) throw cutoverError(`legacy-source-${source.key}-missing`);
    const current = snapshotPathSync(path, source.key, source.authority_kind);
    if (current.digest !== source.digest) {
      throw cutoverError(`legacy-source-${source.key}-changed`);
    }
  }
}

function restoreLegacyTargetSync({ root, plan, source }) {
  const path = join(root, source.relative_path);
  const quarantine = quarantinePath(root, source);
  if (validBlocker(root, plan, source)) {
    removeBlocker(root, plan, source);
  } else if (existsNoFollow(path)) {
    if (existsNoFollow(quarantine)) {
      throw cutoverError(`rollback-${source.key}-source-conflict`);
    }
    if (!source.exists) throw cutoverError(`rollback-${source.key}-source-conflict`);
    const restored = snapshotPathSync(path, source.key, source.authority_kind);
    if (restored.digest !== source.digest) {
      throw cutoverError(`rollback-${source.key}-restored-source-changed`);
    }
    return;
  }
  if (!source.exists) {
    if (existsNoFollow(quarantine)) {
      throw cutoverError(`rollback-${source.key}-unexpected-quarantine`);
    }
    return;
  }
  if (!existsNoFollow(quarantine)) throw cutoverError(`rollback-${source.key}-quarantine-missing`);
  const snapshot = snapshotPathSync(quarantine, source.key, source.authority_kind);
  if (snapshot.digest !== source.digest) throw cutoverError(`rollback-${source.key}-quarantine-changed`);
  renameSync(quarantine, path);
  fsyncDirectorySync(dirname(path));
}

function installBlocker(root, plan, source) {
  const path = join(root, source.relative_path);
  const marker = blockerMarker(plan, source);
  if (source.authority_kind === 'directory') {
    writeFileSync(path, `${JSON.stringify(marker)}\n`, { flag: 'wx', mode: 0o400 });
  } else {
    mkdirSync(path, { mode: 0o700 });
    writeFileSync(join(path, 'cutover.json'), `${JSON.stringify(marker)}\n`, { flag: 'wx', mode: 0o400 });
    chmodSync(path, 0o500);
  }
  fsyncDirectorySync(dirname(path));
}

function validBlocker(root, plan, source) {
  const path = join(root, source.relative_path);
  try {
    const stat = lstatSync(path);
    let raw;
    if (source.authority_kind === 'directory') {
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 4096) return false;
      raw = readFileSync(path, 'utf8');
    } else {
      if (!stat.isDirectory() || stat.isSymbolicLink()) return false;
      raw = readFileSync(join(path, 'cutover.json'), 'utf8');
    }
    return isDeepStrictEqual(JSON.parse(raw), blockerMarker(plan, source));
  } catch {
    return false;
  }
}

function removeBlocker(root, plan, source) {
  if (!validBlocker(root, plan, source)) throw cutoverError(`rollback-${source.key}-interlock-unsafe`);
  const path = join(root, source.relative_path);
  if (source.authority_kind !== 'directory') chmodSync(path, 0o700);
  rmSync(path, { recursive: source.authority_kind !== 'directory', force: false });
  fsyncDirectorySync(dirname(path));
}

function blockerMarker(plan, source) {
  return {
    schema: 'mc-session-cutover-legacy-interlock',
    version: SESSION_CUTOVER_VERSION,
    plan_sha256: plan.plan_sha256,
    target: source.key,
  };
}

function ensureBackupSync(plan, { mcHomeDir, afterWrite }) {
  const root = normalizedRoot(mcHomeDir);
  const paths = cutoverPaths(root);
  ensurePrivateDirectoryChainSync({ trustedRoot: root, directory: paths.backupFilesRoot });
  let total = 0;
  for (const item of plan.backup_items) {
    total += item.size;
    if (total > MAX_BACKUP_BYTES) throw cutoverError('backup-too-large');
    const sourcePath = join(root, item.relative_path);
    const backupPath = join(paths.backupFilesRoot, item.backup_name);
    if (existsNoFollow(backupPath)) {
      if (sha256File(backupPath) !== item.sha256) throw cutoverError('backup-file-conflict');
      continue;
    }
    if (!existsNoFollow(sourcePath) || sha256File(sourcePath) !== item.sha256) {
      throw cutoverError('backup-source-changed');
    }
    const raw = readBoundedRegularFile(sourcePath, MAX_BACKUP_FILE_BYTES);
    if (raw.length !== item.size || sha256Bytes(raw) !== item.sha256) {
      throw cutoverError('backup-source-changed');
    }
    writeFileSync(backupPath, raw, { flag: 'wx', mode: 0o600 });
    fsyncFile(backupPath);
    fsyncDirectorySync(paths.backupFilesRoot);
    afterWrite?.(`backup:${item.backup_name}`);
  }
  const manifest = {
    schema: SESSION_CUTOVER_BACKUP_SCHEMA,
    version: SESSION_CUTOVER_VERSION,
    plan_sha256: plan.plan_sha256,
    files: plan.backup_items,
    total_bytes: total,
  };
  const current = readBackupManifestSync(root);
  if (current.kind === 'present') {
    if (!isDeepStrictEqual(current.value, manifest)) throw cutoverError('backup-manifest-conflict');
    return;
  }
  if (current.kind === 'unknown') throw cutoverError(current.reason);
  publishImmutablePrivateJsonSync({
    path: paths.backupManifestPath,
    value: manifest,
    trustedRoot: root,
  });
  afterWrite?.('backup-manifest');
}

function requireBackup(root, plan) {
  const read = readBackupManifestSync(root);
  if (read.kind !== 'present' || read.value.plan_sha256 !== plan.plan_sha256) {
    throw cutoverError('backup-unavailable');
  }
  if (!isDeepStrictEqual(read.value.files, plan.backup_items)) {
    throw cutoverError('backup-manifest-conflict');
  }
  for (const item of read.value.files) {
    const path = join(cutoverPaths(root).backupFilesRoot, item.backup_name);
    if (sha256File(path) !== item.sha256) throw cutoverError('backup-verification-failed');
  }
}

function readBackupManifestSync(root) {
  return readPrivateJsonSync({
    path: cutoverPaths(root).backupManifestPath,
    trustedRoot: root,
    validate: validateBackupManifest,
    maxBytes: 4 * 1024 * 1024,
  });
}

function validateBackupManifest(value) {
  if (!plain(value) || !exactKeys(value, [
    'schema', 'version', 'plan_sha256', 'files', 'total_bytes',
  ]) || value.schema !== SESSION_CUTOVER_BACKUP_SCHEMA
    || value.version !== SESSION_CUTOVER_VERSION
    || !SHA256.test(value.plan_sha256 || '')
    || !Array.isArray(value.files)
    || !value.files.every(validBackupItem)
    || !Number.isSafeInteger(value.total_bytes)
    || value.total_bytes < 0
    || value.total_bytes > MAX_BACKUP_BYTES
    || value.files.reduce((total, item) => total + item.size, 0) !== value.total_bytes) {
    return invalid('invalid-backup-manifest');
  }
  return { ok: true, value: structuredClone(value) };
}

function writeStepReceiptSync({ root, plan, step, now, random }) {
  const paths = cutoverPaths(root);
  const name = `${createHash('sha256').update(step).digest('hex')}.json`;
  const path = join(paths.receiptsRoot, name);
  const value = {
    schema: SESSION_CUTOVER_RECEIPT_SCHEMA,
    version: SESSION_CUTOVER_VERSION,
    plan_sha256: plan.plan_sha256,
    step,
    recorded_at: exactIso(now()),
  };
  if (existsNoFollow(path)) {
    const read = readPrivateJsonSync({
      path,
      trustedRoot: root,
      validate: validateStepReceipt,
    });
    if (read.kind !== 'present'
      || read.value.plan_sha256 !== plan.plan_sha256
      || read.value.step !== step) throw cutoverError('receipt-conflict');
    return;
  }
  ensurePrivateDirectoryChainSync({ trustedRoot: root, directory: paths.receiptsRoot });
  publishImmutablePrivateJsonSync({ path, value, trustedRoot: root, random });
}

function validateStepReceipt(value) {
  if (!plain(value) || !exactKeys(value, [
    'schema', 'version', 'plan_sha256', 'step', 'recorded_at',
  ]) || value.schema !== SESSION_CUTOVER_RECEIPT_SCHEMA
    || value.version !== SESSION_CUTOVER_VERSION
    || !SHA256.test(value.plan_sha256 || '')
    || typeof value.step !== 'string' || value.step.length > 512
    || !validIso(value.recorded_at)) return invalid('invalid-step-receipt');
  return { ok: true, value: structuredClone(value) };
}

/**
 * A legacy runtime blocks the cutover when it is *running*, not when some
 * file says it once was.
 *
 * Old mc recorded `state: "live"` in a host journal and `session_state:
 * "live"` in the registry, and a crashed or force-quit session never got to
 * correct either one. Treating those rows as evidence of a running process
 * made the interlock permanent: on a machine with a normal history of exits,
 * every future migration attempt refused, forever, over sessions whose PTYs
 * had been gone for weeks.
 *
 * So liveness is derived from the process table. A recorded `live` row whose
 * broker pid is dead is stale bookkeeping — the migration preserves it in the
 * backup either way. What still refuses is a pid that answers: a host broker
 * that is running, or the global broker, which owns the PTYs of every legacy
 * session it started and would be quarantined out from under itself.
 */
function inspectLegacyLifecycleSync({
  mcHomeDir,
  registry,
  isAlive,
  tolerateQuarantined = false,
}) {
  const bySession = new Map();
  const blockers = new Map();
  const livePids = new Map();
  const block = (id, reason, pid = null) => {
    if (!blockers.has(id)) blockers.set(id, { id, reason, pid });
  };
  const hostsRoot = join(mcHomeDir, 'hosts');
  if (isDirectoryNoFollow(hostsRoot)) {
    for (const hostName of readdirSync(hostsRoot).sort()) {
      const hostRoot = join(hostsRoot, hostName);
      if (!isDirectoryNoFollow(hostRoot)) continue;
      const hostPath = join(hostRoot, 'host.json');
      const host = existsNoFollow(hostPath) ? boundedJson(hostPath, 8192).value : null;
      const hostSession = safeId(host?.session_id) || `legacy-host:${hostName}`;
      const pids = [host?.broker_pid, readPid(join(hostRoot, 'broker.pid'))]
        .filter((pid) => positivePid(pid));
      const alivePid = pids.find((pid) => isAlive(pid)) ?? null;
      if (alivePid !== null) livePids.set(hostSession, alivePid);
      const lifecyclePath = join(hostRoot, 'lifecycle.json');
      if (existsNoFollow(lifecyclePath)) {
        const raw = boundedJson(lifecyclePath, 4096);
        const checked = validateLifecycleJournal(raw.value);
        if (!checked.ok) throw cutoverError(`legacy-lifecycle-${checked.reason}`);
        const record = { ...raw.value, source_sha256: raw.sha256 };
        if (bySession.has(record.coding_session_id)) throw cutoverError('duplicate-lifecycle-session');
        bySession.set(record.coding_session_id, record);
        if (alivePid !== null) livePids.set(record.coding_session_id, alivePid);
        if (record.state === 'live' && alivePid !== null) {
          block(record.coding_session_id, 'runtime-process-alive', alivePid);
        }
      }
      if (alivePid !== null) block(hostSession, 'runtime-process-alive', alivePid);
    }
  } else if (existsNoFollow(hostsRoot) && !tolerateQuarantined) {
    throw cutoverError('unsafe-legacy-hosts-root');
  }
  for (const entry of registry.entries || []) {
    if (entry.coding_session_id) {
      const managed = inspectManagedSessionSync({
        mcHomeDir,
        codingSessionId: entry.coding_session_id,
      });
      if (managed.kind === 'unknown') {
        throw cutoverError(`managed-generation-${managed.reason}`);
      }
      // A non-terminal generation is an unfinished journal, not a process. It
      // blocks only while the runtime that would finish it is still running.
      const managedPid = livePids.get(entry.coding_session_id) ?? null;
      if (managed.active && managedPid !== null) {
        block(entry.coding_session_id, 'managed-generation-active', managedPid);
      }
    }
    if (entry.session_state !== 'live') continue;
    const id = entry.coding_session_id || entry.session_id || entry.name;
    const pid = (entry.coding_session_id && livePids.get(entry.coding_session_id)) ?? null;
    if (pid !== null) block(id, 'runtime-process-alive', pid);
  }
  const globalPid = readPid(join(mcHomeDir, 'broker.pid'));
  if (globalPid && isAlive(globalPid)) {
    block('legacy-global-broker', 'global-broker-alive', globalPid);
  }
  return {
    bySession,
    blockers: [...blockers.keys()].sort(),
    blocking: [...blockers.values()].sort((a, b) => a.id.localeCompare(b.id)),
  };
}

function readLegacyRegistrySync(root, source, random) {
  if (!source.exists) return { schema_version: 3, entries: [], legacy_session_ids: [] };
  const path = join(root, 'registry.json');
  const raw = readBoundedRegularFile(path, MAX_REGISTRY_BYTES);
  let parsed;
  try { parsed = JSON.parse(raw.toString('utf8')); } catch { throw cutoverError('registry-corrupt'); }
  if (!plain(parsed) || !Array.isArray(parsed.entries)) throw cutoverError('registry-invalid-registry');
  const normalized = structuredClone(parsed);
  const legacySessionIds = normalized.entries.map((entry) => {
    if (!plain(entry)) return null;
    const prior = entry.session_id ?? null;
    if (prior !== null && !MC_SESSION_ID_RE.test(prior)) entry.session_id = null;
    return prior;
  });
  const migrated = migrateRegistry(normalized, {
    sessionIdFactory: () => `mcs_${random(12).toString('hex')}`,
    createLocalRepositoryIdentity: false,
  });
  if (!migrated.ok) throw cutoverError(`registry-${migrated.reason}`);
  return { ...migrated.registry, legacy_session_ids: legacySessionIds };
}

function snapshotLegacyTargetSync(root, target) {
  const path = join(root, target.relative_path);
  if (!existsNoFollow(path)) {
    return {
      ...target,
      exists: false,
      digest: digestValue([]),
      content_sha256: digestValue(null),
      entry_count: 0,
      total_bytes: 0,
      backup_files: [],
    };
  }
  const snapshot = snapshotPathSync(path, target.key, target.authority_kind, root);
  return { ...target, exists: true, ...snapshot };
}

function snapshotPathSync(path, key, authorityKind, root = dirname(path)) {
  const entries = [];
  const backupFiles = [];
  let totalBytes = 0;
  const visit = (current, relativePath) => {
    if (entries.length >= MAX_TREE_ENTRIES) throw cutoverError('legacy-tree-entry-limit');
    const stat = lstatSync(current);
    if (stat.isSymbolicLink()) throw cutoverError('legacy-tree-symlink');
    if (stat.isDirectory()) {
      entries.push({ path: relativePath, type: 'directory' });
      for (const name of readdirSync(current).sort()) {
        visit(join(current, name), relativePath ? join(relativePath, name) : name);
      }
      return;
    }
    if (stat.isFile()) {
      totalBytes += stat.size;
      if (totalBytes > MAX_TREE_BYTES) throw cutoverError('legacy-tree-byte-limit');
      const sha256 = sha256File(current);
      entries.push({ path: relativePath, type: 'file', size: stat.size, sha256 });
      if (backupEligible(key, relativePath, stat.size)) {
        backupFiles.push({
          relative_path: relative(root, current),
          size: stat.size,
          sha256,
        });
      }
      return;
    }
    if (stat.isSocket()) {
      entries.push({ path: relativePath, type: 'socket' });
      return;
    }
    throw cutoverError('legacy-tree-special-file');
  };
  visit(path, '');
  return {
    digest: digestValue(entries),
    content_sha256: entries.length === 1 && entries[0].type === 'file'
      ? entries[0].sha256
      : digestValue(entries.filter((entry) => entry.type === 'file')),
    entry_count: entries.length,
    total_bytes: totalBytes,
    backup_files: backupFiles,
  };
}

function collectBackupItems(sources) {
  const items = [];
  let total = 0;
  for (const source of sources) {
    for (const file of source.backup_files) {
      total += file.size;
      if (total > MAX_BACKUP_BYTES) throw cutoverError('backup-too-large');
      items.push({
        relative_path: file.relative_path,
        size: file.size,
        sha256: file.sha256,
        backup_name: `${String(items.length + 1).padStart(8, '0')}.bin`,
      });
    }
  }
  return items;
}

function backupEligible(key, relativePath, size) {
  if (size > MAX_BACKUP_FILE_BYTES) return false;
  if (key === 'registry') return relativePath === '';
  if (key === 'managed-identities') return /^[^/]+\.json$/u.test(relativePath);
  if (key === 'managed-generations') return relativePath.endsWith('.json');
  if (key === 'runtime-hosts') {
    return /(?:^|\/)(?:host|lifecycle|handoff-switch)\.json$/u.test(relativePath)
      || /(?:^|\/)provider-artifacts\/[^/]+\.json$/u.test(relativePath);
  }
  if (key === 'managed-provider-state') {
    return /(?:^|\/)(?:current|manifest)\.json$/u.test(relativePath);
  }
  return false;
}

function validateCutoverPlan(value) {
  try {
    validateCutoverPlanOrThrow(value);
    return { ok: true, value: structuredClone(value) };
  } catch (error) {
    return invalid(error.reason || 'invalid-cutover-plan');
  }
}

function validateCutoverPlanOrThrow(value) {
  if (!plain(value) || !exactKeys(value, [
    'schema', 'version', 'source_id', 'created_at', 'sources', 'backup_items',
    'sessions', 'plan_sha256',
  ]) || value.schema !== SESSION_CUTOVER_PLAN_SCHEMA
    || value.version !== SESSION_CUTOVER_VERSION
    || !SOURCE_ID.test(value.source_id || '')
    || !validIso(value.created_at)
    || !Array.isArray(value.sources) || value.sources.length !== LEGACY_TARGETS.length
    || !Array.isArray(value.backup_items)
    || !Array.isArray(value.sessions)
    || !SHA256.test(value.plan_sha256 || '')) throw cutoverError('invalid-cutover-plan');
  const unsigned = { ...value };
  delete unsigned.plan_sha256;
  if (digestValue(unsigned) !== value.plan_sha256) throw cutoverError('cutover-plan-digest-mismatch');
  for (let index = 0; index < value.sources.length; index += 1) {
    validatePlannedSource(value.sources[index], LEGACY_TARGETS[index]);
  }
  if (!value.backup_items.every(validBackupItem)
    || !isDeepStrictEqual(value.backup_items, collectBackupItems(value.sources))) {
    throw cutoverError('invalid-cutover-backup-items');
  }
  const ids = new Set();
  const names = new Set();
  for (const session of value.sessions) {
    validatePlannedSession(session, value);
    const normalized = normalizeSessionName(session.name);
    if (ids.has(session.mc_session_id) || names.has(normalized)) {
      throw cutoverError('duplicate-cutover-session');
    }
    ids.add(session.mc_session_id);
    names.add(normalized);
  }
}

function validatePlannedSource(source, expected) {
  if (!plain(source) || !exactKeys(source, [
    'key', 'relative_path', 'authority_kind', 'exists', 'digest',
    'content_sha256', 'entry_count', 'total_bytes', 'backup_files',
  ]) || source.key !== expected.key
    || source.relative_path !== expected.relative_path
    || source.authority_kind !== expected.authority_kind
    || typeof source.exists !== 'boolean'
    || !SHA256.test(source.digest || '')
    || !SHA256.test(source.content_sha256 || '')
    || !Number.isSafeInteger(source.entry_count) || source.entry_count < 0
    || source.entry_count > MAX_TREE_ENTRIES
    || !Number.isSafeInteger(source.total_bytes) || source.total_bytes < 0
    || source.total_bytes > MAX_TREE_BYTES
    || !Array.isArray(source.backup_files)
    || !source.backup_files.every((file) => validSourceBackupFile(file, source))) {
    throw cutoverError('invalid-cutover-source');
  }
  if (!source.exists && (source.entry_count !== 0 || source.total_bytes !== 0
    || source.backup_files.length !== 0
    || source.digest !== digestValue([])
    || source.content_sha256 !== digestValue(null))) {
    throw cutoverError('invalid-absent-cutover-source');
  }
  if (source.exists && source.entry_count < 1) throw cutoverError('invalid-cutover-source');
}

function validSourceBackupFile(file, source) {
  if (!plain(file) || !exactKeys(file, ['relative_path', 'size', 'sha256'])
    || !safeRelativePath(file.relative_path)
    || !Number.isSafeInteger(file.size) || file.size < 0
    || file.size > MAX_BACKUP_FILE_BYTES
    || !SHA256.test(file.sha256 || '')) return false;
  const prefix = source.authority_kind === 'directory' ? `${source.relative_path}/` : null;
  if (prefix !== null && !file.relative_path.startsWith(prefix)) return false;
  if (prefix === null && file.relative_path !== source.relative_path) return false;
  const withinSource = prefix === null ? '' : file.relative_path.slice(prefix.length);
  return backupEligible(source.key, withinSource, file.size);
}

function validBackupItem(item, index, items) {
  return plain(item)
    && exactKeys(item, ['relative_path', 'size', 'sha256', 'backup_name'])
    && safeRelativePath(item.relative_path)
    && Number.isSafeInteger(item.size) && item.size >= 0
    && item.size <= MAX_BACKUP_FILE_BYTES
    && SHA256.test(item.sha256 || '')
    && item.backup_name === `${String(index + 1).padStart(8, '0')}.bin`
    && items.findIndex((candidate) => candidate.relative_path === item.relative_path) === index;
}

function validatePlannedSession(session, plan) {
  if (!plain(session) || !exactKeys(session, [
    'mc_session_id', 'source_id', 'name', 'objective', 'preferred_launch_cwd',
    'created_at', 'workspaces', 'conversations', 'registry_projection',
    'legacy_references',
  ]) || !MC_SESSION_ID_RE.test(session.mc_session_id || '')
    || session.source_id !== plan.source_id
    || !validIso(session.created_at)
    || !Array.isArray(session.workspaces) || session.workspaces.length > 4096
    || !Array.isArray(session.conversations) || session.conversations.length > 4096
    || !plain(session.registry_projection) || !plain(session.legacy_references)) {
    throw cutoverError('invalid-cutover-session');
  }
  const metadata = validateSessionMetadata({
    schema: 'mc-session-metadata',
    version: 1,
    mc_session_id: session.mc_session_id,
    revision: 1,
    name_revision: 1,
    name: session.name,
    normalized_name: normalizeSessionName(session.name),
    objective: session.objective,
    preferred_launch_cwd: session.preferred_launch_cwd,
    created_at: session.created_at,
    updated_at: session.created_at,
  });
  if (!metadata.ok) throw cutoverError('invalid-cutover-session-metadata');

  const workspaceIds = new Set();
  let preferred = 0;
  for (const workspace of session.workspaces) {
    if (!plain(workspace) || !exactKeys(workspace, [
      'workspace_id', 'kind', 'current_path', 'path_state', 'repository',
      'checkout', 'preferred_launch',
    ]) || !WORKSPACE_ID_RE.test(workspace.workspace_id || '')
      || workspaceIds.has(workspace.workspace_id)) {
      throw cutoverError('invalid-cutover-workspace');
    }
    workspaceIds.add(workspace.workspace_id);
    preferred += workspace.preferred_launch === true ? 1 : 0;
    const record = validateWorkspaceRecord({
      schema: WORKSPACE_RECORD_SCHEMA,
      version: WORKSPACE_RECORD_VERSION,
      workspace_id: workspace.workspace_id,
      mc_session_id: session.mc_session_id,
      revision: 1,
      kind: workspace.kind,
      current_path: workspace.current_path,
      path_state: workspace.path_state,
      first_observed_at: session.created_at,
      last_observed_at: session.created_at,
      last_present_at: workspace.path_state === 'present' ? session.created_at : null,
      previous_path: null,
      relocated_at: null,
      repository: workspace.repository,
      checkout: workspace.checkout,
      ownership: { kind: 'external' },
      last_launch_used_at: null,
      preferred_launch: workspace.preferred_launch,
    });
    if (!record.ok) throw cutoverError('invalid-cutover-workspace');
  }
  if (preferred > 1
    || (session.preferred_launch_cwd === null && preferred !== 0)
    || (session.preferred_launch_cwd !== null
      && !session.workspaces.some((workspace) => (
        workspace.preferred_launch && workspace.current_path === session.preferred_launch_cwd
      )))) {
    throw cutoverError('invalid-cutover-preferred-workspace');
  }

  const conversationIds = new Set();
  const generationIds = new Set();
  const handles = new Set();
  for (const conversation of session.conversations) {
    if (!plain(conversation) || !exactKeys(conversation, [
      'tool', 'handle', 'evidence_sha256', 'generation_id', 'conversation_id',
    ]) || !TOOL.test(conversation.tool || '')
      || !CONVERSATION_HANDLE.test(conversation.handle || '')
      || !SHA256.test(conversation.evidence_sha256 || '')
      || !GENERATION_ID_RE.test(conversation.generation_id || '')
      || !CONVERSATION_ID_RE.test(conversation.conversation_id || '')
      || conversationIds.has(conversation.conversation_id)
      || generationIds.has(conversation.generation_id)
      || handles.has(`${conversation.tool}\u0000${conversation.handle}`)) {
      throw cutoverError('invalid-cutover-conversation');
    }
    conversationIds.add(conversation.conversation_id);
    generationIds.add(conversation.generation_id);
    handles.add(`${conversation.tool}\u0000${conversation.handle}`);
  }
  if (session.conversations.length > 0 && session.workspaces.length === 0) {
    throw cutoverError('invalid-cutover-conversation-workspace');
  }

  const projection = session.registry_projection;
  if (!exactKeys(projection, [
    'session_id', 'name', 'coding_session_id', 'session_state', 'tool',
  ]) || projection.session_id !== session.mc_session_id
    || projection.name !== session.name
    || !nullableSafeId(projection.coding_session_id)
    || !nullableSafeId(projection.session_state)
    || !TOOL.test(projection.tool || '')) {
    throw cutoverError('invalid-cutover-registry-projection');
  }
  const references = validateSessionLegacyReference({
    schema: SESSION_LEGACY_REFERENCE_SCHEMA,
    version: SESSION_LEGACY_REFERENCE_VERSION,
    mc_session_id: session.mc_session_id,
    migration_plan_sha256: plan.plan_sha256,
    ...session.legacy_references,
  });
  if (!references.ok) throw cutoverError('invalid-cutover-legacy-references');
}

function requireCutoverPlan(root) {
  const read = readCutoverPlanSync({ mcHomeDir: root });
  if (read.kind !== 'present') throw cutoverError(read.reason || 'cutover-plan-missing');
  return read.value;
}

function readRollbackSync(root) {
  return readSessionCutoverRollbackSync({ mcHomeDir: root });
}

function quarantinePath(root, source) {
  return join(cutoverPaths(root).quarantineRoot, source.key);
}

function cutoverPaths(root) {
  const cutoverRoot = sessionCutoverRoot(root);
  return {
    root: cutoverRoot,
    planPath: join(cutoverRoot, 'plan.json'),
    rollbackPath: join(cutoverRoot, 'rollback.json'),
    backupRoot: join(cutoverRoot, 'backup'),
    backupFilesRoot: join(cutoverRoot, 'backup', 'files'),
    backupManifestPath: join(cutoverRoot, 'backup', 'manifest.json'),
    receiptsRoot: join(cutoverRoot, 'receipts'),
    quarantineRoot: join(cutoverRoot, 'quarantine'),
    rollbackSessionsRoot: join(cutoverRoot, 'rollback-sessions'),
  };
}

function reference(kind, legacyId, targetId, state, sourceSha256) {
  return {
    kind,
    legacy_id: legacyId || null,
    target_id: targetId || null,
    state: state || null,
    source_sha256: sourceSha256,
  };
}

function publicRef(canonical) {
  if (typeof canonical !== 'string') return null;
  const match = /^github\.com\/([^/]+\/[^/]+)$/u.exec(canonical);
  return match?.[1] || null;
}

function boundedJson(path, maxBytes) {
  const raw = readBoundedRegularFile(path, maxBytes);
  try {
    return { value: JSON.parse(raw.toString('utf8')), sha256: sha256Bytes(raw) };
  } catch {
    throw cutoverError('corrupt-legacy-json');
  }
}

function readPid(path) {
  try {
    const value = Number(readBoundedRegularFile(path, 32).toString('utf8').trim());
    return positivePid(value) ? value : null;
  } catch {
    return null;
  }
}

function readBoundedRegularFile(path, maxBytes) {
  let fd = null;
  try {
    const before = lstatSync(path);
    if (!before.isFile() || before.isSymbolicLink()
      || !Number.isSafeInteger(before.size) || before.size < 0 || before.size > maxBytes) {
      throw cutoverError('unsafe-legacy-file');
    }
    fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
    const opened = fstatSync(fd);
    if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino
      || opened.size !== before.size) throw cutoverError('unstable-legacy-file');
    const buffer = Buffer.alloc(opened.size);
    let count = 0;
    while (count < buffer.length) {
      const read = readSync(fd, buffer, count, buffer.length - count, count);
      if (read === 0) throw cutoverError('short-legacy-file-read');
      count += read;
    }
    const completed = fstatSync(fd);
    if (completed.dev !== opened.dev || completed.ino !== opened.ino
      || completed.size !== opened.size) throw cutoverError('unstable-legacy-file');
    return buffer;
  } finally {
    if (fd !== null) closeSync(fd);
  }
}

function sha256File(path) {
  const hash = createHash('sha256');
  const buffer = Buffer.alloc(64 * 1024);
  let fd = null;
  try {
    fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
    while (true) {
      const count = readSync(fd, buffer, 0, buffer.length, null);
      if (count === 0) break;
      hash.update(buffer.subarray(0, count));
    }
    return hash.digest('hex');
  } finally {
    if (fd !== null) closeSync(fd);
  }
}

function fsyncFile(path) {
  const fd = openSync(path, constants.O_RDONLY);
  try { fsyncSync(fd); } finally { closeSync(fd); }
}

function digestValue(value) {
  return createHash('sha256').update(stableJson(value)).digest('hex');
}

function sha256Bytes(value) {
  return createHash('sha256').update(value).digest('hex');
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (plain(value)) {
    return `{${Object.keys(value).sort().map((key) => (
      `${JSON.stringify(key)}:${stableJson(value[key])}`
    )).join(',')}}`;
  }
  return JSON.stringify(value);
}

function normalizedRoot(value) {
  if (typeof value !== 'string' || !isAbsolute(value) || resolve(value) !== value) {
    throw cutoverError('invalid-cutover-root');
  }
  return value;
}

function assertSourceId(value) {
  if (!SOURCE_ID.test(value || '')) throw cutoverError('invalid-source-id');
}

function exactIso(value) {
  if (!validIso(value)) throw cutoverError('invalid-cutover-timestamp');
  return value;
}

function canonicalAbsolutePath(value) {
  return typeof value === 'string' && value.length > 0 && value.length <= 4096
    && !value.includes('\u0000') && isAbsolute(value) && resolve(value) === value;
}

function safeRelativePath(value) {
  return typeof value === 'string' && value.length > 0 && value.length <= 4096
    && !value.includes('\u0000') && !isAbsolute(value)
    && value.split('/').every((part) => part.length > 0 && part !== '.' && part !== '..');
}

function validIso(value) {
  return typeof value === 'string' && value.length <= 64 && Number.isFinite(Date.parse(value));
}

function safeId(value) {
  return typeof value === 'string' && SAFE_ID.test(value) ? value : null;
}

function nullableSafeId(value) {
  return value === null || (typeof value === 'string' && SAFE_ID.test(value));
}

function positivePid(value) {
  return Number.isSafeInteger(value) && value >= 1;
}

function existsNoFollow(path) {
  try { lstatSync(path); return true; } catch { return false; }
}

function isDirectoryNoFollow(path) {
  try {
    const stat = lstatSync(path);
    return stat.isDirectory() && !stat.isSymbolicLink();
  } catch {
    return false;
  }
}

function plain(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function exactKeys(value, keys) {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length
    && actual.every((key, index) => key === expected[index]);
}

function invalid(reason) {
  return { ok: false, reason };
}

function cutoverError(reason) {
  const error = new Error(`mc session cutover error (${reason})`);
  error.code = 'MC_SESSION_CUTOVER_ERROR';
  error.reason = reason;
  return error;
}

export const __test__ = Object.freeze({
  LEGACY_TARGETS,
  cutoverPaths,
  digestValue,
  snapshotLegacyTargetSync,
});
