import { randomBytes } from 'node:crypto';
import { readdirSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';

import { mcHome } from './paths.js';
import {
  inspectPrivateDirectoryChainSync,
  publishImmutablePrivateJsonSync,
  readPrivateJsonSync,
  replacePrivateJsonSync,
} from './private-state.js';
import { sessionHomePaths } from './session-home-paths.js';
import { processIsAlive, withLocksSync } from './session-home-lock.js';
import {
  MC_SESSION_ID_RE,
  assertExpectedRevision,
  assertMcSessionId,
  sessionHomeError,
  validateIso,
} from './session-home-schema.js';
import {
  RESOURCE_ID_RE,
  WORKSPACE_ID_RE,
  assertWorkspaceId,
  mintWorkspaceId,
} from './session-record-ids.js';
import { readSessionHomeSync } from './session-home.js';

export const WORKSPACE_RECORD_SCHEMA = 'mc-session-workspace';
export const WORKSPACE_RECORD_VERSION = 1;

const WORKSPACE_KINDS = new Set(['directory', 'repository', 'checkout', 'worktree']);
const PATH_STATES = new Set(['present', 'missing']);
const REPOSITORY_IDENTITY_RE = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/u;
const PUBLIC_REF_RE = /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/u;
const HEAD_RE = /^[a-f0-9]{40}(?:[a-f0-9]{24})?$/u;

export function createWorkspaceAssociationSync({
  mcHomeDir = mcHome(),
  mcSessionId,
  workspaceId = mintWorkspaceId(),
  kind,
  currentPath,
  pathState = 'present',
  repository = null,
  checkout = null,
  ownership = { kind: 'external' },
  preferredLaunch = false,
  now = () => new Date().toISOString(),
  random = randomBytes,
  isAlive = processIsAlive,
} = {}) {
  assertMcSessionId(mcSessionId);
  assertWorkspaceId(workspaceId);
  const observedAt = validateIso(now());
  const record = {
    schema: WORKSPACE_RECORD_SCHEMA,
    version: WORKSPACE_RECORD_VERSION,
    workspace_id: workspaceId,
    mc_session_id: mcSessionId,
    revision: 1,
    kind,
    current_path: normalizeAbsolutePath(currentPath, 'workspace path'),
    path_state: pathState,
    first_observed_at: observedAt,
    last_observed_at: observedAt,
    last_present_at: pathState === 'present' ? observedAt : null,
    previous_path: null,
    relocated_at: null,
    repository,
    checkout,
    ownership,
    last_launch_used_at: null,
    preferred_launch: preferredLaunch,
  };
  assertWorkspaceRecord(record);
  const paths = sessionHomePaths({ mcHomeDir, mcSessionId });
  return withLocksSync([paths.mutationLockPath], {
    trustedRoot: paths.mcHomeDir,
    purpose: 'create-workspace',
    isAlive,
    random,
  }, () => {
    requireSession(paths.mcHomeDir, mcSessionId);
    publishImmutablePrivateJsonSync({
      path: workspaceRecordPath(paths, workspaceId),
      value: record,
      trustedRoot: paths.mcHomeDir,
      random,
    });
    return requireWorkspace(paths.mcHomeDir, mcSessionId, workspaceId);
  });
}

export function readWorkspaceAssociationSync({
  mcHomeDir = mcHome(),
  mcSessionId,
  workspaceId,
} = {}) {
  try {
    assertMcSessionId(mcSessionId);
    assertWorkspaceId(workspaceId);
  } catch {
    return unknown('invalid-workspace-identity');
  }
  let paths;
  try { paths = sessionHomePaths({ mcHomeDir, mcSessionId }); } catch {
    return unknown('invalid-private-root');
  }
  const read = readPrivateJsonSync({
    path: workspaceRecordPath(paths, workspaceId),
    trustedRoot: paths.mcHomeDir,
    validate: validateWorkspaceRecord,
  });
  if (read.kind !== 'present') return read;
  if (read.value.mc_session_id !== mcSessionId || read.value.workspace_id !== workspaceId) {
    return unknown('workspace-identity-binding-mismatch');
  }
  return { kind: 'present', value: read.value };
}

export function listWorkspaceAssociationsSync({
  mcHomeDir = mcHome(),
  mcSessionId,
} = {}) {
  try { assertMcSessionId(mcSessionId); } catch {
    return { workspaces: [], issues: [{ reason: 'invalid-session-id' }] };
  }
  let paths;
  try { paths = sessionHomePaths({ mcHomeDir, mcSessionId }); } catch {
    return { workspaces: [], issues: [{ reason: 'invalid-private-root' }] };
  }
  const session = readSessionHomeSync({ mcHomeDir: paths.mcHomeDir, mcSessionId });
  if (session.kind !== 'present') {
    return { workspaces: [], issues: [{ reason: session.reason || session.kind }] };
  }
  const safety = inspectPrivateDirectoryChainSync({
    trustedRoot: paths.mcHomeDir,
    directory: paths.workspacesPath,
  });
  if (!safety.ok) return { workspaces: [], issues: [{ reason: safety.reason }] };
  let entries;
  try { entries = readdirSync(paths.workspacesPath).sort(); } catch {
    return { workspaces: [], issues: [{ reason: 'unreadable-workspaces' }] };
  }
  const workspaces = [];
  const issues = [];
  for (const entry of entries) {
    const match = /^(mcw_[a-f0-9]{24})\.json$/u.exec(entry);
    if (!match) {
      issues.push({ entry, reason: 'unexpected-workspace-entry' });
      continue;
    }
    const read = readWorkspaceAssociationSync({
      mcHomeDir: paths.mcHomeDir,
      mcSessionId,
      workspaceId: match[1],
    });
    if (read.kind !== 'present') {
      issues.push({ workspace_id: match[1], reason: read.reason || read.kind });
      continue;
    }
    workspaces.push(read.value);
  }
  workspaces.sort((a, b) => a.workspace_id.localeCompare(b.workspace_id));
  return { workspaces, issues };
}

export function updateWorkspaceObservationSync({
  mcHomeDir = mcHome(),
  mcSessionId,
  workspaceId,
  expectedRevision,
  currentPath,
  pathState,
  repository,
  checkout,
  now = () => new Date().toISOString(),
  random = randomBytes,
  isAlive = processIsAlive,
} = {}) {
  assertMcSessionId(mcSessionId);
  assertWorkspaceId(workspaceId);
  assertExpectedRevision(expectedRevision);
  if (currentPath === undefined && pathState === undefined
    && repository === undefined && checkout === undefined) {
    throw new TypeError('workspace observation requires a supported field');
  }
  const paths = sessionHomePaths({ mcHomeDir, mcSessionId });
  return withLocksSync([paths.mutationLockPath], {
    trustedRoot: paths.mcHomeDir,
    purpose: 'observe-workspace',
    isAlive,
    random,
  }, () => {
    const current = requireWorkspace(paths.mcHomeDir, mcSessionId, workspaceId);
    if (current.revision !== expectedRevision) throw sessionHomeError('workspace-revision-conflict');
    const observedAt = validateIso(now());
    if (Date.parse(observedAt) < Date.parse(current.last_observed_at)) {
      throw sessionHomeError('workspace-observation-time-regression');
    }
    const nextPath = currentPath === undefined
      ? current.current_path
      : normalizeAbsolutePath(currentPath, 'workspace path');
    const nextState = pathState === undefined ? current.path_state : pathState;
    const relocated = nextPath !== current.current_path;
    const next = {
      ...current,
      revision: current.revision + 1,
      current_path: nextPath,
      path_state: nextState,
      last_observed_at: observedAt,
      last_present_at: nextState === 'present' ? observedAt : current.last_present_at,
      previous_path: relocated ? current.current_path : current.previous_path,
      relocated_at: relocated ? observedAt : current.relocated_at,
      ...(repository !== undefined ? { repository } : {}),
      ...(checkout !== undefined ? { checkout } : {}),
    };
    assertWorkspaceRecord(next);
    replacePrivateJsonSync({
      path: workspaceRecordPath(paths, workspaceId),
      value: next,
      trustedRoot: paths.mcHomeDir,
      random,
    });
    return requireWorkspace(paths.mcHomeDir, mcSessionId, workspaceId);
  });
}

export function updateWorkspaceUsageSync({
  mcHomeDir = mcHome(),
  mcSessionId,
  workspaceId,
  expectedRevision,
  preferredLaunch,
  now = () => new Date().toISOString(),
  random = randomBytes,
  isAlive = processIsAlive,
} = {}) {
  assertMcSessionId(mcSessionId);
  assertWorkspaceId(workspaceId);
  assertExpectedRevision(expectedRevision);
  if (preferredLaunch !== undefined && typeof preferredLaunch !== 'boolean') {
    throw new TypeError('preferredLaunch must be boolean');
  }
  const paths = sessionHomePaths({ mcHomeDir, mcSessionId });
  return withLocksSync([paths.mutationLockPath], {
    trustedRoot: paths.mcHomeDir,
    purpose: 'use-workspace',
    isAlive,
    random,
  }, () => {
    const current = requireWorkspace(paths.mcHomeDir, mcSessionId, workspaceId);
    if (current.revision !== expectedRevision) throw sessionHomeError('workspace-revision-conflict');
    const usedAt = validateIso(now());
    if (current.last_launch_used_at !== null
      && Date.parse(usedAt) < Date.parse(current.last_launch_used_at)) {
      throw sessionHomeError('workspace-launch-time-regression');
    }
    const next = {
      ...current,
      revision: current.revision + 1,
      last_launch_used_at: usedAt,
      ...(preferredLaunch !== undefined ? { preferred_launch: preferredLaunch } : {}),
    };
    assertWorkspaceRecord(next);
    replacePrivateJsonSync({
      path: workspaceRecordPath(paths, workspaceId),
      value: next,
      trustedRoot: paths.mcHomeDir,
      random,
    });
    return requireWorkspace(paths.mcHomeDir, mcSessionId, workspaceId);
  });
}

export function recordWorkspaceOwnershipObservationSync({
  mcHomeDir = mcHome(),
  mcSessionId,
  workspaceId,
  expectedRevision,
  ownership,
  random = randomBytes,
  isAlive = processIsAlive,
} = {}) {
  assertMcSessionId(mcSessionId);
  assertWorkspaceId(workspaceId);
  assertExpectedRevision(expectedRevision);
  if (!validateOwnership(ownership)) throw new TypeError('invalid workspace ownership observation');
  const paths = sessionHomePaths({ mcHomeDir, mcSessionId });
  return withLocksSync([paths.mutationLockPath], {
    trustedRoot: paths.mcHomeDir,
    purpose: 'bind-workspace-resource',
    isAlive,
    random,
  }, () => {
    const current = requireWorkspace(paths.mcHomeDir, mcSessionId, workspaceId);
    if (current.revision !== expectedRevision) throw sessionHomeError('workspace-revision-conflict');
    const next = { ...current, revision: current.revision + 1, ownership };
    assertWorkspaceRecord(next);
    replacePrivateJsonSync({
      path: workspaceRecordPath(paths, workspaceId),
      value: next,
      trustedRoot: paths.mcHomeDir,
      random,
    });
    return requireWorkspace(paths.mcHomeDir, mcSessionId, workspaceId);
  });
}

export function validateWorkspaceRecord(value) {
  if (!plain(value) || !exactKeys(value, [
    'schema', 'version', 'workspace_id', 'mc_session_id', 'revision', 'kind',
    'current_path', 'path_state', 'first_observed_at', 'last_observed_at',
    'last_present_at', 'previous_path', 'relocated_at', 'repository', 'checkout',
    'ownership', 'last_launch_used_at', 'preferred_launch',
  ])) return invalid('workspace-unexpected-keys');
  if (value.schema !== WORKSPACE_RECORD_SCHEMA
    || value.version !== WORKSPACE_RECORD_VERSION
    || !WORKSPACE_ID_RE.test(value.workspace_id || '')
    || !MC_SESSION_ID_RE.test(value.mc_session_id || '')
    || !Number.isSafeInteger(value.revision) || value.revision < 1
    || !WORKSPACE_KINDS.has(value.kind)
    || !validAbsolutePath(value.current_path)
    || !PATH_STATES.has(value.path_state)
    || !iso(value.first_observed_at)
    || !iso(value.last_observed_at)
    || Date.parse(value.last_observed_at) < Date.parse(value.first_observed_at)
    || !optionalIso(value.last_present_at)
    || (value.last_present_at !== null
      && (Date.parse(value.last_present_at) < Date.parse(value.first_observed_at)
        || Date.parse(value.last_present_at) > Date.parse(value.last_observed_at)))
    || (value.path_state === 'present' && value.last_present_at === null)
    || !pairedRelocation(value.previous_path, value.relocated_at)
    || (value.relocated_at !== null
      && (Date.parse(value.relocated_at) < Date.parse(value.first_observed_at)
        || Date.parse(value.relocated_at) > Date.parse(value.last_observed_at)
        || value.previous_path === value.current_path))
    || !validateRepository(value.repository)
    || !validateCheckout(value.checkout)
    || !validateOwnership(value.ownership)
    || !optionalIso(value.last_launch_used_at)
    || (value.last_launch_used_at !== null
      && Date.parse(value.last_launch_used_at) < Date.parse(value.first_observed_at))
    || typeof value.preferred_launch !== 'boolean') return invalid('workspace-invalid-fields');
  if ((value.kind === 'repository' && value.repository === null)
    || (['checkout', 'worktree'].includes(value.kind)
      && (value.repository === null || value.checkout === null))) {
    return invalid('workspace-kind-observation-mismatch');
  }
  return { ok: true, value: structuredClone(value) };
}

function workspaceRecordPath(paths, workspaceId) {
  return join(paths.workspacesPath, `${workspaceId}.json`);
}

function requireSession(mcHomeDir, mcSessionId) {
  const read = readSessionHomeSync({ mcHomeDir, mcSessionId });
  if (read.kind !== 'present') throw sessionHomeError(read.reason || read.kind);
  return read;
}

function requireWorkspace(mcHomeDir, mcSessionId, workspaceId) {
  const read = readWorkspaceAssociationSync({ mcHomeDir, mcSessionId, workspaceId });
  if (read.kind !== 'present') throw sessionHomeError(read.reason || read.kind);
  return read.value;
}

function validateRepository(value) {
  if (value === null) return true;
  if (!plain(value) || !exactKeys(value, [
    'repository_identity', 'public_ref', 'git_common_dir',
  ])) return false;
  const identity = value.repository_identity;
  const publicRef = value.public_ref;
  const commonDir = value.git_common_dir;
  return (identity === null || validRepositoryIdentity(identity))
    && (publicRef === null || PUBLIC_REF_RE.test(publicRef || ''))
    && (commonDir === null || validAbsolutePath(commonDir))
    && [identity, publicRef, commonDir].some((entry) => entry !== null);
}

function validateCheckout(value) {
  if (value === null) return true;
  if (!plain(value) || !exactKeys(value, ['git_dir', 'branch', 'head_sha'])) return false;
  return (value.git_dir === null || validAbsolutePath(value.git_dir))
    && (value.branch === null || validBranchObservation(value.branch))
    && (value.head_sha === null || HEAD_RE.test(value.head_sha || ''))
    && [value.git_dir, value.branch, value.head_sha].some((entry) => entry !== null);
}

function validateOwnership(value) {
  if (!plain(value) || typeof value.kind !== 'string') return false;
  if (value.kind === 'external') return exactKeys(value, ['kind']);
  return value.kind === 'mc-created'
    && exactKeys(value, ['kind', 'resource_id'])
    && RESOURCE_ID_RE.test(value.resource_id || '');
}

function validRepositoryIdentity(value) {
  return REPOSITORY_IDENTITY_RE.test(value || '') && !value.includes('://');
}

function pairedRelocation(previousPath, relocatedAt) {
  if (previousPath === null || relocatedAt === null) {
    return previousPath === null && relocatedAt === null;
  }
  return validAbsolutePath(previousPath) && iso(relocatedAt);
}

function normalizeAbsolutePath(value, label) {
  if (!validAbsolutePath(value)) throw new TypeError(`${label} must be a canonical absolute path`);
  return value;
}

function assertWorkspaceRecord(value) {
  const checked = validateWorkspaceRecord(value);
  if (!checked.ok) throw new TypeError(checked.reason);
}

function validAbsolutePath(value) {
  return typeof value === 'string'
    && value.length > 0
    && value.length <= 4096
    && !value.includes('\u0000')
    && isAbsolute(value)
    && resolve(value) === value;
}

function validBranchObservation(value) {
  return typeof value === 'string'
    && value.length > 0
    && value.length <= 255
    && !/[\u0000-\u001f\u007f]/u.test(value);
}

function iso(value) {
  return typeof value === 'string' && value.length <= 64 && Number.isFinite(Date.parse(value));
}

function optionalIso(value) {
  return value === null || iso(value);
}

function exactKeys(value, keys) {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length
    && actual.every((key, index) => key === expected[index]);
}

function plain(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function invalid(reason) {
  return { ok: false, reason };
}

function unknown(reason) {
  return { kind: 'unknown', reason };
}
