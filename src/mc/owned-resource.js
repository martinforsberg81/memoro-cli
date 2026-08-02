import { createHash, randomBytes } from 'node:crypto';
import {
  lstatSync,
  mkdirSync,
  readdirSync,
  realpathSync,
  rmSync,
} from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';

import { mcHome } from './paths.js';
import {
  fsyncDirectorySync,
  inspectPrivateDirectoryChainSync,
  publishImmutablePrivateJsonSync,
  readPrivateJsonSync,
} from './private-state.js';
import { sessionHomePaths } from './session-home-paths.js';
import { processIsAlive, withLocksSync } from './session-home-lock.js';
import {
  assertMcSessionId,
  sessionHomeError,
  validateIso,
} from './session-home-schema.js';
import {
  RESOURCE_ID_RE,
  WORKSPACE_ID_RE,
  assertResourceId,
  mintResourceId,
} from './session-record-ids.js';
import { readSessionHomeSync } from './session-home.js';
import {
  readWorkspaceAssociationSync,
  recordWorkspaceOwnershipObservationSync,
} from './workspace-record.js';

export const RESOURCE_INTENT_SCHEMA = 'mc-owned-resource-intent';
export const RESOURCE_RECEIPT_SCHEMA = 'mc-owned-resource-creation-receipt';
export const OWNED_RESOURCE_VERSION = 1;

const RESOURCE_KINDS = new Set(['directory', 'git-worktree', 'git-branch']);
const REPOSITORY_IDENTITY_RE = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/u;
const OID_RE = /^[a-f0-9]{40}(?:[a-f0-9]{24})?$/u;

export function createOwnedResourceIntentSync({
  mcHomeDir = mcHome(),
  mcSessionId,
  resourceId = mintResourceId(),
  workspaceId = null,
  resourceKind,
  target,
  now = () => new Date().toISOString(),
  random = randomBytes,
  isAlive = processIsAlive,
} = {}) {
  assertMcSessionId(mcSessionId);
  assertResourceId(resourceId);
  if (workspaceId !== null && !WORKSPACE_ID_RE.test(workspaceId || '')) {
    throw new TypeError('invalid workspace id');
  }
  const intent = {
    schema: RESOURCE_INTENT_SCHEMA,
    version: OWNED_RESOURCE_VERSION,
    resource_id: resourceId,
    mc_session_id: mcSessionId,
    workspace_id: workspaceId,
    resource_kind: resourceKind,
    target,
    created_at: validateIso(now()),
  };
  assertResourceIntent(intent);
  const paths = ownedResourcePaths({ mcHomeDir, mcSessionId, resourceId });
  return withLocksSync([paths.mutationLockPath], {
    trustedRoot: paths.mcHomeDir,
    purpose: 'create-resource-intent',
    isAlive,
    random,
  }, () => {
    requireSession(paths.mcHomeDir, mcSessionId);
    if (workspaceId !== null) {
      const workspace = requireWorkspace(paths.mcHomeDir, mcSessionId, workspaceId);
      const targetPath = pathTarget(intent);
      if (targetPath !== null && workspace.current_path !== targetPath) {
        throw sessionHomeError('resource-workspace-path-mismatch');
      }
    }
    let homeCreated = false;
    try {
      mkdirSync(paths.resourceHome, { mode: 0o700 });
      homeCreated = true;
      publishImmutablePrivateJsonSync({
        path: paths.intentPath,
        value: intent,
        trustedRoot: paths.mcHomeDir,
        random,
      });
      fsyncDirectorySync(paths.resourcesPath);
      return requireResource(paths.mcHomeDir, mcSessionId, resourceId);
    } catch (error) {
      if (homeCreated) {
        try { rmSync(paths.resourceHome, { recursive: true, force: true }); } catch {}
      }
      throw error;
    }
  });
}

export function recordOwnedResourceCreationSync({
  mcHomeDir = mcHome(),
  mcSessionId,
  resourceId,
  observeResource = defaultObserveResource,
  now = () => new Date().toISOString(),
  random = randomBytes,
  isAlive = processIsAlive,
} = {}) {
  assertMcSessionId(mcSessionId);
  assertResourceId(resourceId);
  const paths = ownedResourcePaths({ mcHomeDir, mcSessionId, resourceId });
  return withLocksSync([paths.mutationLockPath], {
    trustedRoot: paths.mcHomeDir,
    purpose: 'record-resource-receipt',
    isAlive,
    random,
  }, () => {
    const resource = requireResource(paths.mcHomeDir, mcSessionId, resourceId);
    if (resource.creation_receipt !== null) throw sessionHomeError('resource-already-created');
    let fingerprint;
    try {
      fingerprint = observeResource({
        intent: resource.intent,
        currentPath: pathTarget(resource.intent),
      });
    } catch {
      throw sessionHomeError('resource-observation-unavailable');
    }
    const receipt = {
      schema: RESOURCE_RECEIPT_SCHEMA,
      version: OWNED_RESOURCE_VERSION,
      resource_id: resourceId,
      mc_session_id: mcSessionId,
      intent_sha256: resourceIntentDigest(resource.intent),
      fingerprint,
      recorded_at: validateIso(now()),
    };
    assertResourceReceipt(receipt, resource.intent);
    publishImmutablePrivateJsonSync({
      path: paths.receiptPath,
      value: receipt,
      trustedRoot: paths.mcHomeDir,
      random,
    });
    return requireResource(paths.mcHomeDir, mcSessionId, resourceId);
  });
}

export function bindWorkspaceOwnedResourceSync({
  mcHomeDir = mcHome(),
  mcSessionId,
  workspaceId,
  resourceId,
  expectedWorkspaceRevision,
  random = randomBytes,
  isAlive = processIsAlive,
} = {}) {
  const resource = requireResource(mcHomeDir, mcSessionId, resourceId);
  if (resource.creation_receipt === null) throw sessionHomeError('resource-creation-unproven');
  if (resource.intent.workspace_id !== workspaceId) {
    throw sessionHomeError('resource-workspace-binding-mismatch');
  }
  return recordWorkspaceOwnershipObservationSync({
    mcHomeDir,
    mcSessionId,
    workspaceId,
    expectedRevision: expectedWorkspaceRevision,
    ownership: { kind: 'mc-created', resource_id: resourceId },
    random,
    isAlive,
  });
}

export function readOwnedResourceSync({
  mcHomeDir = mcHome(),
  mcSessionId,
  resourceId,
} = {}) {
  try {
    assertMcSessionId(mcSessionId);
    assertResourceId(resourceId);
  } catch {
    return unknown('invalid-resource-identity');
  }
  let paths;
  try { paths = ownedResourcePaths({ mcHomeDir, mcSessionId, resourceId }); } catch {
    return unknown('invalid-private-root');
  }
  const safety = inspectPrivateDirectoryChainSync({
    trustedRoot: paths.mcHomeDir,
    directory: paths.resourceHome,
  });
  if (!safety.ok) return safety.missing ? { kind: 'absent' } : unknown(safety.reason);
  const unexpected = unexpectedResourceEntries(paths.resourceHome);
  if (unexpected.length > 0) return unknown('unexpected-resource-entry', { entries: unexpected });
  const intent = readPrivateJsonSync({
    path: paths.intentPath,
    trustedRoot: paths.mcHomeDir,
    validate: validateResourceIntent,
  });
  if (intent.kind !== 'present') return unknown(`intent-${intent.reason || intent.kind}`);
  if (intent.value.mc_session_id !== mcSessionId || intent.value.resource_id !== resourceId) {
    return unknown('resource-identity-binding-mismatch');
  }
  const receipt = readPrivateJsonSync({
    path: paths.receiptPath,
    trustedRoot: paths.mcHomeDir,
    validate: (value) => validateResourceReceipt(value, intent.value),
  });
  if (receipt.kind !== 'present' && receipt.kind !== 'absent') {
    return unknown(`receipt-${receipt.reason || receipt.kind}`);
  }
  return {
    kind: 'present',
    state: receipt.kind === 'present' ? 'created' : 'intent-only',
    intent: intent.value,
    creation_receipt: receipt.kind === 'present' ? receipt.value : null,
  };
}

export function listOwnedResourcesSync({
  mcHomeDir = mcHome(),
  mcSessionId,
} = {}) {
  try { assertMcSessionId(mcSessionId); } catch {
    return { resources: [], issues: [{ reason: 'invalid-session-id' }] };
  }
  let paths;
  try { paths = sessionHomePaths({ mcHomeDir, mcSessionId }); } catch {
    return { resources: [], issues: [{ reason: 'invalid-private-root' }] };
  }
  const session = readSessionHomeSync({ mcHomeDir: paths.mcHomeDir, mcSessionId });
  if (session.kind !== 'present') {
    return { resources: [], issues: [{ reason: session.reason || session.kind }] };
  }
  const safety = inspectPrivateDirectoryChainSync({
    trustedRoot: paths.mcHomeDir,
    directory: paths.resourcesPath,
  });
  if (!safety.ok) return { resources: [], issues: [{ reason: safety.reason }] };
  let entries;
  try { entries = readdirSync(paths.resourcesPath).sort(); } catch {
    return { resources: [], issues: [{ reason: 'unreadable-resources' }] };
  }
  const resources = [];
  const issues = [];
  for (const entry of entries) {
    if (!RESOURCE_ID_RE.test(entry)) {
      issues.push({ entry, reason: 'unexpected-resource-entry' });
      continue;
    }
    const read = readOwnedResourceSync({
      mcHomeDir: paths.mcHomeDir,
      mcSessionId,
      resourceId: entry,
    });
    if (read.kind !== 'present') {
      issues.push({ resource_id: entry, reason: read.reason || read.kind });
      continue;
    }
    resources.push(read);
  }
  resources.sort((a, b) => a.intent.resource_id.localeCompare(b.intent.resource_id));
  return { resources, issues };
}

export function planOwnedResourceCleanupSync({
  mcHomeDir = mcHome(),
  mcSessionId,
  resourceId,
  workspaceId = null,
  currentPath = null,
  observeResource = defaultObserveResource,
} = {}) {
  const read = readOwnedResourceSync({ mcHomeDir, mcSessionId, resourceId });
  if (read.kind !== 'present') return unsafe(read.reason || read.kind);
  if (read.creation_receipt === null) return unsafe('resource-creation-unproven');
  let workspace = null;
  if (workspaceId !== null) {
    const workspaceRead = readWorkspaceAssociationSync({ mcHomeDir, mcSessionId, workspaceId });
    if (workspaceRead.kind !== 'present') return unsafe(workspaceRead.reason || workspaceRead.kind);
    workspace = workspaceRead.value;
    if (read.intent.workspace_id !== workspaceId
      || workspace.ownership.kind !== 'mc-created'
      || workspace.ownership.resource_id !== resourceId) {
      return unsafe('workspace-resource-binding-mismatch');
    }
    currentPath = workspace.current_path;
  }
  let observedFingerprint;
  try {
    observedFingerprint = observeResource({ intent: read.intent, currentPath });
  } catch {
    return unsafe('resource-observation-unavailable');
  }
  const checked = validateResourceFingerprint(observedFingerprint, read.intent.resource_kind);
  if (!checked.ok) return unsafe(checked.reason);
  const match = fingerprintMatches({
    intent: read.intent,
    receipt: read.creation_receipt,
    observed: checked.value,
    currentPath,
  });
  if (!match.ok) return unsafe(match.reason);
  return {
    ok: true,
    safe: true,
    verdict: 'exact-owned-resource',
    resource_id: resourceId,
    resource_kind: read.intent.resource_kind,
    target: read.intent.target,
    current_path: currentPath,
    relocated: currentPath !== null && currentPath !== pathTarget(read.intent),
  };
}

export function observeDirectoryFingerprintSync(path, {
  lstat = lstatSync,
  realpath = realpathSync,
} = {}) {
  const requestedPath = normalizeAbsolutePath(path, 'resource path');
  const stat = lstat(requestedPath, { bigint: true });
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw sessionHomeError('resource-target-not-directory');
  }
  return {
    kind: 'filesystem-directory',
    path: requestedPath,
    real_path: normalizeAbsolutePath(realpath(requestedPath), 'real resource path'),
    device: String(stat.dev),
    inode: String(stat.ino),
    birthtime_ns: String(stat.birthtimeNs),
  };
}

export function observeGitWorktreeFingerprintSync({
  path,
  repositoryIdentity,
  gitDir,
  lstat = lstatSync,
  realpath = realpathSync,
} = {}) {
  const filesystem = observeDirectoryFingerprintSync(path, { lstat, realpath });
  const fingerprint = {
    ...filesystem,
    kind: 'git-worktree',
    repository_identity: repositoryIdentity,
    git_dir: normalizeAbsolutePath(gitDir, 'git directory'),
  };
  const checked = validateResourceFingerprint(fingerprint, 'git-worktree');
  if (!checked.ok) throw new TypeError(checked.reason);
  return fingerprint;
}

export function validateResourceIntent(value) {
  if (!plain(value) || !exactKeys(value, [
    'schema', 'version', 'resource_id', 'mc_session_id', 'workspace_id',
    'resource_kind', 'target', 'created_at',
  ])) return invalid('resource-intent-unexpected-keys');
  if (value.schema !== RESOURCE_INTENT_SCHEMA
    || value.version !== OWNED_RESOURCE_VERSION
    || !RESOURCE_ID_RE.test(value.resource_id || '')
    || !(value.workspace_id === null || WORKSPACE_ID_RE.test(value.workspace_id || ''))
    || !RESOURCE_KINDS.has(value.resource_kind)
    || !validateResourceTarget(value.target, value.resource_kind)
    || !iso(value.created_at)) return invalid('resource-intent-invalid-fields');
  return { ok: true, value: structuredClone(value) };
}

export function validateResourceReceipt(value, intent) {
  const checkedIntent = validateResourceIntent(intent);
  if (!checkedIntent.ok) return invalid('resource-receipt-invalid-intent');
  if (!plain(value) || !exactKeys(value, [
    'schema', 'version', 'resource_id', 'mc_session_id', 'intent_sha256',
    'fingerprint', 'recorded_at',
  ])) return invalid('resource-receipt-unexpected-keys');
  const fingerprint = validateResourceFingerprint(value.fingerprint, intent?.resource_kind);
  if (value.schema !== RESOURCE_RECEIPT_SCHEMA
    || value.version !== OWNED_RESOURCE_VERSION
    || value.resource_id !== intent?.resource_id
    || value.mc_session_id !== intent?.mc_session_id
    || value.intent_sha256 !== resourceIntentDigest(intent)
    || !fingerprint.ok
    || !fingerprintBindsIntent(value.fingerprint, intent)
    || !iso(value.recorded_at)
    || Date.parse(value.recorded_at) < Date.parse(intent.created_at)) {
    return invalid('resource-receipt-invalid-fields');
  }
  return { ok: true, value: structuredClone(value) };
}

export function resourceIntentDigest(intent) {
  return createHash('sha256').update(canonicalJson(intent)).digest('hex');
}

function ownedResourcePaths({ mcHomeDir, mcSessionId, resourceId }) {
  const paths = sessionHomePaths({ mcHomeDir, mcSessionId });
  const resourceHome = join(paths.resourcesPath, resourceId);
  return {
    ...paths,
    resourceHome,
    intentPath: join(resourceHome, 'intent.json'),
    receiptPath: join(resourceHome, 'creation-receipt.json'),
  };
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

function requireResource(mcHomeDir, mcSessionId, resourceId) {
  const read = readOwnedResourceSync({ mcHomeDir, mcSessionId, resourceId });
  if (read.kind !== 'present') throw sessionHomeError(read.reason || read.kind);
  return read;
}

function validateResourceTarget(value, kind) {
  if (!plain(value)) return false;
  if (kind === 'directory') {
    return exactKeys(value, ['path']) && validAbsolutePath(value.path);
  }
  if (kind === 'git-worktree') {
    return exactKeys(value, ['path', 'repository_identity', 'git_dir', 'branch'])
      && validAbsolutePath(value.path)
      && validRepositoryIdentity(value.repository_identity)
      && validAbsolutePath(value.git_dir)
      && (value.branch === null || validBranch(value.branch));
  }
  if (kind === 'git-branch') {
    return exactKeys(value, ['repository_identity', 'ref'])
      && validRepositoryIdentity(value.repository_identity)
      && validGitRef(value.ref);
  }
  return false;
}

function validateResourceFingerprint(value, kind) {
  if (!plain(value)) return invalid('invalid-resource-fingerprint');
  if (kind === 'directory') {
    if (!exactKeys(value, ['kind', 'path', 'real_path', 'device', 'inode', 'birthtime_ns'])
      || value.kind !== 'filesystem-directory'
      || !validFilesystemFingerprint(value)) return invalid('invalid-resource-fingerprint');
  } else if (kind === 'git-worktree') {
    if (!exactKeys(value, [
      'kind', 'path', 'real_path', 'device', 'inode', 'birthtime_ns',
      'repository_identity', 'git_dir',
    ]) || value.kind !== 'git-worktree'
      || !validFilesystemFingerprint(value)
      || !validRepositoryIdentity(value.repository_identity)
      || !validAbsolutePath(value.git_dir)) return invalid('invalid-resource-fingerprint');
  } else if (kind === 'git-branch') {
    if (!exactKeys(value, ['kind', 'repository_identity', 'ref', 'ref_oid'])
      || value.kind !== 'git-ref'
      || !validRepositoryIdentity(value.repository_identity)
      || !validGitRef(value.ref)
      || !OID_RE.test(value.ref_oid || '')) return invalid('invalid-resource-fingerprint');
  } else {
    return invalid('invalid-resource-kind');
  }
  return { ok: true, value: structuredClone(value) };
}

function fingerprintMatches({ intent, receipt, observed, currentPath }) {
  const expected = receipt.fingerprint;
  if (intent.resource_kind === 'directory' || intent.resource_kind === 'git-worktree') {
    const path = currentPath === null ? intent.target.path : currentPath;
    if (!validAbsolutePath(path) || observed.path !== path
      || observed.device !== expected.device
      || observed.inode !== expected.inode
      || observed.birthtime_ns !== expected.birthtime_ns) {
      return invalid('resource-target-mismatch');
    }
    if (intent.resource_kind === 'git-worktree'
      && (observed.repository_identity !== expected.repository_identity
        || observed.repository_identity !== intent.target.repository_identity
        || observed.git_dir !== expected.git_dir
        || observed.git_dir !== intent.target.git_dir)) {
      return invalid('resource-target-mismatch');
    }
    return { ok: true };
  }
  return canonicalJson(observed) === canonicalJson(expected)
    ? { ok: true }
    : invalid('resource-target-mismatch');
}

function defaultObserveResource({ intent, currentPath }) {
  if (intent.resource_kind !== 'directory') {
    throw sessionHomeError('resource-observer-required');
  }
  return observeDirectoryFingerprintSync(currentPath || intent.target.path);
}

function fingerprintBindsIntent(fingerprint, intent) {
  if (intent.resource_kind === 'directory') return fingerprint.path === intent.target.path;
  if (intent.resource_kind === 'git-worktree') {
    return fingerprint.path === intent.target.path
      && fingerprint.repository_identity === intent.target.repository_identity
      && fingerprint.git_dir === intent.target.git_dir;
  }
  return fingerprint.repository_identity === intent.target.repository_identity
    && fingerprint.ref === intent.target.ref;
}

function pathTarget(intent) {
  return ['directory', 'git-worktree'].includes(intent.resource_kind)
    ? intent.target.path
    : null;
}

function unexpectedResourceEntries(resourceHome) {
  try {
    return readdirSync(resourceHome)
      .filter((entry) => !['intent.json', 'creation-receipt.json'].includes(entry))
      .sort();
  } catch {
    return ['<unreadable>'];
  }
}

function validFilesystemFingerprint(value) {
  return validAbsolutePath(value.path)
    && validAbsolutePath(value.real_path)
    && /^\d{1,32}$/u.test(value.device || '')
    && /^\d{1,32}$/u.test(value.inode || '')
    && /^\d{1,32}$/u.test(value.birthtime_ns || '');
}

function validRepositoryIdentity(value) {
  return REPOSITORY_IDENTITY_RE.test(value || '') && !value.includes('://');
}

function validGitRef(value) {
  if (typeof value !== 'string'
    || !value.startsWith('refs/heads/')
    || value.length <= 'refs/heads/'.length
    || value.length > 255) return false;
  const branch = value.slice('refs/heads/'.length);
  return !branch.startsWith('/')
    && !branch.endsWith('/')
    && !branch.endsWith('.')
    && !branch.endsWith('.lock')
    && !branch.includes('..')
    && !branch.includes('//')
    && !branch.includes('@{')
    && !/[\u0000-\u0020\u007f~^:?*[\\]/u.test(branch);
}

function validBranch(value) {
  return typeof value === 'string'
    && value.length > 0
    && value.length <= 255
    && !/[\u0000-\u001f\u007f]/u.test(value);
}

function normalizeAbsolutePath(value, label) {
  if (!validAbsolutePath(value)) throw new TypeError(`${label} must be a canonical absolute path`);
  return value;
}

function validAbsolutePath(value) {
  return typeof value === 'string'
    && value.length > 0
    && value.length <= 4096
    && !value.includes('\u0000')
    && isAbsolute(value)
    && resolve(value) === value;
}

function assertResourceIntent(value) {
  const checked = validateResourceIntent(value);
  if (!checked.ok) throw new TypeError(checked.reason);
}

function assertResourceReceipt(value, intent) {
  const checked = validateResourceReceipt(value, intent);
  if (!checked.ok) throw new TypeError(checked.reason);
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (plain(value)) {
    return `{${Object.keys(value).sort().map((key) => (
      `${JSON.stringify(key)}:${canonicalJson(value[key])}`
    )).join(',')}}`;
  }
  return JSON.stringify(value);
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

function iso(value) {
  return typeof value === 'string' && value.length <= 64 && Number.isFinite(Date.parse(value));
}

function invalid(reason) {
  return { ok: false, reason };
}

function unknown(reason, extra = {}) {
  return { kind: 'unknown', reason, ...extra };
}

function unsafe(reason) {
  return { ok: true, safe: false, reason };
}
