import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import test, { afterEach, describe } from 'node:test';

import {
  GITHUB_CREDENTIAL_ENV_NAMES,
  MC_GITHUB_BROKER_SOCKET_ENV,
  MC_SESSION_CAPABILITIES_ENV,
  executeGitHubControlPlaneOperation,
  executeGitHubSessionOperation,
  fetchGitHubSessionCapabilities,
  prepareGitHubSessionForLaunch,
  renderGitHubSessionMarkdown,
} from '../../src/mc/github-session.js';

const REPOSITORY = Object.freeze({
  id: 301,
  full_name: 'acme/widgets',
  owner: 'acme',
  name: 'widgets',
  private: true,
  archived: false,
  account: 'acme',
});

let tmp = null;
afterEach(() => {
  if (tmp) rmSync(tmp, { recursive: true, force: true });
  tmp = null;
});

function readyResponse() {
  return {
    ok: true,
    github: {
      schema: 1,
      state: 'ready',
      repair_action: null,
      actor: { type: 'installation', login: 'memoro[bot]' },
      accounts: [{ login: 'acme', type: 'Organization' }],
      repository: REPOSITORY,
      repositories: [REPOSITORY],
      operations: [
        'connection.status',
        'repository.metadata',
        'pull_request.list',
        'pull_request.view',
        'checks.list',
      ],
    },
  };
}

function grantClient(sourceId = 'local:device:test') {
  return {
    withGrant: async (_provider, _request, use) => use({
      token: 'short-lived-grant-sentinel',
      apiUrl: 'https://memoro.test',
      source: {
        id: sourceId,
        kind: sourceId.startsWith('cloud:') ? 'cloud' : 'local',
      },
    }),
  };
}

describe('GitHub session capability boundary', () => {
  test('builds byte-identical token-free descriptors for local and cloud sources', async () => {
    const calls = [];
    const fetch = async (apiUrl, path, options) => {
      calls.push({ apiUrl, path, options });
      return readyResponse();
    };
    const local = await fetchGitHubSessionCapabilities({
      connectionClient: grantClient('local:device:test'),
      repository: 'acme/widgets',
      sourceKind: 'local',
      memoroFetchImpl: fetch,
    });
    const cloud = await fetchGitHubSessionCapabilities({
      connectionClient: grantClient('cloud:cld_123456'),
      repository: 'acme/widgets',
      sourceKind: 'cloud',
      memoroFetchImpl: fetch,
    });

    assert.equal(JSON.stringify(local), JSON.stringify(cloud));
    assert.equal(JSON.stringify(local).includes('memoro-secret-sentinel'), false);
    assert.equal(JSON.stringify(local).includes('source_kind'), false);
    assert.equal(JSON.stringify(local).includes('coding_session_id'), false);
    assert.equal(JSON.stringify(local).includes('approval_mode'), false);
    assert.equal(calls[0].path, '/api/mc/github/status?repository=acme%2Fwidgets');
    assert.equal(calls[0].options.token, 'short-lived-grant-sentinel');
  });

  test('legacy server approval metadata never reaches the coding-tool child', async () => {
    tmp = mkdtempSync(join(tmpdir(), 'mc-github-session-'));
    const response = readyResponse();
    response.github.approval_mode = 'prompt';
    const capabilities = await fetchGitHubSessionCapabilities({
      connectionClient: grantClient(),
      repository: 'acme/widgets',
      memoroFetchImpl: async () => response,
    });
    const result = await prepareGitHubSessionForLaunch({
      baseEnv: { PATH: '/usr/bin:/bin' },
      capabilities,
      sessionId: 'sess_legacy',
      socketPath: '/tmp/session.sock',
      mcHomeDir: tmp,
      deps: {
        ensureGitHubShim: async () => '/tmp/mc-github-shim/gh',
      },
    });

    assert.equal(JSON.stringify(result.capabilities).includes('approval_mode'), false);
    assert.equal(result.env[MC_SESSION_CAPABILITIES_ENV].includes('approval_mode'), false);
  });

  test('write-ready grounding exposes the provider-neutral surface without mc approval state', async () => {
    const response = readyResponse();
    response.github.operations.push('pull_request.create', 'pull_request.update');
    const capabilities = await fetchGitHubSessionCapabilities({
      connectionClient: grantClient(),
      repository: 'acme/widgets',
      memoroFetchImpl: async () => response,
    });
    const markdown = renderGitHubSessionMarkdown(capabilities);

    assert.match(markdown, /mc github pr list\|view\|checks\|create\|update/);
    assert.match(markdown, /coding host’s native approval policy/);
    assert.match(markdown, /gh pr create/);
    assert.doesNotMatch(markdown, /browser|approval_mode|approval_required|approve exact/i);
    assert.doesNotMatch(markdown, /access_token|GH_TOKEN|installation_id/i);
  });

  test('installs a session-only shim while scrubbing every inherited GitHub credential', async () => {
    tmp = mkdtempSync(join(tmpdir(), 'mc-github-session-'));
    const secrets = Object.fromEntries(
      GITHUB_CREDENTIAL_ENV_NAMES.map((name) => [name, `secret-${name}`]),
    );
    const result = await prepareGitHubSessionForLaunch({
      baseEnv: { PATH: '/usr/bin:/bin', KEEP: 'yes', ...secrets },
      capabilities: await fetchGitHubSessionCapabilities({
        connectionClient: grantClient(),
        repository: 'acme/widgets',
        memoroFetchImpl: async () => readyResponse(),
      }),
      sessionId: 'sess_abcdef',
      socketPath: join(tmp, 'sess.sock'),
      mcHomeDir: tmp,
    });

    assert.equal(result.env.KEEP, 'yes');
    for (const name of GITHUB_CREDENTIAL_ENV_NAMES) assert.equal(result.env[name], undefined);
    assert.equal(result.env[MC_GITHUB_BROKER_SOCKET_ENV], join(tmp, 'sess.sock'));
    assert.equal(result.env.PATH.split(delimiter)[0], join(tmp, 'hosts', 'sess_abcdef', 'tools', 'bin'));
    assert.deepEqual(JSON.parse(result.env[MC_SESSION_CAPABILITIES_ENV]), result.capabilities);
    assert.equal(statSync(result.shim_path).mode & 0o777, 0o700);

    const observable = JSON.stringify({ env: result.env, shim: readFileSync(result.shim_path, 'utf8') });
    assert.doesNotMatch(observable, /memoro-secret-sentinel|secret-GH_TOKEN|secret-GITHUB_TOKEN/);
    assert.doesNotMatch(observable, /installation_id|private_key|access_token/);
  });

  test('operation client sends only github-op-v1 over the bound socket and strictly decodes replies', async () => {
    const calls = [];
    const response = await executeGitHubSessionOperation({
      operation: 'pull_request.view',
      params: { pull_number: 42 },
      requestId: 'request_abcdefgh',
      env: { [MC_GITHUB_BROKER_SOCKET_ENV]: '/tmp/session.sock' },
      request: async (message, options) => {
        calls.push({ message, options });
        return { ok: true, request_id: message.request_id, data: { number: 42, title: 'Safe' } };
      },
    });

    assert.deepEqual(response, {
      ok: true,
      request_id: 'request_abcdefgh',
      data: { number: 42, title: 'Safe' },
    });
    assert.deepEqual(calls, [{
      message: {
        type: 'github_operation',
        schema: 1,
        request_id: 'request_abcdefgh',
        operation: 'pull_request.view',
        params: { pull_number: 42 },
      },
      options: { socketPath: '/tmp/session.sock', timeoutMs: 30_000 },
    }]);
    assert.equal('repository' in calls[0].message, false);
    assert.equal('source_id' in calls[0].message, false);
    assert.equal('coding_session_id' in calls[0].message, false);
  });

  test('trusted local and cloud sidecars send byte-identical write bodies with identity outside the request', async () => {
    const calls = [];
    const request = {
      type: 'github_operation',
      schema: 1,
      request_id: 'request_write_abcdefgh',
      operation: 'pull_request.create',
      params: {
        title: 'Safe draft',
        body: 'Exact body',
        head: 'agent/write',
        base: 'main',
        draft: true,
        expected_head_sha: 'a'.repeat(40),
        expected_base_sha: 'b'.repeat(40),
      },
    };
    const fetch = async (_apiUrl, path, options) => {
      calls.push({ path, options });
      return {
        ok: true,
        request_id: options.body.request_id,
        data: { number: 17, title: 'Safe draft', draft: true },
      };
    };

    for (const sourceId of ['local:mac', 'cloud:cld_123456']) {
      const response = await executeGitHubControlPlaneOperation({
        connectionClient: grantClient(sourceId),
        codingSessionId: 'sess_abcdef',
        request,
        memoroFetchImpl: fetch,
      });
      assert.equal(response.ok, true);
    }

    assert.equal(JSON.stringify(calls[0].options.body), JSON.stringify(calls[1].options.body));
    assert.ok(calls.every((call) => call.options.sourceId === undefined));
    assert.ok(calls.every((call) => call.options.token === 'short-lived-grant-sentinel'));
    assert.ok(calls.every((call) => call.path === '/api/mc/github/sessions/sess_abcdef/operations'));
    assert.ok(calls.every((call) => !('source_id' in call.options.body)));
    assert.ok(calls.every((call) => !('coding_session_id' in call.options.body)));
    assert.ok(calls.every((call) => !('repository' in call.options.body)));
  });

  test('missing broker and hostile broker responses fail closed without echoing material', async () => {
    const missing = await executeGitHubSessionOperation({
      operation: 'repository.metadata',
      requestId: 'request_abcdefgh',
      env: { [MC_SESSION_CAPABILITIES_ENV]: JSON.stringify(await fetchGitHubSessionCapabilities({
        connectionClient: grantClient(),
        repository: 'acme/widgets',
        memoroFetchImpl: async () => readyResponse(),
      })) },
    });
    assert.equal(missing.ok, false);
    // Local-only code: no session broker in this environment is not a
    // transient failure, and the message must name no material.
    assert.equal(missing.error.code, 'no_session_broker');
    assert.match(missing.error.message, /session-scoped/);

    const hostile = await executeGitHubSessionOperation({
      operation: 'repository.metadata',
      requestId: 'request_abcdefgh',
      env: { [MC_GITHUB_BROKER_SOCKET_ENV]: '/tmp/session.sock' },
      request: async () => ({
        ok: true,
        request_id: 'request_abcdefgh',
        data: { access_token: 'ghs_never_echo' },
      }),
    });
    assert.equal(hostile.ok, false);
    assert.equal(hostile.error.code, 'unavailable');
    assert.equal(JSON.stringify(hostile).includes('ghs_never_echo'), false);
  });

  test('superseded approval responses fail closed as unavailable', async () => {
    const response = await executeGitHubSessionOperation({
      operation: 'repository.metadata',
      requestId: 'request_abcdefgh',
      env: { [MC_GITHUB_BROKER_SOCKET_ENV]: '/tmp/session.sock' },
      request: async () => ({
        ok: false,
        request_id: 'request_abcdefgh',
        error: {
          code: 'approval_required',
          message: 'Approval required.',
          repair_action: 'approve',
          approval_id: 'ghap_abcdefgh',
        },
      }),
    });

    assert.deepEqual(response, {
      ok: false,
      request_id: 'request_abcdefgh',
      error: {
        code: 'unavailable',
        message: 'GitHub is temporarily unavailable through Memoro.',
        repair_action: 'retry',
      },
    });
  });
});
