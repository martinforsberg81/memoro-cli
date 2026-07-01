import test, { describe } from 'node:test';
import assert from 'node:assert/strict';

import { ACCOUNTS } from '../../../src/commands/auth.js';
import {
  ensureSupervisorAuth,
  isSupervisorApiPath,
  logoutSupervisor,
  runSupervisorDeviceFlow,
  supervisorFetch,
  SUPERVISOR_AUDIENCE,
  SUPERVISOR_SCOPE,
} from '../../../src/mc/supervisor-auth.js';

function stderrBuffer() {
  let text = '';
  return {
    write(value) { text += value; },
    text: () => text,
  };
}

describe('mc supervisor scoped auth', () => {
  test('uses the supervisor token account, not the primary Memoro auth token account', async () => {
    const reads = [];
    const auth = await ensureSupervisorAuth({
      getSecret: async (account) => {
        reads.push(account);
        assert.notEqual(account, ACCOUNTS.TOKEN);
        if (account === ACCOUNTS.SUPERVISOR_TOKEN) return 'mem_supervisor_token';
        return null;
      },
      runScopedDeviceFlow: async () => {
        throw new Error('device flow should not run when scoped token exists');
      },
      stderr: stderrBuffer(),
    });

    assert.equal(auth.ok, true);
    assert.equal(auth.token, 'mem_supervisor_token');
    assert.equal(auth.account, ACCOUNTS.SUPERVISOR_TOKEN);
    assert.equal(auth.scope, SUPERVISOR_SCOPE);
    assert.equal(auth.audience, SUPERVISOR_AUDIENCE);
    assert.deepEqual(reads, [ACCOUNTS.SUPERVISOR_TOKEN]);
  });

  test('runs scoped device flow when no supervisor token is stored', async () => {
    const err = stderrBuffer();
    const reads = [];
    let flowCalled = false;
    const auth = await ensureSupervisorAuth({
      getSecret: async (account) => {
        reads.push(account);
        assert.equal(account, ACCOUNTS.SUPERVISOR_TOKEN);
        return flowCalled ? 'mem_supervisor_after_flow' : null;
      },
      runScopedDeviceFlow: async () => {
        flowCalled = true;
        return 0;
      },
      stderr: err,
    });

    assert.equal(auth.ok, true);
    assert.equal(auth.token, 'mem_supervisor_after_flow');
    assert.equal(auth.source, 'device-flow');
    assert.equal(auth.audience, SUPERVISOR_AUDIENCE);
    assert.equal(flowCalled, true);
    assert.deepEqual(reads, [ACCOUNTS.SUPERVISOR_TOKEN, ACCOUNTS.SUPERVISOR_TOKEN]);
    assert.match(err.text(), /scoped Memoro authorization/);
  });

  test('allowlists only supervisor API paths for supervisor tokens', async () => {
    assert.equal(isSupervisorApiPath('/api/mc/supervisor'), true);
    assert.equal(isSupervisorApiPath('/api/mc/supervisor/thread'), true);
    assert.equal(isSupervisorApiPath('/api/lens/portrait-coding'), false);
    assert.equal(isSupervisorApiPath('/api/vault/secrets'), false);

    const allowed = await supervisorFetch('http://test', '/api/mc/supervisor/thread', {
      token: 'mem_supervisor_token',
      memoroFetch: async (_apiUrl, path, opts) => ({
        ok: true,
        path,
        token: opts.token,
      }),
    });
    assert.deepEqual(allowed, {
      ok: true,
      path: '/api/mc/supervisor/thread',
      token: 'mem_supervisor_token',
    });

    await assert.rejects(
      () => supervisorFetch('http://test', '/api/lens/portrait-coding', {
        token: 'mem_supervisor_token',
        memoroFetch: async () => {
          throw new Error('must not call fetch');
        },
      }),
      /non-supervisor endpoint/,
    );
  });

  test('runs supervisor device flow against supervisor-specific endpoints with audience', async () => {
    const calls = [];
    const code = await runSupervisorDeviceFlow({
      argv: [],
      stderr: stderrBuffer(),
      runDeviceFlowFn: async (opts) => {
        calls.push(opts);
        return 0;
      },
    });

    assert.equal(code, 0);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].scope, SUPERVISOR_SCOPE);
    assert.equal(calls[0].audience, SUPERVISOR_AUDIENCE);
    assert.equal(calls[0].initPath, '/api/mc/supervisor/device/init');
    assert.equal(calls[0].pollPath, '/api/mc/supervisor/device/poll');
    assert.equal(calls[0].nextMessage, 'Starting mc supervisor.');
  });

  test('logout revokes supervisor token and removes the local secret', async () => {
    const deleted = [];
    const calls = [];
    const out = stderrBuffer();
    const code = await logoutSupervisor({
      argv: [],
      getSecret: async (account) => {
        assert.equal(account, ACCOUNTS.SUPERVISOR_TOKEN);
        return 'mem_supervisor_token';
      },
      deleteSecret: async (account) => {
        deleted.push(account);
      },
      supervisorFetchFn: async (apiUrl, path, opts) => {
        calls.push({ apiUrl, path, opts });
        return { ok: true, revoked: true };
      },
      stdout: out,
      stderr: stderrBuffer(),
    });

    assert.equal(code, 0);
    assert.deepEqual(deleted, [ACCOUNTS.SUPERVISOR_TOKEN]);
    assert.equal(calls[0].path, '/api/mc/supervisor/revoke-current');
    assert.equal(calls[0].opts.method, 'POST');
    assert.match(out.text(), /Supervisor token removed/);
  });
});
