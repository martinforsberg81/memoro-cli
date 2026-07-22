import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import test, { afterEach, describe } from 'node:test';

import {
  GITHUB_CREDENTIAL_ENV_NAMES,
  MC_GITHUB_BROKER_SOCKET_ENV,
  MC_SESSION_CAPABILITIES_ENV,
  executeGitHubSessionOperation,
  fetchGitHubSessionCapabilities,
  prepareGitHubSessionForLaunch,
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
      approval_mode: 'prompt',
    },
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
      apiUrl: 'https://memoro.test',
      token: 'memoro-secret-sentinel',
      repository: 'acme/widgets',
      sourceKind: 'local',
      memoroFetchImpl: fetch,
    });
    const cloud = await fetchGitHubSessionCapabilities({
      apiUrl: 'https://memoro.test',
      token: 'memoro-secret-sentinel',
      repository: 'acme/widgets',
      sourceKind: 'cloud',
      memoroFetchImpl: fetch,
    });

    assert.equal(JSON.stringify(local), JSON.stringify(cloud));
    assert.equal(JSON.stringify(local).includes('memoro-secret-sentinel'), false);
    assert.equal(JSON.stringify(local).includes('source_kind'), false);
    assert.equal(JSON.stringify(local).includes('coding_session_id'), false);
    assert.equal(calls[0].path, '/api/mc/github/status?repository=acme%2Fwidgets');
    assert.equal(calls[0].options.token, 'memoro-secret-sentinel');
  });

  test('installs a session-only shim while scrubbing every inherited GitHub credential', async () => {
    tmp = mkdtempSync(join(tmpdir(), 'mc-github-session-'));
    const secrets = Object.fromEntries(
      GITHUB_CREDENTIAL_ENV_NAMES.map((name) => [name, `secret-${name}`]),
    );
    const result = await prepareGitHubSessionForLaunch({
      baseEnv: { PATH: '/usr/bin:/bin', KEEP: 'yes', ...secrets },
      capabilities: await fetchGitHubSessionCapabilities({
        apiUrl: 'https://memoro.test',
        token: 'memoro-secret-sentinel',
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
      options: { socketPath: '/tmp/session.sock' },
    }]);
    assert.equal('repository' in calls[0].message, false);
    assert.equal('source_id' in calls[0].message, false);
    assert.equal('coding_session_id' in calls[0].message, false);
  });

  test('missing broker and hostile broker responses fail closed without echoing material', async () => {
    const missing = await executeGitHubSessionOperation({
      operation: 'repository.metadata',
      requestId: 'request_abcdefgh',
      env: { [MC_SESSION_CAPABILITIES_ENV]: JSON.stringify(await fetchGitHubSessionCapabilities({
        apiUrl: 'https://memoro.test',
        token: 'memoro-secret-sentinel',
        repository: 'acme/widgets',
        memoroFetchImpl: async () => readyResponse(),
      })) },
    });
    assert.equal(missing.ok, false);
    assert.equal(missing.error.code, 'unavailable');

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
});
