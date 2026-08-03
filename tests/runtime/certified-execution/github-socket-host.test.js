import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, test } from 'node:test';

import { executeGitHubSessionOperation } from '../../../src/capabilities/github/github-session.js';
import { createSessionHomeSync } from '../../../src/mc/session-home.js';
import { sessionHomePaths } from '../../../src/mc/session-home-paths.js';
import {
  CertifiedGitHubSocketHost,
} from '../../../src/runtime/certified-execution/github-socket-host.js';

const mcSessionId = 'mcs_000000000000000000000010';
const sourceId = 'machine_test';
const workspaceId = 'mcw_000000000000000000000010';
let roots = [];

afterEach(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
  roots = [];
});

test('serves only typed allowlisted GitHub App operations on the exact V1 socket', async (t) => {
  const mcHomeDir = home();
  const socketPath = sessionHomePaths({ mcHomeDir, mcSessionId }).githubCapabilitySocketPath;
  const calls = [];
  const connectionClient = {
    async withGrant(provider, request, use) {
      calls.push({ type: 'grant', provider, request });
      return use({ token: 'grant-secret', apiUrl: 'https://memoro.invalid' });
    },
  };
  const host = new CertifiedGitHubSocketHost({
    mcHomeDir,
    mcSessionId,
    sourceId,
    workspaceId,
    socketPath,
    capabilities: readyCapabilities(),
    connectionClient,
    memoroFetchImpl: async (apiUrl, path, options) => {
      calls.push({ type: 'fetch', apiUrl, path, options });
      return { ok: true, request_id: options.body.request_id, data: [] };
    },
  });
  try {
    await host.start();
  } catch (error) {
    if (error?.cause?.code === 'EPERM') {
      t.skip('Unix socket listeners are unavailable in this sandbox');
      return;
    }
    throw error;
  }
  assert.equal(existsSync(socketPath), true);
  assert.equal(statSync(socketPath).mode & 0o777, 0o600);

  const allowed = await executeGitHubSessionOperation({
    operation: 'pull_request.list',
    requestId: 'request_abcdefgh',
    env: { MC_GITHUB_BROKER_SOCKET: socketPath },
  });
  assert.deepEqual(allowed, { ok: true, request_id: 'request_abcdefgh', data: [] });
  assert.equal(calls[0].provider, 'github');
  assert.equal(calls[0].request.codingSessionId, mcSessionId);
  assert.equal(calls[0].request.sourceId, sourceId);
  assert.equal(calls[0].request.workspaceId, workspaceId);
  assert.equal(calls[1].path,
    `/api/mc/v1/sources/${sourceId}/sessions/${mcSessionId}`
    + `/workspaces/${workspaceId}/github/operations`);
  assert.equal(calls[1].options.token, 'grant-secret');

  const denied = await executeGitHubSessionOperation({
    operation: 'pull_request.merge',
    params: {
      pull_number: 1,
      merge_method: 'squash',
      expected_head_sha: 'a'.repeat(40),
    },
    requestId: 'request_denied_abcdefgh',
    env: { MC_GITHUB_BROKER_SOCKET: socketPath },
  });
  assert.equal(denied.ok, false);
  assert.equal(denied.error.code, 'operation_not_allowed');
  assert.equal(calls.length, 2, 'denied operations must not mint a grant or call the network');

  await host.close();
  assert.equal(existsSync(socketPath), false);
});

test('rejects every socket outside the session-owned runtime path', () => {
  const mcHomeDir = home();
  assert.throws(() => new CertifiedGitHubSocketHost({
    mcHomeDir,
    mcSessionId,
    socketPath: join(mcHomeDir, 'forged.sock'),
    capabilities: readyCapabilities(),
    connectionClient: { withGrant() {} },
  }), /certified-github-socket-path-invalid/u);
});

function home() {
  // macOS limits Unix socket paths to roughly 100 bytes. Keep this fixture
  // representative of the normal ~/.memoro/mc root even when the test runner
  // deliberately redirects TMPDIR into a long isolation path.
  const root = mkdtempSync('/private/tmp/mcg-');
  roots.push(root);
  createSessionHomeSync({
    mcHomeDir: root,
    mcSessionId,
    sourceId: 'machine_test',
    name: 'github-socket',
    now: () => '2026-08-03T04:00:00.000Z',
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
        id: 1,
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
