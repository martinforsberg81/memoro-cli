import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  createOwnedResourceIntentSync,
  readOwnedResourceSync,
  recordOwnedResourceCreationSync,
} from '../../src/mc/owned-resource.js';
import {
  applySessionOwnedResourceCleanupSync,
  planSessionOwnedResourceCleanupSync,
} from '../../src/mc/owned-resource-cleanup.js';
import {
  createSessionHomeSync,
  readSessionHomeSync,
  sessionHomePaths,
  writeSessionProjectionSync,
} from '../../src/mc/session-home.js';
import { deleteLocalSession } from '../../src/mc/session-lifecycle-v1.js';
import {
  createWorkspaceAssociationSync,
  recordWorkspaceOwnershipObservationSync,
  updateWorkspaceObservationSync,
} from '../../src/mc/workspace-record.js';

const mcSessionId = 'mcs_000000000000000000000001';
const workspaceId = 'mcw_000000000000000000000001';
const resourceId = 'mcr_000000000000000000000001';
const timestamp = '2026-08-04T11:00:00.000Z';
let roots = [];

afterEach(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
  roots = [];
});

test('explicit cleanup removes an exact empty owned directory and records one receipt', () => {
  const { mcHomeDir, target } = fixture();
  const planned = planSessionOwnedResourceCleanupSync({ mcHomeDir, mcSessionId });
  assert.equal(planned.ok, true);
  assert.equal(planned.plans[0].verdict, 'exact-owned-resource');
  assert.equal(existsSync(target), true);

  const applied = applySessionOwnedResourceCleanupSync({ mcHomeDir, mcSessionId });
  assert.equal(applied.ok, true, JSON.stringify(applied));
  assert.equal(applied.results[0].action, 'removed');
  assert.equal(existsSync(target), false);
  assert.equal(readOwnedResourceSync({ mcHomeDir, mcSessionId, resourceId }).state, 'cleaned');

  const repeated = applySessionOwnedResourceCleanupSync({ mcHomeDir, mcSessionId });
  assert.equal(repeated.ok, true);
  assert.equal(repeated.results[0].action, 'unchanged');
});

test('cleanup refuses a non-empty directory and preserves its contents', () => {
  const { mcHomeDir, target } = fixture();
  writeFileSync(join(target, 'work.txt'), 'keep me');

  const applied = applySessionOwnedResourceCleanupSync({ mcHomeDir, mcSessionId });
  assert.equal(applied.ok, false);
  assert.equal(applied.results[0].reason, 'resource-not-empty');
  assert.equal(existsSync(join(target, 'work.txt')), true);
  assert.equal(readOwnedResourceSync({ mcHomeDir, mcSessionId, resourceId }).state, 'created');
});

test('cleanup fails closed when the owned directory was replaced by a symlink', () => {
  const { mcHomeDir, target } = fixture();
  const outside = temporary('mc-owned-outside-');
  rmSync(target, { recursive: true });
  symlinkSync(outside, target);

  const planned = planSessionOwnedResourceCleanupSync({ mcHomeDir, mcSessionId });
  assert.equal(planned.ok, false);
  assert.equal(planned.plans[0].reason, 'resource-target-unsafe');
  assert.equal(existsSync(outside), true);
});

test('cleanup records already-absent without deleting any neighboring path', () => {
  const { mcHomeDir, target, parent } = fixture();
  const neighbor = join(parent, 'neighbor');
  mkdirSync(neighbor);
  rmSync(target, { recursive: true });

  const applied = applySessionOwnedResourceCleanupSync({ mcHomeDir, mcSessionId });
  assert.equal(applied.ok, true, JSON.stringify(applied));
  assert.equal(applied.results[0].action, 'already-absent');
  assert.equal(existsSync(neighbor), true);
});

test('session deletion stays blocked until every created resource has a cleanup receipt', () => {
  const { mcHomeDir } = fixture();
  let session = readSessionHomeSync({ mcHomeDir, mcSessionId });
  session = writeSessionProjectionSync({
    mcHomeDir,
    mcSessionId,
    expectedRevision: session.projection.revision,
    lifecycle: 'archived',
    runtimeState: 'none',
    now: () => timestamp,
  });
  const blocked = deleteLocalSession({ mcHomeDir, session });
  assert.equal(blocked.reason, 'owned-resource-cleanup-required');
  assert.deepEqual(blocked.resources, [resourceId]);

  assert.equal(applySessionOwnedResourceCleanupSync({ mcHomeDir, mcSessionId }).ok, true);
  const deleted = deleteLocalSession({ mcHomeDir, session });
  assert.equal(deleted.ok, true);
});

test('a forged cleanup receipt invalidates resource state instead of granting deletion authority', () => {
  const { mcHomeDir } = fixture();
  assert.equal(applySessionOwnedResourceCleanupSync({ mcHomeDir, mcSessionId }).ok, true);
  const paths = sessionHomePaths({ mcHomeDir, mcSessionId });
  const receiptPath = join(paths.resourcesPath, resourceId, 'cleanup-receipt.json');
  const receipt = JSON.parse(readFileSync(receiptPath, 'utf8'));
  writeFileSync(receiptPath, `${JSON.stringify({
    ...receipt,
    creation_receipt_sha256: '0'.repeat(64),
  })}\n`, { mode: 0o600 });

  const read = readOwnedResourceSync({ mcHomeDir, mcSessionId, resourceId });
  assert.equal(read.kind, 'unknown');
  assert.equal(read.reason, 'cleanup-receipt-resource-cleanup-receipt-invalid-fields');
});

test('duplicate ownership receipts for one target block cleanup before deletion', () => {
  const { mcHomeDir, target } = fixture();
  const duplicate = 'mcr_000000000000000000000002';
  createOwnedResourceIntentSync({
    mcHomeDir,
    mcSessionId,
    resourceId: duplicate,
    resourceKind: 'directory',
    target: { path: target },
    now: () => timestamp,
  });
  recordOwnedResourceCreationSync({
    mcHomeDir,
    mcSessionId,
    resourceId: duplicate,
    now: () => timestamp,
  });

  const result = applySessionOwnedResourceCleanupSync({ mcHomeDir, mcSessionId });
  assert.equal(result.ok, false);
  assert.equal(result.issues[0].reason, 'duplicate-owned-resource-target');
  assert.equal(existsSync(target), true);
});

test('relocated resources that now claim one target block cleanup before deletion', () => {
  const { mcHomeDir, target } = fixture();
  const secondWorkspaceId = 'mcw_000000000000000000000002';
  const secondResourceId = 'mcr_000000000000000000000002';
  const secondTarget = join(temporary('mc-owned-relocated-target-'), 'created');
  mkdirSync(secondTarget, { mode: 0o700 });
  let workspace = createWorkspaceAssociationSync({
    mcHomeDir,
    mcSessionId,
    workspaceId: secondWorkspaceId,
    kind: 'directory',
    currentPath: secondTarget,
    now: () => '2026-08-04T11:00:01.000Z',
  });
  createOwnedResourceIntentSync({
    mcHomeDir,
    mcSessionId,
    resourceId: secondResourceId,
    workspaceId: secondWorkspaceId,
    resourceKind: 'directory',
    target: { path: secondTarget },
    now: () => '2026-08-04T11:00:01.000Z',
  });
  recordOwnedResourceCreationSync({
    mcHomeDir,
    mcSessionId,
    resourceId: secondResourceId,
    now: () => '2026-08-04T11:00:01.000Z',
  });
  workspace = recordWorkspaceOwnershipObservationSync({
    mcHomeDir,
    mcSessionId,
    workspaceId: secondWorkspaceId,
    expectedRevision: workspace.revision,
    ownership: { kind: 'mc-created', resource_id: secondResourceId },
  });
  updateWorkspaceObservationSync({
    mcHomeDir,
    mcSessionId,
    workspaceId: secondWorkspaceId,
    expectedRevision: workspace.revision,
    currentPath: target,
    pathState: 'present',
    now: () => '2026-08-04T11:00:03.000Z',
  });

  const result = applySessionOwnedResourceCleanupSync({ mcHomeDir, mcSessionId });
  assert.equal(result.ok, false);
  assert.equal(result.issues[0].reason, 'duplicate-owned-resource-target');
  assert.equal(existsSync(target), true);
  assert.equal(existsSync(secondTarget), true);
});

function fixture() {
  const mcHomeDir = temporary('mc-owned-cleanup-home-');
  const parent = temporary('mc-owned-cleanup-target-');
  const target = join(parent, 'created');
  mkdirSync(target, { mode: 0o700 });
  createSessionHomeSync({
    mcHomeDir,
    mcSessionId,
    sourceId: 'machine_test',
    name: 'cleanup-test',
    now: () => timestamp,
  });
  const workspace = createWorkspaceAssociationSync({
    mcHomeDir,
    mcSessionId,
    workspaceId,
    kind: 'directory',
    currentPath: target,
    now: () => timestamp,
  });
  createOwnedResourceIntentSync({
    mcHomeDir,
    mcSessionId,
    resourceId,
    workspaceId,
    resourceKind: 'directory',
    target: { path: target },
    now: () => timestamp,
  });
  recordOwnedResourceCreationSync({ mcHomeDir, mcSessionId, resourceId, now: () => timestamp });
  recordWorkspaceOwnershipObservationSync({
    mcHomeDir,
    mcSessionId,
    workspaceId,
    expectedRevision: workspace.revision,
    ownership: { kind: 'mc-created', resource_id: resourceId },
  });
  return { mcHomeDir, parent, target };
}

function temporary(prefix) {
  const root = mkdtempSync(join(tmpdir(), prefix));
  roots.push(root);
  return root;
}
