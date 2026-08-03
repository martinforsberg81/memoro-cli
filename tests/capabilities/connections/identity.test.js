import assert from 'node:assert/strict';
import test, { describe } from 'node:test';

import { createRefreshingIdentityBroker } from '../../../src/capabilities/connections/identity.js';

const GRANT_REQUEST = { provider: 'github', purpose: 'session', codingSessionId: 'sess_a' };

function validGrantResponse() {
  return {
    ok: true,
    schema: 1,
    grant: `mcg_${'a'.repeat(64)}`,
    provider: 'github',
    purpose: 'session',
    coding_session_id: 'sess_a',
    expires_at: '2026-08-01T12:05:00.000Z',
    source: { id: 'device:laptop', kind: 'local' },
    capability_families: ['github.session'],
  };
}

function authError() {
  return Object.assign(new Error('Memoro 401: token revoked'), { status: 401 });
}

describe('createRefreshingIdentityBroker', () => {
  test('sends and verifies the exact V1 source and workspace grant identity', async () => {
    const calls = [];
    const request = {
      provider: 'github',
      purpose: 'session',
      codingSessionId: 'mcs_000000000000000000000001',
      sourceId: 'machine_test',
      workspaceId: 'mcw_000000000000000000000001',
    };
    const broker = createRefreshingIdentityBroker({
      token: 'launch-token',
      apiUrl: 'https://meetmemoro.test',
      memoroFetch: async (apiUrl, path, options) => {
        calls.push({ apiUrl, path, options });
        return {
          ok: true,
          schema: 1,
          grant: `mcg_${'c'.repeat(64)}`,
          provider: 'github',
          purpose: 'session',
          coding_session_id: request.codingSessionId,
          expires_at: '2026-08-03T12:05:00.000Z',
          source: { id: request.sourceId, kind: 'local' },
          capability_families: ['session.read'],
          resource: {
            type: `github.workspace:${request.workspaceId}`,
            id: '301',
          },
        };
      },
    });

    const result = await broker.withGrant(request, async (grant) => grant.resource.id);

    assert.equal(result, '301');
    assert.equal(calls[0].path, '/api/mc/capability-grants');
    assert.deepEqual(calls[0].options.body, {
      schema: 1,
      provider: 'github',
      purpose: 'session',
      coding_session_id: request.codingSessionId,
      source_id: request.sourceId,
      workspace_id: request.workspaceId,
    });
  });

  test('mints with the bound token and never touches the keychain on success', async () => {
    const mints = [];
    const broker = createRefreshingIdentityBroker({
      token: 'launch-token',
      apiUrl: 'https://meetmemoro.test',
      memoroFetch: async (_apiUrl, _path, { token }) => {
        mints.push(token);
        return validGrantResponse();
      },
      getSecret: async () => assert.fail('keychain must not be read when the bound token works'),
    });

    const result = await broker.withGrant(GRANT_REQUEST, async (grant) => grant.token);

    assert.deepEqual(mints, ['launch-token']);
    assert.equal(result, `mcg_${'a'.repeat(64)}`);
  });

  test('an auth failure re-reads the keychain and re-mints once with the fresh token', async () => {
    const mints = [];
    let uses = 0;
    const broker = createRefreshingIdentityBroker({
      token: 'stale-launch-token',
      apiUrl: 'https://meetmemoro.test',
      memoroFetch: async (_apiUrl, _path, { token }) => {
        mints.push(token);
        if (token === 'stale-launch-token') throw authError();
        return validGrantResponse();
      },
      getSecret: async () => 'fresh-keychain-token',
    });

    const result = await broker.withGrant(GRANT_REQUEST, async (grant) => {
      uses += 1;
      return grant.token;
    });

    assert.deepEqual(mints, ['stale-launch-token', 'fresh-keychain-token']);
    assert.equal(uses, 1);
    assert.equal(result, `mcg_${'a'.repeat(64)}`);
  });

  test('a non-auth mint failure propagates without touching the keychain', async () => {
    const broker = createRefreshingIdentityBroker({
      token: 'launch-token',
      apiUrl: 'https://meetmemoro.test',
      memoroFetch: async () => {
        throw Object.assign(new Error('Memoro 503: down'), { status: 503 });
      },
      getSecret: async () => assert.fail('non-auth failures must not trigger a token refresh'),
    });

    await assert.rejects(
      () => broker.withGrant(GRANT_REQUEST, async () => {}),
      /Memoro 503/,
    );
  });

  test('an unchanged keychain token propagates the original auth failure without a second mint', async () => {
    const mints = [];
    const broker = createRefreshingIdentityBroker({
      token: 'launch-token',
      apiUrl: 'https://meetmemoro.test',
      memoroFetch: async (_apiUrl, _path, { token }) => {
        mints.push(token);
        throw authError();
      },
      getSecret: async () => 'launch-token',
    });

    await assert.rejects(
      () => broker.withGrant(GRANT_REQUEST, async () => {}),
      /Memoro 401/,
    );
    assert.deepEqual(mints, ['launch-token']);
  });

  test('a consumer failure propagates without re-minting or re-running the consumer', async () => {
    const mints = [];
    let uses = 0;
    const broker = createRefreshingIdentityBroker({
      token: 'launch-token',
      apiUrl: 'https://meetmemoro.test',
      memoroFetch: async (_apiUrl, _path, { token }) => {
        mints.push(token);
        return validGrantResponse();
      },
      getSecret: async () => assert.fail('consumer failures must not trigger a token refresh'),
    });

    await assert.rejects(
      () => broker.withGrant(GRANT_REQUEST, async () => {
        uses += 1;
        throw Object.assign(new Error('Memoro 401: grant rejected downstream'), { status: 401 });
      }),
      /grant rejected downstream/,
    );
    assert.deepEqual(mints, ['launch-token']);
    assert.equal(uses, 1);
  });
});
