import { lstatSync, realpathSync, rmdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { isAbsolute, resolve } from 'node:path';

import {
  listOwnedResourcesSync,
  observeDirectoryFingerprintSync,
  observeGitWorktreeFingerprintSync,
  planOwnedResourceCleanupSync,
  recordOwnedResourceCleanupSync,
} from './owned-resource.js';
import {
  listWorkspaceAssociationsSync,
  updateWorkspaceObservationSync,
} from './workspace-record.js';

const CLEANUP_FINGERPRINT = Symbol('cleanup-fingerprint');

export function planSessionOwnedResourceCleanupSync({
  mcHomeDir,
  mcSessionId,
  resourceId = null,
  deps = {},
} = {}) {
  const listed = (deps.listResources || listOwnedResourcesSync)({ mcHomeDir, mcSessionId });
  const workspaces = (deps.listWorkspaces || listWorkspaceAssociationsSync)({
    mcHomeDir,
    mcSessionId,
  });
  const issues = [
    ...(listed.issues || []).map((issue) => ({ scope: 'resource', ...issue })),
    ...(workspaces.issues || []).map((issue) => ({ scope: 'workspace', ...issue })),
  ];
  let resources = listed.resources || [];
  if (resourceId !== null) {
    resources = resources.filter((item) => item.intent.resource_id === resourceId);
    if (resources.length === 0) issues.push({ scope: 'resource', resource_id: resourceId, reason: 'absent' });
  }
  resources = [...resources].sort(compareCleanupResources);
  const targets = new Map();
  for (const resource of resources.filter((item) => (
    item.creation_receipt !== null && item.cleanup_receipt === null
  ))) {
    const key = resourceTargetKey(resource.intent, workspaces.workspaces || []);
    const group = targets.get(key) || [];
    group.push(resource.intent.resource_id);
    targets.set(key, group);
  }
  for (const [target, resourceIds] of targets) {
    if (resourceIds.length > 1) {
      issues.push({
        scope: 'resource',
        reason: 'duplicate-owned-resource-target',
        target,
        resource_ids: resourceIds,
      });
    }
  }
  const plans = resources.map((resource) => planOne({
    mcHomeDir,
    mcSessionId,
    resource,
    workspaces: workspaces.workspaces || [],
    deps,
  }));
  return {
    ok: issues.length === 0 && plans.every((plan) => plan.safe),
    mc_session_id: mcSessionId,
    plans,
    issues,
  };
}

export function applySessionOwnedResourceCleanupSync({
  mcHomeDir,
  mcSessionId,
  resourceId = null,
  now,
  deps = {},
} = {}) {
  const initial = planSessionOwnedResourceCleanupSync({
    mcHomeDir,
    mcSessionId,
    resourceId,
    deps,
  });
  if (!initial.ok) return { ...initial, applied: false, results: [] };
  const results = [];
  for (const plan of initial.plans) {
    if (plan.verdict === 'already-cleaned') {
      results.push({ ok: true, resource_id: plan.resource_id, action: 'unchanged' });
      continue;
    }
    const fresh = planSessionOwnedResourceCleanupSync({
      mcHomeDir,
      mcSessionId,
      resourceId: plan.resource_id,
      deps,
    });
    if (!fresh.ok || fresh.plans.length !== 1) {
      results.push({
        ok: false,
        resource_id: plan.resource_id,
        reason: fresh.issues[0]?.reason || fresh.plans[0]?.reason || 'resource-revalidation-failed',
      });
      continue;
    }
    const exact = fresh.plans[0];
    let result = 'already-absent';
    if (exact.verdict !== 'already-absent' && exact.verdict !== 'already-cleaned') {
      const removed = (deps.removeResource || removeResourceDefault)(exact, {
        deps: { ...deps, mcHomeDir, mcSessionId },
      });
      if (!removed.ok) {
        results.push({ ok: false, resource_id: plan.resource_id, reason: removed.reason });
        continue;
      }
      result = 'removed';
    }
    let recorded;
    try {
      recorded = (deps.recordCleanup || recordOwnedResourceCleanupSync)({
        mcHomeDir,
        mcSessionId,
        resourceId: plan.resource_id,
        result,
        ...(now ? { now } : {}),
      });
    } catch (error) {
      results.push({
        ok: false,
        resource_id: plan.resource_id,
        reason: error?.reason || 'cleanup-receipt-write-failed',
      });
      continue;
    }
    markWorkspaceMissing(recorded, { mcHomeDir, mcSessionId, now, deps });
    results.push({ ok: true, resource_id: plan.resource_id, action: result });
  }
  return {
    ...initial,
    ok: results.every((item) => item.ok),
    applied: true,
    results,
  };
}

function planOne({ mcHomeDir, mcSessionId, resource, workspaces, deps }) {
  const resourceId = resource.intent.resource_id;
  if (resource.cleanup_receipt) {
    return publicPlan(planOwnedResourceCleanupSync({
      mcHomeDir,
      mcSessionId,
      resourceId,
    }));
  }
  if (!resource.creation_receipt) return unsafe(resource, 'resource-creation-unproven');
  const workspace = resource.intent.workspace_id === null
    ? null
    : workspaces.find((item) => item.workspace_id === resource.intent.workspace_id) || null;
  if (resource.intent.workspace_id !== null && !workspace) {
    return unsafe(resource, 'workspace-resource-binding-mismatch');
  }
  const currentPath = workspace?.current_path || resource.intent.target.path || null;
  const observer = deps.observeResource || ((input) => observeResourceDefault(input, {
    git: deps.git,
  }));
  const presence = deps.resourceExists
    ? ((deps.resourceExists(resource.intent, { currentPath, workspaces, git: deps.git }))
        ? 'present'
        : 'absent')
    : resourcePresenceDefault(resource.intent, { currentPath, git: deps.git });
  if (presence === 'unsafe') return unsafe(resource, 'resource-target-unsafe');
  if (presence === 'absent') {
    return {
      safe: true,
      verdict: 'already-absent',
      resource_id: resourceId,
      resource_kind: resource.intent.resource_kind,
      target: resource.intent.target,
      current_path: currentPath,
      relocated: currentPath !== null && currentPath !== resource.intent.target.path,
    };
  }
  const planned = planOwnedResourceCleanupSync({
    mcHomeDir,
    mcSessionId,
    resourceId,
    workspaceId: workspace?.workspace_id || null,
    currentPath,
    observeResource: observer,
  });
  const result = publicPlan(planned);
  if (result.safe) {
    Object.defineProperty(result, CLEANUP_FINGERPRINT, {
      value: resource.creation_receipt.fingerprint,
    });
  }
  return result;
}

function publicPlan(plan) {
  if (plan.ok && plan.safe) return { safe: true, ...plan };
  return { safe: false, reason: plan.reason || 'resource-cleanup-unsafe' };
}

function unsafe(resource, reason) {
  return {
    safe: false,
    resource_id: resource.intent.resource_id,
    resource_kind: resource.intent.resource_kind,
    reason,
  };
}

function observeResourceDefault({ intent, currentPath }, { git }) {
  if (intent.resource_kind === 'directory') {
    return observeDirectoryFingerprintSync(currentPath || intent.target.path);
  }
  if (intent.resource_kind === 'git-worktree') {
    const path = currentPath || intent.target.path;
    const gitDir = gitOutput(['-C', path, 'rev-parse', '--path-format=absolute', '--git-dir'], { git });
    return observeGitWorktreeFingerprintSync({
      path,
      repositoryIdentity: intent.target.repository_identity,
      gitDir,
    });
  }
  const commonDir = exactGitCommonDir(intent.target.git_common_dir);
  const refOid = gitOutput(['--git-dir', commonDir, 'rev-parse', '--verify', intent.target.ref], { git });
  return {
    kind: 'git-ref',
    repository_identity: intent.target.repository_identity,
    git_common_dir: commonDir,
    ref: intent.target.ref,
    ref_oid: refOid,
  };
}

function resourcePresenceDefault(intent, { currentPath, git }) {
  if (intent.resource_kind !== 'git-branch') return exactDirectoryState(currentPath || intent.target.path);
  try {
    const commonDir = exactGitCommonDir(intent.target.git_common_dir);
    const result = gitInvoke(['--git-dir', commonDir, 'show-ref', '--verify', '--quiet', intent.target.ref], { git });
    if (result.status === 0) return 'present';
    if (result.status === 1) return 'absent';
    return 'unsafe';
  } catch {
    return 'unsafe';
  }
}

function removeResourceDefault(plan, { deps }) {
  try {
    const expected = plan[CLEANUP_FINGERPRINT];
    if (!expected) return { ok: false, reason: 'resource-cleanup-authority-unavailable' };
    if (plan.resource_kind === 'directory') {
      const path = plan.current_path || plan.target.path;
      const observed = observeDirectoryFingerprintSync(path);
      if (!sameFilesystemObject(observed, expected)) {
        return { ok: false, reason: 'resource-target-mismatch' };
      }
      rmdirSync(path);
      return { ok: true };
    }
    if (plan.resource_kind === 'git-worktree') {
      const path = plan.current_path || plan.target.path;
      const gitDir = gitOutput([
        '-C', path, 'rev-parse', '--path-format=absolute', '--git-dir',
      ], { git: deps.git });
      const observed = observeGitWorktreeFingerprintSync({
        path,
        repositoryIdentity: plan.target.repository_identity,
        gitDir,
      });
      if (!sameFilesystemObject(observed, expected)
        || observed.repository_identity !== expected.repository_identity
        || observed.git_dir !== expected.git_dir) {
        return { ok: false, reason: 'resource-target-mismatch' };
      }
      if (gitOutput(['-C', path, 'status', '--porcelain', '--ignored'], { git: deps.git }) !== '') {
        return { ok: false, reason: 'worktree-dirty' };
      }
      const commonDir = gitOutput([
        '-C', path, 'rev-parse', '--path-format=absolute', '--git-common-dir',
      ], { git: deps.git });
      gitRun(['--git-dir', commonDir, 'worktree', 'remove', '--', path], { git: deps.git });
      return { ok: true };
    }
    const commonDir = exactGitCommonDir(plan.target.git_common_dir);
    const checkedOut = gitOutput(['--git-dir', commonDir, 'worktree', 'list', '--porcelain'], {
      git: deps.git,
    }).split(/\r?\n/u).some((line) => line === `branch ${plan.target.ref}`);
    if (checkedOut) return { ok: false, reason: 'branch-checked-out' };
    const refs = gitOutput(['--git-dir', commonDir, 'for-each-ref', '--format=%(refname)', 'refs/heads'], {
      git: deps.git,
    }).split(/\r?\n/u).filter((ref) => ref && ref !== plan.target.ref);
    const oid = gitOutput(['--git-dir', commonDir, 'rev-parse', '--verify', plan.target.ref], {
      git: deps.git,
    });
    if (expected.kind !== 'git-ref'
      || expected.git_common_dir !== commonDir
      || expected.ref !== plan.target.ref
      || expected.ref_oid !== oid) {
      return { ok: false, reason: 'resource-target-mismatch' };
    }
    const merged = refs.some((ref) => gitStatus([
      '--git-dir', commonDir, 'merge-base', '--is-ancestor', oid, ref,
    ], { git: deps.git }) === 0);
    if (!merged) return { ok: false, reason: 'branch-unmerged' };
    gitRun(['--git-dir', commonDir, 'update-ref', '-d', plan.target.ref, oid], { git: deps.git });
    return { ok: true };
  } catch (error) {
    return {
      ok: false,
      reason: error?.reason
        || (['ENOTEMPTY', 'EEXIST'].includes(error?.code) ? 'resource-not-empty' : null)
        || 'resource-remove-failed',
    };
  }
}

function sameFilesystemObject(observed, expected) {
  return observed.device === expected.device
    && observed.inode === expected.inode
    && observed.birthtime_ns === expected.birthtime_ns;
}

function markWorkspaceMissing(resource, { mcHomeDir, mcSessionId, now, deps }) {
  const workspaceId = resource.intent.workspace_id;
  if (!workspaceId) return;
  try {
    const workspaces = (deps.listWorkspaces || listWorkspaceAssociationsSync)({
      mcHomeDir,
      mcSessionId,
    });
    const workspace = workspaces.workspaces.find((item) => item.workspace_id === workspaceId);
    if (!workspace) return;
    (deps.updateWorkspace || updateWorkspaceObservationSync)({
      mcHomeDir,
      mcSessionId,
      workspaceId,
      expectedRevision: workspace.revision,
      pathState: 'missing',
      ...(now ? { now } : {}),
    });
  } catch {}
}

function exactGitCommonDir(path) {
  if (!isAbsolute(path || '')) throw cleanupError('repository-common-dir-unavailable');
  try {
    const stat = lstatSync(path);
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      throw cleanupError('repository-common-dir-unavailable');
    }
    return resolve(realpathSync(path));
  } catch (error) {
    if (error?.reason) throw error;
    throw cleanupError('repository-common-dir-unavailable');
  }
}

function resourceTargetKey(intent, workspaces) {
  if (intent.resource_kind === 'git-branch') {
    return `git-ref:${intent.target.git_common_dir}:${intent.target.ref}`;
  }
  const workspace = intent.workspace_id === null
    ? null
    : workspaces.find((item) => item.workspace_id === intent.workspace_id) || null;
  return `filesystem:${workspace?.current_path || intent.target.path}`;
}

function compareCleanupResources(left, right) {
  const priority = { 'git-worktree': 0, directory: 1, 'git-branch': 2 };
  return priority[left.intent.resource_kind] - priority[right.intent.resource_kind]
    || left.intent.resource_id.localeCompare(right.intent.resource_id);
}

function exactDirectoryState(path) {
  try {
    const stat = lstatSync(path);
    return stat.isDirectory() && !stat.isSymbolicLink() ? 'present' : 'unsafe';
  } catch (error) {
    return error?.code === 'ENOENT' ? 'absent' : 'unsafe';
  }
}

function gitOutput(args, { git } = {}) {
  const result = gitInvoke(args, { git });
  if (result.status !== 0) throw cleanupError('git-observation-failed');
  const output = String(result.stdout || '').trim();
  if (output.includes('\u0000')) throw cleanupError('git-observation-invalid');
  return isAbsolute(output) ? resolve(realpathIfAvailable(output)) : output;
}

function gitRun(args, { git } = {}) {
  const result = gitInvoke(args, { git });
  if (result.status !== 0) throw cleanupError('git-cleanup-failed');
  return result;
}

function gitStatus(args, { git } = {}) {
  return gitInvoke(args, { git }).status;
}

function gitInvoke(args, { git } = {}) {
  if (git) return git(args);
  return spawnSync('git', args, {
    encoding: 'utf8',
    timeout: 10_000,
    shell: false,
  });
}

function realpathIfAvailable(path) {
  try { return realpathSync(path); } catch { return path; }
}

function cleanupError(reason) {
  const error = new Error(`mc owned resource cleanup error (${reason})`);
  error.reason = reason;
  return error;
}
