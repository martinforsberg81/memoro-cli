import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { afterEach, test } from 'node:test';

import {
  beginRuntimeGenerationSync,
  inspectSessionRuntimeSync,
} from '../../../src/mc/session-runtime-journal.js';
import { createSessionHomeSync } from '../../../src/mc/session-home.js';
import { createWorkspaceAssociationSync } from '../../../src/mc/workspace-record.js';
import {
  publishCertifiedGitHubProjection,
} from '../../../src/runtime/certified-execution/github-projection.js';

const mcSessionId = 'mcs_000000000000000000000021';
const workspaceId = 'mcw_000000000000000000000021';
const generationId = 'mcg_000000000000000000000021';
let roots = [];

afterEach(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
  roots = [];
});

test('publishes replay-safe path-free session and workspace projections', async () => {
  const mcHomeDir = fixture();
  const generation = inspectSessionRuntimeSync({ mcHomeDir, mcSessionId }).active_generation;
  const calls = [];
  const input = {
    mcHomeDir,
    mcSessionId,
    generation,
    capabilities: readyCapabilities(),
    portal: { apiUrl: 'https://memoro.test', token: 'device-secret' },
    memoroFetchImpl: async (apiUrl, path, options) => {
      calls.push({ apiUrl, path, options });
      return { ok: true, schema: 1, projection: {} };
    },
  };

  assert.deepEqual(await publishCertifiedGitHubProjection(input), {
    ok: true,
    source_id: 'machine_test',
    workspace_id: workspaceId,
  });
  assert.deepEqual(await publishCertifiedGitHubProjection(input), {
    ok: true,
    source_id: 'machine_test',
    workspace_id: workspaceId,
  });

  assert.equal(calls.length, 4);
  assert.equal(calls[0].path,
    `/api/mc/v1/sources/machine_test/sessions/${mcSessionId}/projection`);
  assert.equal(calls[1].path,
    `/api/mc/v1/sources/machine_test/sessions/${mcSessionId}`
      + `/workspaces/${workspaceId}/projection`);
  assert.deepEqual(calls[0].options.body, calls[2].options.body);
  assert.deepEqual(calls[1].options.body, calls[3].options.body);
  assert.deepEqual(calls[0].options.body, {
    source_name: 'machine_test',
    name: 'projection-test',
    lifecycle: 'open',
    runtime_state: 'starting',
    work_status: null,
    active_runtime_generation: generationId,
    tool: 'codex',
    workspace_count: 1,
    preferred_workspace_id: workspaceId,
    repository_label: 'owner/repo',
    branch_observation: 'feature/certified',
    projection_revision: 2,
    observed_at: '2026-08-03T04:00:02.000Z',
    ttl_seconds: 600,
  });
  assert.deepEqual(calls[1].options.body, {
    kind: 'worktree',
    repository_provider: 'github',
    repository_id: '301',
    repository_full_name: 'owner/repo',
    checkout_ref: 'a'.repeat(40),
    branch_observation: 'feature/certified',
    present: true,
    projection_revision: 1,
    observed_at: '2026-08-03T04:00:02.000Z',
    ttl_seconds: 600,
  });
  const wire = JSON.stringify(calls.map((call) => ({
    path: call.path,
    body: call.options.body,
  })));
  for (const forbidden of ['device-secret', '/workspace/one', '/workspace/.git']) {
    assert.equal(wire.includes(forbidden), false);
  }
});

test('repository mismatch fails before projection or grant network access', async () => {
  const mcHomeDir = fixture();
  const generation = inspectSessionRuntimeSync({ mcHomeDir, mcSessionId }).active_generation;
  let calls = 0;
  const result = await publishCertifiedGitHubProjection({
    mcHomeDir,
    mcSessionId,
    generation,
    capabilities: {
      ...readyCapabilities(),
      github: {
        ...readyCapabilities().github,
        repository: {
          ...readyCapabilities().github.repository,
          full_name: 'owner/other',
          name: 'other',
        },
      },
    },
    portal: { apiUrl: 'https://memoro.test', token: 'device-secret' },
    memoroFetchImpl: async () => { calls += 1; },
  });
  assert.deepEqual(result, { ok: false, reason: 'certified-github-repository-mismatch' });
  assert.equal(calls, 0);
});

test('corrupt local reads fail closed before projection or grant network access', async () => {
  const mcHomeDir = fixture();
  const generation = inspectSessionRuntimeSync({ mcHomeDir, mcSessionId }).active_generation;
  let calls = 0;
  const result = await publishCertifiedGitHubProjection({
    mcHomeDir,
    mcSessionId,
    generation,
    capabilities: readyCapabilities(),
    portal: { apiUrl: 'https://memoro.test', token: 'device-secret' },
    memoroFetchImpl: async () => { calls += 1; },
    deps: {
      readSession() { throw new Error('/local/session/path'); },
    },
  });
  assert.deepEqual(result, {
    ok: false,
    reason: 'certified-github-session-state-unavailable',
  });
  assert.equal(calls, 0);
  assert.equal(JSON.stringify(result).includes('/local/session/path'), false);
});

function fixture() {
  const root = mkdtempSync('/private/tmp/mcgp-');
  roots.push(root);
  createSessionHomeSync({
    mcHomeDir: root,
    mcSessionId,
    sourceId: 'machine_test',
    name: 'projection-test',
    now: () => '2026-08-03T04:00:00.000Z',
  });
  createWorkspaceAssociationSync({
    mcHomeDir: root,
    mcSessionId,
    workspaceId,
    kind: 'worktree',
    currentPath: '/workspace/one',
    repository: {
      repository_identity: 'github:301',
      public_ref: 'owner/repo',
      git_common_dir: '/workspace/.git',
    },
    checkout: {
      git_dir: '/workspace/one/.git',
      branch: 'feature/certified',
      head_sha: 'a'.repeat(40),
    },
    now: () => '2026-08-03T04:00:01.000Z',
  });
  beginRuntimeGenerationSync({
    mcHomeDir: root,
    mcSessionId,
    generationId,
    action: 'start',
    tool: 'codex',
    workspaceId,
    launchCwd: '/workspace/one',
    now: () => '2026-08-03T04:00:02.000Z',
  });
  return root;
}

function readyCapabilities() {
  return {
    schema: 1,
    github: {
      state: 'ready',
      transport: 'mc-broker-v1',
      actor: 'installation',
      account: 'owner',
      repository: {
        id: 301,
        full_name: 'owner/repo',
        owner: 'owner',
        name: 'repo',
        private: true,
        archived: false,
        account: 'owner',
      },
      operations: ['pull_request.list'],
    },
  };
}
