import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { existsSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { spawnSync } from 'node:child_process';

import {
  bindWorkspaceOwnedResourceSync,
  createOwnedResourceIntentSync,
  observeGitWorktreeFingerprintSync,
  recordOwnedResourceCreationSync,
} from '../../src/mc/owned-resource.js';
import { applySessionOwnedResourceCleanupSync } from '../../src/mc/owned-resource-cleanup.js';
import { createSessionHomeSync } from '../../src/mc/session-home.js';
import { createWorkspaceAssociationSync } from '../../src/mc/workspace-record.js';

const mcSessionId = 'mcs_000000000000000000000001';
const workspaceId = 'mcw_000000000000000000000001';
const worktreeResourceId = 'mcr_000000000000000000000002';
const branchResourceId = 'mcr_000000000000000000000001';
const timestamp = '2026-08-04T13:00:00.000Z';
const repositoryIdentity = 'local:owned-cleanup-test';
let roots = [];

afterEach(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
  roots = [];
});

test('explicit cleanup removes a clean owned worktree and its merged owned branch in order', () => {
  const fixture = repository();
  const mcHomeDir = privateHome();
  const worktree = join(fixture.root, 'clean');
  const branch = 'sess/clean';
  const ref = `refs/heads/${branch}`;
  const gitDir = join(fixture.commonDir, 'worktrees', basename(worktree));
  createSession(mcHomeDir);
  const workspace = createWorkspaceAssociationSync({
    mcHomeDir,
    mcSessionId,
    workspaceId,
    kind: 'worktree',
    currentPath: worktree,
    repository: repositoryRecord(fixture.commonDir),
    checkout: { git_dir: gitDir, branch, head_sha: fixture.mainOid },
    now: () => timestamp,
  });
  createOwnedResourceIntentSync({
    mcHomeDir,
    mcSessionId,
    resourceId: worktreeResourceId,
    workspaceId,
    resourceKind: 'git-worktree',
    target: { path: worktree, repository_identity: repositoryIdentity, git_dir: gitDir, branch },
    now: () => timestamp,
  });
  createOwnedResourceIntentSync({
    mcHomeDir,
    mcSessionId,
    resourceId: branchResourceId,
    resourceKind: 'git-branch',
    target: { repository_identity: repositoryIdentity, git_common_dir: fixture.commonDir, ref },
    now: () => timestamp,
  });
  git(fixture.repo, ['branch', branch]);
  git(fixture.repo, ['worktree', 'add', '--quiet', worktree, branch]);
  recordOwnedResourceCreationSync({
    mcHomeDir,
    mcSessionId,
    resourceId: worktreeResourceId,
    now: () => timestamp,
    observeResource: () => observeGitWorktreeFingerprintSync({
      path: worktree,
      repositoryIdentity,
      gitDir: realpathSync(gitDir),
    }),
  });
  recordOwnedResourceCreationSync({
    mcHomeDir,
    mcSessionId,
    resourceId: branchResourceId,
    now: () => timestamp,
    observeResource: () => ({
      kind: 'git-ref',
      repository_identity: repositoryIdentity,
      git_common_dir: fixture.commonDir,
      ref,
      ref_oid: git(fixture.repo, ['rev-parse', ref]),
    }),
  });
  bindWorkspaceOwnedResourceSync({
    mcHomeDir,
    mcSessionId,
    workspaceId,
    resourceId: worktreeResourceId,
    expectedWorkspaceRevision: workspace.revision,
  });

  const result = applySessionOwnedResourceCleanupSync({
    mcHomeDir,
    mcSessionId,
    now: () => timestamp,
  });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.deepEqual(result.results.map((item) => item.action), ['removed', 'removed']);
  assert.equal(existsSync(worktree), false);
  assert.equal(gitStatus(fixture.repo, ['show-ref', '--verify', '--quiet', ref]), 1);
  assert.equal(gitStatus(fixture.repo, ['show-ref', '--verify', '--quiet', 'refs/heads/main']), 0);
});

test('cleanup preserves a dirty owned worktree', () => {
  const fixture = repository();
  const mcHomeDir = privateHome();
  const worktree = join(fixture.root, 'dirty');
  const branch = 'sess/dirty';
  const gitDir = join(fixture.commonDir, 'worktrees', basename(worktree));
  createSession(mcHomeDir);
  const workspace = createWorkspaceAssociationSync({
    mcHomeDir,
    mcSessionId,
    workspaceId,
    kind: 'worktree',
    currentPath: worktree,
    repository: repositoryRecord(fixture.commonDir),
    checkout: { git_dir: gitDir, branch, head_sha: fixture.mainOid },
    now: () => timestamp,
  });
  createOwnedResourceIntentSync({
    mcHomeDir,
    mcSessionId,
    resourceId: worktreeResourceId,
    workspaceId,
    resourceKind: 'git-worktree',
    target: { path: worktree, repository_identity: repositoryIdentity, git_dir: gitDir, branch },
    now: () => timestamp,
  });
  git(fixture.repo, ['branch', branch]);
  git(fixture.repo, ['worktree', 'add', '--quiet', worktree, branch]);
  recordOwnedResourceCreationSync({
    mcHomeDir,
    mcSessionId,
    resourceId: worktreeResourceId,
    now: () => timestamp,
    observeResource: () => observeGitWorktreeFingerprintSync({
      path: worktree,
      repositoryIdentity,
      gitDir: realpathSync(gitDir),
    }),
  });
  bindWorkspaceOwnedResourceSync({
    mcHomeDir,
    mcSessionId,
    workspaceId,
    resourceId: worktreeResourceId,
    expectedWorkspaceRevision: workspace.revision,
  });
  writeFileSync(join(worktree, 'uncommitted.txt'), 'keep');

  const result = applySessionOwnedResourceCleanupSync({ mcHomeDir, mcSessionId });
  assert.equal(result.ok, false);
  assert.equal(result.results[0].reason, 'worktree-dirty');
  assert.equal(existsSync(join(worktree, 'uncommitted.txt')), true);
});

test('cleanup preserves ignored files in an otherwise clean owned worktree', () => {
  const fixture = repository();
  const mcHomeDir = privateHome();
  const worktree = join(fixture.root, 'ignored');
  const branch = 'sess/ignored';
  const gitDir = join(fixture.commonDir, 'worktrees', basename(worktree));
  createSession(mcHomeDir);
  const workspace = createWorkspaceAssociationSync({
    mcHomeDir,
    mcSessionId,
    workspaceId,
    kind: 'worktree',
    currentPath: worktree,
    repository: repositoryRecord(fixture.commonDir),
    checkout: { git_dir: gitDir, branch, head_sha: fixture.mainOid },
    now: () => timestamp,
  });
  createOwnedResourceIntentSync({
    mcHomeDir,
    mcSessionId,
    resourceId: worktreeResourceId,
    workspaceId,
    resourceKind: 'git-worktree',
    target: { path: worktree, repository_identity: repositoryIdentity, git_dir: gitDir, branch },
    now: () => timestamp,
  });
  git(fixture.repo, ['branch', branch]);
  git(fixture.repo, ['worktree', 'add', '--quiet', worktree, branch]);
  recordOwnedResourceCreationSync({
    mcHomeDir,
    mcSessionId,
    resourceId: worktreeResourceId,
    now: () => timestamp,
    observeResource: () => observeGitWorktreeFingerprintSync({
      path: worktree,
      repositoryIdentity,
      gitDir: realpathSync(gitDir),
    }),
  });
  bindWorkspaceOwnedResourceSync({
    mcHomeDir,
    mcSessionId,
    workspaceId,
    resourceId: worktreeResourceId,
    expectedWorkspaceRevision: workspace.revision,
  });
  writeFileSync(join(fixture.commonDir, 'info', 'exclude'), 'ignored.txt\n');
  writeFileSync(join(worktree, 'ignored.txt'), 'keep');
  assert.equal(git(fixture.repo, ['-C', worktree, 'status', '--porcelain']), '');

  const result = applySessionOwnedResourceCleanupSync({ mcHomeDir, mcSessionId });
  assert.equal(result.ok, false);
  assert.equal(result.results[0].reason, 'worktree-dirty');
  assert.equal(existsSync(join(worktree, 'ignored.txt')), true);
});

test('cleanup preserves an owned branch that is not merged into another local branch', () => {
  const fixture = repository();
  const mcHomeDir = privateHome();
  const branch = 'sess/unmerged';
  const ref = `refs/heads/${branch}`;
  createSession(mcHomeDir);
  createWorkspaceAssociationSync({
    mcHomeDir,
    mcSessionId,
    workspaceId,
    kind: 'repository',
    currentPath: fixture.repo,
    repository: repositoryRecord(fixture.commonDir),
    now: () => timestamp,
  });
  createOwnedResourceIntentSync({
    mcHomeDir,
    mcSessionId,
    resourceId: branchResourceId,
    resourceKind: 'git-branch',
    target: { repository_identity: repositoryIdentity, git_common_dir: fixture.commonDir, ref },
    now: () => timestamp,
  });
  git(fixture.repo, ['switch', '--quiet', '-c', branch]);
  writeFileSync(join(fixture.repo, 'work.txt'), 'unmerged');
  git(fixture.repo, ['add', 'work.txt']);
  git(fixture.repo, ['commit', '--quiet', '-m', 'Unmerged work']);
  const oid = git(fixture.repo, ['rev-parse', ref]);
  git(fixture.repo, ['switch', '--quiet', 'main']);
  recordOwnedResourceCreationSync({
    mcHomeDir,
    mcSessionId,
    resourceId: branchResourceId,
    now: () => timestamp,
    observeResource: () => ({
      kind: 'git-ref',
      repository_identity: repositoryIdentity,
      git_common_dir: fixture.commonDir,
      ref,
      ref_oid: oid,
    }),
  });

  const result = applySessionOwnedResourceCleanupSync({ mcHomeDir, mcSessionId });
  assert.equal(result.ok, false);
  assert.equal(result.results[0].reason, 'branch-unmerged');
  assert.equal(gitStatus(fixture.repo, ['show-ref', '--verify', '--quiet', ref]), 0);
});

function repository() {
  const root = mkdtempSync(join(tmpdir(), 'mc-owned-git-'));
  roots.push(root);
  const repo = join(root, 'repo');
  git(root, ['init', '--quiet', '--initial-branch=main', repo]);
  git(repo, ['config', 'user.name', 'mc test']);
  git(repo, ['config', 'user.email', 'mc@example.invalid']);
  writeFileSync(join(repo, 'README.md'), 'initial\n');
  git(repo, ['add', 'README.md']);
  git(repo, ['commit', '--quiet', '-m', 'Initial']);
  return {
    root,
    repo,
    commonDir: realpathSync(join(repo, '.git')),
    mainOid: git(repo, ['rev-parse', 'HEAD']),
  };
}

function privateHome() {
  const root = mkdtempSync(join(tmpdir(), 'mc-owned-git-home-'));
  roots.push(root);
  return root;
}

function createSession(mcHomeDir) {
  createSessionHomeSync({
    mcHomeDir,
    mcSessionId,
    sourceId: 'machine_test',
    name: 'git-cleanup',
    now: () => timestamp,
  });
}

function repositoryRecord(commonDir) {
  return { repository_identity: repositoryIdentity, public_ref: null, git_common_dir: commonDir };
}

function git(cwd, args) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8', shell: false });
  if (result.status !== 0) throw new Error(result.stderr || `git failed: ${args.join(' ')}`);
  return String(result.stdout || '').trim();
}

function gitStatus(cwd, args) {
  return spawnSync('git', args, { cwd, encoding: 'utf8', shell: false }).status;
}
