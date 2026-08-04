import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  acceptRuntimeGenerationSync,
  beginRuntimeGenerationSync,
  bindRuntimeConversationSync,
  completeRuntimeGenerationSync,
  inspectSessionRuntimeSync,
  markRuntimeGenerationLiveSync,
  recordRuntimeGenerationExitSync,
} from '../../src/mc/session-runtime-journal.js';
import { createSessionHomeSync, readSessionHomeSync, writeSessionProjectionSync } from '../../src/mc/session-home.js';
import { createWorkspaceAssociationSync } from '../../src/mc/workspace-record.js';
import { createOwnedResourceIntentSync } from '../../src/mc/owned-resource.js';
import { endLocalSession, deleteLocalSession } from '../../src/mc/session-lifecycle-v1.js';
import { writeRuntimeHostManifestSync } from '../../src/runtime/session-host/ephemeral-state.js';

const mcSessionId = 'mcs_000000000000000000000001';
const generationId = 'mcg_000000000000000000000001';
const timestamp = '2026-08-04T10:00:00.000Z';
let roots = [];

afterEach(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
  roots = [];
});

test('end archives an idle session while keeping every external workspace', async () => {
  const mcHomeDir = temporary('mc-end-home-');
  const workspace = temporary('mc-end-workspace-');
  const session = createSession(mcHomeDir);
  createWorkspaceAssociationSync({
    mcHomeDir,
    mcSessionId,
    kind: 'directory',
    currentPath: workspace,
    ownership: { kind: 'external' },
    now: () => timestamp,
  });

  const result = await endLocalSession({
    mcHomeDir,
    session,
    deps: { teardownDevServers: async () => ({ ok: true, results: [] }) },
  });

  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.lifecycle, 'archived');
  assert.equal(existsSync(workspace), true);
  assert.equal(readSessionHomeSync({ mcHomeDir, mcSessionId }).projection.lifecycle, 'archived');
});

test('end aborts a planned generation before archiving', async () => {
  const mcHomeDir = temporary('mc-end-planned-');
  const session = createSession(mcHomeDir);
  beginRuntimeGenerationSync({
    mcHomeDir,
    mcSessionId,
    generationId,
    action: 'start',
    tool: 'codex',
    launchCwd: '/workspace',
    now: () => timestamp,
  });

  const result = await endLocalSession({
    mcHomeDir,
    session,
    deps: { teardownDevServers: async () => ({ ok: true, results: [] }) },
  });

  assert.equal(result.ok, true);
  assert.equal(result.runtime.reason, 'planned-generation-aborted');
  assert.equal(inspectSessionRuntimeSync({ mcHomeDir, mcSessionId }).active_generation, null);
});

test('end stops only the exact live generation and confirms its terminal journal', async () => {
  const mcHomeDir = temporary('mc-end-live-');
  const session = createSession(mcHomeDir);
  const now = clock();
  beginRuntimeGenerationSync({
    mcHomeDir,
    mcSessionId,
    generationId,
    action: 'start',
    tool: 'codex',
    launchCwd: '/workspace',
    now,
  });
  acceptRuntimeGenerationSync({ mcHomeDir, mcSessionId, generationId, now });
  markRuntimeGenerationLiveSync({ mcHomeDir, mcSessionId, generationId, now });
  const conversation = bindRuntimeConversationSync({
    mcHomeDir,
    mcSessionId,
    generationId,
    conversationId: 'mcc_000000000000000000000001',
    handle: 'provider-conversation',
    now,
  });
  const stopped = [];

  const result = await endLocalSession({
    mcHomeDir,
    session,
    deps: {
      teardownDevServers: async () => ({ ok: true, results: [] }),
      stopRuntime: async (identity) => {
        stopped.push(identity);
        recordRuntimeGenerationExitSync({
          mcHomeDir,
          mcSessionId,
          generationId,
          exitCode: 0,
          now,
        });
        completeRuntimeGenerationSync({
          mcHomeDir,
          mcSessionId,
          generationId,
          conversationId: conversation.conversation_id,
          now,
        });
        return { ok: true, stopped: true };
      },
    },
  });

  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(stopped.length, 1);
  assert.equal(stopped[0].mcSessionId, mcSessionId);
  assert.equal(stopped[0].generationId, generationId);
  assert.equal(inspectSessionRuntimeSync({ mcHomeDir, mcSessionId }).active_generation, null);
});

test('delete requires archived state and removes only the session home and name claim', () => {
  const mcHomeDir = temporary('mc-delete-home-');
  const workspace = temporary('mc-delete-workspace-');
  let session = createSession(mcHomeDir);
  createWorkspaceAssociationSync({
    mcHomeDir,
    mcSessionId,
    kind: 'directory',
    currentPath: workspace,
    ownership: { kind: 'external' },
    now: () => timestamp,
  });
  assert.equal(deleteLocalSession({ mcHomeDir, session }).reason, 'session-not-archived');
  session = writeSessionProjectionSync({
    mcHomeDir,
    mcSessionId,
    expectedRevision: session.projection.revision,
    lifecycle: 'archived',
    runtimeState: 'none',
    now: () => timestamp,
  });

  assert.equal(deleteLocalSession({
    mcHomeDir,
    session,
    deps: { listDevServers: () => [{ mc_session_id: mcSessionId }] },
  }).reason, 'session-dev-server-cleanup-required');
  assert.equal(deleteLocalSession({
    mcHomeDir,
    session,
    deps: {
      readDevServerInventory: () => ({
        manifests: [],
        issues: [{ reason: 'invalid-dev-server-entry' }],
      }),
    },
  }).reason, 'session-dev-server-state-unsafe');
  assert.equal(deleteLocalSession({
    mcHomeDir,
    session,
    deps: { listDevServers: () => [{ instance_id: 'legacy-unbound' }] },
  }).reason, 'session-dev-server-state-unsafe');

  const deleted = deleteLocalSession({ mcHomeDir, session });
  assert.equal(deleted.ok, true);
  assert.equal(readSessionHomeSync({ mcHomeDir, mcSessionId }).kind, 'absent');
  assert.equal(existsSync(workspace), true);
});

test('delete retains an unresolved resource intent after interrupted creation', () => {
  const mcHomeDir = temporary('mc-delete-intent-only-');
  let session = createSession(mcHomeDir);
  const resourceId = 'mcr_000000000000000000000001';
  createOwnedResourceIntentSync({
    mcHomeDir,
    mcSessionId,
    resourceId,
    resourceKind: 'directory',
    target: { path: join(temporary('mc-delete-possible-resource-'), 'possibly-created') },
    now: () => timestamp,
  });
  session = writeSessionProjectionSync({
    mcHomeDir,
    mcSessionId,
    expectedRevision: session.projection.revision,
    lifecycle: 'archived',
    runtimeState: 'none',
    now: () => timestamp,
  });
  assert.throws(() => createOwnedResourceIntentSync({
    mcHomeDir,
    mcSessionId,
    resourceId: 'mcr_000000000000000000000002',
    resourceKind: 'directory',
    target: { path: join(temporary('mc-delete-late-resource-'), 'late') },
    now: () => timestamp,
  }), (error) => error.reason === 'session-archived');

  const result = deleteLocalSession({ mcHomeDir, session });
  assert.equal(result.reason, 'owned-resource-cleanup-required');
  assert.deepEqual(result.resources, [resourceId]);
  assert.equal(readSessionHomeSync({ mcHomeDir, mcSessionId }).kind, 'present');
});

test('end detects a dev server registered after teardown and still archives safely', async () => {
  const mcHomeDir = temporary('mc-end-dev-race-');
  const session = createSession(mcHomeDir);
  const result = await endLocalSession({
    mcHomeDir,
    session,
    deps: {
      teardownDevServers: async () => ({ ok: true, results: [] }),
      verifyDevServers: () => ({
        manifests: [{ mc_session_id: mcSessionId, instance_id: 'late-sidecar' }],
        issues: [],
      }),
    },
  });

  assert.equal(result.ok, false);
  assert.equal(result.reason, 'dev-server-cleanup-incomplete');
  assert.deepEqual(result.dev_server_verification.remaining, ['late-sidecar']);
  assert.equal(readSessionHomeSync({ mcHomeDir, mcSessionId }).projection.lifecycle, 'archived');
});

test('end archives but reports an unsafe live runtime manifest whose host is gone', async () => {
  const mcHomeDir = temporary('mc-end-unsafe-runtime-');
  const session = createSession(mcHomeDir);
  writeRuntimeHostManifestSync({
    mcHomeDir,
    mcSessionId,
    generationId,
    state: 'live',
    hostPid: 51001,
    processPid: 51002,
    cols: 80,
    rows: 24,
    startedAt: timestamp,
    updatedAt: timestamp,
  });
  const result = await endLocalSession({
    mcHomeDir,
    session,
    deps: {
      processIsAlive: () => false,
      teardownDevServers: async () => ({ ok: true, results: [] }),
    },
  });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'runtime-host-process-absent');
  assert.equal(readSessionHomeSync({ mcHomeDir, mcSessionId }).projection.lifecycle, 'archived');
});

function createSession(mcHomeDir) {
  return createSessionHomeSync({
    mcHomeDir,
    mcSessionId,
    sourceId: 'machine_test',
    name: 'lifecycle-test',
    now: () => timestamp,
  });
}

function temporary(prefix) {
  const root = mkdtempSync(join(tmpdir(), prefix));
  roots.push(root);
  return root;
}

function clock() {
  let value = Date.parse(timestamp);
  return () => new Date(value += 1000).toISOString();
}
