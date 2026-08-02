import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';

import {
  RESOURCE_INTENT_SCHEMA,
  RESOURCE_RECEIPT_SCHEMA,
  bindWorkspaceOwnedResourceSync,
  createOwnedResourceIntentSync,
  listOwnedResourcesSync,
  observeDirectoryFingerprintSync,
  planOwnedResourceCleanupSync,
  readOwnedResourceSync,
  recordOwnedResourceCreationSync,
  resourceIntentDigest,
  validateResourceIntent,
  validateResourceReceipt,
} from '../../src/mc/owned-resource.js';
import { createSessionHomeSync, sessionHomePaths } from '../../src/mc/session-home.js';
import {
  createWorkspaceAssociationSync,
  listWorkspaceAssociationsSync,
  readWorkspaceAssociationSync,
  recordWorkspaceOwnershipObservationSync,
  updateWorkspaceObservationSync,
  updateWorkspaceUsageSync,
  validateWorkspaceRecord,
} from '../../src/mc/workspace-record.js';

const timestamp = '2026-08-02T20:00:00.000Z';
const later = '2026-08-02T20:01:00.000Z';
const latest = '2026-08-02T20:02:00.000Z';
const mcSessionId = 'mcs_000000000000000000000001';
let temporaryRoots = [];

afterEach(() => {
  for (const root of temporaryRoots) rmSync(root, { recursive: true, force: true });
  temporaryRoots = [];
});

function temporaryHome(prefix = 'mc-workspace-resource-') {
  const root = mkdtempSync(join(tmpdir(), prefix));
  temporaryRoots.push(root);
  return root;
}

function workspaceId(number) {
  return `mcw_${number.toString(16).padStart(24, '0')}`;
}

function resourceId(number) {
  return `mcr_${number.toString(16).padStart(24, '0')}`;
}

function createSession(mcHomeDir) {
  return createSessionHomeSync({
    mcHomeDir,
    mcSessionId,
    sourceId: 'machine_test',
    name: 'workspace-test',
    now: () => timestamp,
  });
}

function repository(identity, commonDir) {
  return {
    repository_identity: identity,
    public_ref: null,
    git_common_dir: commonDir,
  };
}

function checkout(gitDir, branch, head = 'a'.repeat(40)) {
  return { git_dir: gitDir, branch, head_sha: head };
}

test('associates ordinary directories and multiple repositories without changing session identity', () => {
  const mcHomeDir = temporaryHome();
  createSession(mcHomeDir);
  const fixtures = [
    { id: 1, kind: 'directory', path: '/projects/notes', repository: null, checkout: null },
    {
      id: 2,
      kind: 'repository',
      path: '/projects/one/api',
      repository: repository('local:repo-one', '/projects/one/api/.git'),
      checkout: null,
    },
    {
      id: 3,
      kind: 'repository',
      path: '/projects/two/api',
      repository: repository('local:repo-two', '/projects/two/api/.git'),
      checkout: null,
    },
  ];
  for (const fixture of fixtures) {
    createWorkspaceAssociationSync({
      mcHomeDir,
      mcSessionId,
      workspaceId: workspaceId(fixture.id),
      kind: fixture.kind,
      currentPath: fixture.path,
      repository: fixture.repository,
      checkout: fixture.checkout,
      now: () => timestamp,
    });
  }

  const listed = listWorkspaceAssociationsSync({ mcHomeDir, mcSessionId });
  assert.equal(listed.workspaces.length, 3);
  assert.deepEqual(listed.issues, []);
  assert.deepEqual(
    listed.workspaces.filter((item) => basename(item.current_path) === 'api')
      .map((item) => item.repository.repository_identity),
    ['local:repo-one', 'local:repo-two'],
  );
  assert.ok(listed.workspaces.every((item) => item.mc_session_id === mcSessionId));
});

test('associates multiple worktrees of one repository as independent context', () => {
  const mcHomeDir = temporaryHome();
  createSession(mcHomeDir);
  for (const [number, name] of [[1, 'alpha'], [2, 'beta']]) {
    createWorkspaceAssociationSync({
      mcHomeDir,
      mcSessionId,
      workspaceId: workspaceId(number),
      kind: 'worktree',
      currentPath: `/worktrees/${name}`,
      repository: repository('github:owner/repo', '/repo/.git'),
      checkout: checkout(`/repo/.git/worktrees/${name}`, `sess/${name}`),
      now: () => timestamp,
    });
  }

  const listed = listWorkspaceAssociationsSync({ mcHomeDir, mcSessionId });
  assert.equal(listed.workspaces.length, 2);
  assert.deepEqual(
    listed.workspaces.map((item) => item.repository.repository_identity),
    ['github:owner/repo', 'github:owner/repo'],
  );
  assert.notEqual(listed.workspaces[0].checkout.git_dir, listed.workspaces[1].checkout.git_dir);
});

test('records missing and relocated paths with revision CAS and launch use', () => {
  const mcHomeDir = temporaryHome();
  createSession(mcHomeDir);
  createWorkspaceAssociationSync({
    mcHomeDir,
    mcSessionId,
    workspaceId: workspaceId(1),
    kind: 'directory',
    currentPath: '/workspace/original',
    now: () => timestamp,
  });
  const missing = updateWorkspaceObservationSync({
    mcHomeDir,
    mcSessionId,
    workspaceId: workspaceId(1),
    expectedRevision: 1,
    pathState: 'missing',
    now: () => later,
  });
  assert.equal(missing.path_state, 'missing');
  assert.equal(missing.last_present_at, timestamp);
  const moved = updateWorkspaceObservationSync({
    mcHomeDir,
    mcSessionId,
    workspaceId: workspaceId(1),
    expectedRevision: 2,
    currentPath: '/workspace/relocated',
    pathState: 'present',
    now: () => latest,
  });
  assert.equal(moved.previous_path, '/workspace/original');
  assert.equal(moved.relocated_at, latest);
  assert.equal(moved.last_present_at, latest);
  assert.throws(() => updateWorkspaceObservationSync({
    mcHomeDir,
    mcSessionId,
    workspaceId: workspaceId(1),
    expectedRevision: 2,
    pathState: 'missing',
  }), (error) => error.reason === 'workspace-revision-conflict');

  const used = updateWorkspaceUsageSync({
    mcHomeDir,
    mcSessionId,
    workspaceId: workspaceId(1),
    expectedRevision: 3,
    preferredLaunch: true,
    now: () => latest,
  });
  assert.equal(used.preferred_launch, true);
  assert.equal(used.last_launch_used_at, latest);
});

test('isolates malformed workspace records and rejects authority-shaped extensions', () => {
  const mcHomeDir = temporaryHome();
  createSession(mcHomeDir);
  const first = createWorkspaceAssociationSync({
    mcHomeDir,
    mcSessionId,
    workspaceId: workspaceId(1),
    kind: 'directory',
    currentPath: '/workspace/healthy',
    now: () => timestamp,
  });
  createWorkspaceAssociationSync({
    mcHomeDir,
    mcSessionId,
    workspaceId: workspaceId(2),
    kind: 'directory',
    currentPath: '/workspace/corrupt',
    now: () => timestamp,
  });
  const paths = sessionHomePaths({ mcHomeDir, mcSessionId });
  writeFileSync(join(paths.workspacesPath, `${workspaceId(2)}.json`), '{bad-json', { mode: 0o600 });

  const listed = listWorkspaceAssociationsSync({ mcHomeDir, mcSessionId });
  assert.deepEqual(listed.workspaces.map((item) => item.workspace_id), [workspaceId(1)]);
  assert.equal(listed.issues[0].reason, 'corrupt');
  assert.equal(validateWorkspaceRecord({ ...first, credential: 'forbidden' }).ok, false);
  assert.throws(() => createWorkspaceAssociationSync({
    mcHomeDir,
    mcSessionId,
    workspaceId: workspaceId(3),
    kind: 'repository',
    currentPath: '/workspace/unsafe-repo',
    repository: repository('https://github.com/owner/repo', '/workspace/unsafe-repo/.git'),
  }), /workspace-invalid-fields/u);
});

test('records intent before creation and proves an exact directory without deleting it', () => {
  const mcHomeDir = temporaryHome();
  const target = join(temporaryHome('mc-owned-directory-'), 'created');
  mkdirSync(target, { mode: 0o700 });
  createSession(mcHomeDir);
  const workspace = createWorkspaceAssociationSync({
    mcHomeDir,
    mcSessionId,
    workspaceId: workspaceId(1),
    kind: 'directory',
    currentPath: target,
    now: () => timestamp,
  });
  const intended = createOwnedResourceIntentSync({
    mcHomeDir,
    mcSessionId,
    resourceId: resourceId(1),
    workspaceId: workspace.workspace_id,
    resourceKind: 'directory',
    target: { path: target },
    now: () => timestamp,
  });
  assert.equal(intended.state, 'intent-only');
  assert.equal(planOwnedResourceCleanupSync({
    mcHomeDir,
    mcSessionId,
    resourceId: resourceId(1),
  }).reason, 'resource-creation-unproven');

  const created = recordOwnedResourceCreationSync({
    mcHomeDir,
    mcSessionId,
    resourceId: resourceId(1),
    now: () => later,
  });
  assert.equal(created.state, 'created');
  assert.equal(created.creation_receipt.intent_sha256, resourceIntentDigest(created.intent));
  const bound = bindWorkspaceOwnedResourceSync({
    mcHomeDir,
    mcSessionId,
    workspaceId: workspaceId(1),
    resourceId: resourceId(1),
    expectedWorkspaceRevision: 1,
  });
  assert.deepEqual(bound.ownership, { kind: 'mc-created', resource_id: resourceId(1) });

  const plan = planOwnedResourceCleanupSync({
    mcHomeDir,
    mcSessionId,
    resourceId: resourceId(1),
    workspaceId: workspaceId(1),
  });
  assert.equal(plan.safe, true);
  assert.equal(plan.relocated, false);
  assert.equal(existsSync(target), true);
});

test('revalidates the same owned directory after relocation and fails closed when missing', () => {
  const mcHomeDir = temporaryHome();
  const root = temporaryHome('mc-owned-relocation-');
  const original = join(root, 'original');
  const relocated = join(root, 'relocated');
  mkdirSync(original, { mode: 0o700 });
  createSession(mcHomeDir);
  createWorkspaceAssociationSync({
    mcHomeDir,
    mcSessionId,
    workspaceId: workspaceId(1),
    kind: 'directory',
    currentPath: original,
    now: () => timestamp,
  });
  createOwnedResourceIntentSync({
    mcHomeDir,
    mcSessionId,
    resourceId: resourceId(1),
    workspaceId: workspaceId(1),
    resourceKind: 'directory',
    target: { path: original },
    now: () => timestamp,
  });
  recordOwnedResourceCreationSync({ mcHomeDir, mcSessionId, resourceId: resourceId(1), now: () => later });
  bindWorkspaceOwnedResourceSync({
    mcHomeDir,
    mcSessionId,
    workspaceId: workspaceId(1),
    resourceId: resourceId(1),
    expectedWorkspaceRevision: 1,
  });

  renameSync(original, relocated);
  updateWorkspaceObservationSync({
    mcHomeDir,
    mcSessionId,
    workspaceId: workspaceId(1),
    expectedRevision: 2,
    currentPath: relocated,
    pathState: 'present',
    now: () => latest,
  });
  const relocatedPlan = planOwnedResourceCleanupSync({
    mcHomeDir,
    mcSessionId,
    resourceId: resourceId(1),
    workspaceId: workspaceId(1),
  });
  assert.equal(relocatedPlan.safe, true);
  assert.equal(relocatedPlan.relocated, true);

  rmSync(relocated, { recursive: true });
  updateWorkspaceObservationSync({
    mcHomeDir,
    mcSessionId,
    workspaceId: workspaceId(1),
    expectedRevision: 3,
    pathState: 'missing',
    now: () => latest,
  });
  const missingPlan = planOwnedResourceCleanupSync({
    mcHomeDir,
    mcSessionId,
    resourceId: resourceId(1),
    workspaceId: workspaceId(1),
  });
  assert.equal(missingPlan.safe, false);
  assert.equal(missingPlan.reason, 'resource-observation-unavailable');
});

test('forged workspace ownership never grants cleanup authority', () => {
  const mcHomeDir = temporaryHome();
  const owned = join(temporaryHome('mc-owned-forgery-'), 'owned');
  const external = join(temporaryHome('mc-external-forgery-'), 'external');
  mkdirSync(owned, { mode: 0o700 });
  mkdirSync(external, { mode: 0o700 });
  createSession(mcHomeDir);
  for (const [number, path] of [[1, owned], [2, external]]) {
    createWorkspaceAssociationSync({
      mcHomeDir,
      mcSessionId,
      workspaceId: workspaceId(number),
      kind: 'directory',
      currentPath: path,
      now: () => timestamp,
    });
  }
  createOwnedResourceIntentSync({
    mcHomeDir,
    mcSessionId,
    resourceId: resourceId(1),
    workspaceId: workspaceId(1),
    resourceKind: 'directory',
    target: { path: owned },
    now: () => timestamp,
  });
  recordOwnedResourceCreationSync({ mcHomeDir, mcSessionId, resourceId: resourceId(1), now: () => later });
  recordWorkspaceOwnershipObservationSync({
    mcHomeDir,
    mcSessionId,
    workspaceId: workspaceId(2),
    expectedRevision: 1,
    ownership: { kind: 'mc-created', resource_id: resourceId(1) },
  });

  const plan = planOwnedResourceCleanupSync({
    mcHomeDir,
    mcSessionId,
    resourceId: resourceId(1),
    workspaceId: workspaceId(2),
  });
  assert.equal(plan.safe, false);
  assert.equal(plan.reason, 'workspace-resource-binding-mismatch');
  assert.equal(existsSync(owned), true);
  assert.equal(existsSync(external), true);
});

test('external observations and mismatched resource fingerprints stay non-destructive', () => {
  const mcHomeDir = temporaryHome();
  const external = join(temporaryHome('mc-external-resource-'), 'external');
  mkdirSync(external, { mode: 0o700 });
  createSession(mcHomeDir);
  createWorkspaceAssociationSync({
    mcHomeDir,
    mcSessionId,
    workspaceId: workspaceId(1),
    kind: 'directory',
    currentPath: external,
    now: () => timestamp,
  });
  const absent = planOwnedResourceCleanupSync({
    mcHomeDir,
    mcSessionId,
    resourceId: resourceId(99),
    workspaceId: workspaceId(1),
  });
  assert.equal(absent.safe, false);
  assert.equal(existsSync(external), true);

  createOwnedResourceIntentSync({
    mcHomeDir,
    mcSessionId,
    resourceId: resourceId(1),
    resourceKind: 'git-worktree',
    target: {
      path: '/worktrees/one',
      repository_identity: 'github:owner/repo',
      git_dir: '/repo/.git/worktrees/one',
      branch: 'sess/one',
    },
    now: () => timestamp,
  });
  const createdFingerprint = {
    kind: 'git-worktree',
    path: '/worktrees/one',
    real_path: '/worktrees/one',
    device: '1',
    inode: '2',
    birthtime_ns: '3',
    repository_identity: 'github:owner/repo',
    git_dir: '/repo/.git/worktrees/one',
  };
  recordOwnedResourceCreationSync({
    mcHomeDir,
    mcSessionId,
    resourceId: resourceId(1),
    now: () => later,
    observeResource: () => createdFingerprint,
  });
  const mismatch = planOwnedResourceCleanupSync({
    mcHomeDir,
    mcSessionId,
    resourceId: resourceId(1),
    currentPath: '/worktrees/one',
    observeResource: () => ({ ...createdFingerprint, inode: '3' }),
  });
  assert.equal(mismatch.safe, false);
  assert.equal(mismatch.reason, 'resource-target-mismatch');
});

test('resource schemas bind receipts to exact intents and isolate corruption', () => {
  const mcHomeDir = temporaryHome();
  const root = temporaryHome('mc-resource-corruption-');
  const target = join(root, 'target');
  const healthyTarget = join(root, 'healthy');
  mkdirSync(target, { mode: 0o700 });
  mkdirSync(healthyTarget, { mode: 0o700 });
  createSession(mcHomeDir);
  createOwnedResourceIntentSync({
    mcHomeDir,
    mcSessionId,
    resourceId: resourceId(1),
    resourceKind: 'directory',
    target: { path: target },
    now: () => timestamp,
  });
  const created = recordOwnedResourceCreationSync({
    mcHomeDir,
    mcSessionId,
    resourceId: resourceId(1),
    now: () => later,
  });
  assert.equal(validateResourceIntent({ ...created.intent, token: 'forbidden' }).ok, false);
  assert.equal(validateResourceReceipt(created.creation_receipt, created.intent).ok, true);
  assert.equal(validateResourceReceipt({
    ...created.creation_receipt,
    intent_sha256: '0'.repeat(64),
  }, created.intent).ok, false);
  createOwnedResourceIntentSync({
    mcHomeDir,
    mcSessionId,
    resourceId: resourceId(2),
    resourceKind: 'directory',
    target: { path: healthyTarget },
    now: () => timestamp,
  });
  recordOwnedResourceCreationSync({
    mcHomeDir,
    mcSessionId,
    resourceId: resourceId(2),
    now: () => later,
  });

  const paths = sessionHomePaths({ mcHomeDir, mcSessionId });
  const receiptPath = join(paths.resourcesPath, resourceId(1), 'creation-receipt.json');
  const receipt = JSON.parse(readFileSync(receiptPath, 'utf8'));
  writeFileSync(receiptPath, `${JSON.stringify({ ...receipt, intent_sha256: '0'.repeat(64) })}\n`, { mode: 0o600 });
  const read = readOwnedResourceSync({ mcHomeDir, mcSessionId, resourceId: resourceId(1) });
  assert.equal(read.kind, 'unknown');
  assert.equal(read.reason, 'receipt-resource-receipt-invalid-fields');
  const listed = listOwnedResourcesSync({ mcHomeDir, mcSessionId });
  assert.deepEqual(listed.resources.map((item) => item.intent.resource_id), [resourceId(2)]);
  assert.equal(listed.issues[0].resource_id, resourceId(1));
  assert.equal(existsSync(target), true);
});

test('directory observation rejects symlink targets', () => {
  const root = temporaryHome('mc-resource-symlink-');
  const target = join(root, 'target');
  const link = join(root, 'link');
  mkdirSync(target, { mode: 0o700 });
  symlinkSync(target, link);
  assert.throws(() => observeDirectoryFingerprintSync(link), (error) => (
    error.reason === 'resource-target-not-directory'
  ));
  assert.equal(RESOURCE_INTENT_SCHEMA, 'mc-owned-resource-intent');
  assert.equal(RESOURCE_RECEIPT_SCHEMA, 'mc-owned-resource-creation-receipt');
});
