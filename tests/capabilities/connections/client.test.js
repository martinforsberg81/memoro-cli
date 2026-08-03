import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { createLocalIdentityBroker } from '../../../src/capabilities/connections/identity.js';
import { createConnectionClient } from '../../../src/capabilities/connections/client.js';

const DESCRIPTOR = {
  schema: 1,
  provider: { id: 'control', label: 'Control', custody: 'control_plane' },
  state: 'ready',
  repair_action: null,
  account: null,
  resources: [],
  sources: { local: 'ready', cloud: 'unavailable' },
  capabilities: [{ name: 'thing.read', effect: 'read' }],
};

describe('common identity and connection client', () => {
  test('forwards exact V1 grant coordinates through the common client', async () => {
    const requests = [];
    const client = createConnectionClient({
      identityBroker: {
        withGrant: async (request, use) => {
          requests.push(request);
          return use({ token: 'grant', apiUrl: 'https://memoro.test' });
        },
      },
      providers: [{
        id: 'github',
        label: 'GitHub',
        custody: 'control_plane',
        status: async () => DESCRIPTOR,
      }],
    });
    const result = await client.withGrant('github', {
      purpose: 'session',
      codingSessionId: 'mcs_000000000000000000000001',
      sourceId: 'machine_test',
      workspaceId: 'mcw_000000000000000000000001',
    }, ({ token }) => token);
    assert.equal(result, 'grant');
    assert.deepEqual(requests, [{
      provider: 'github',
      purpose: 'session',
      codingSessionId: 'mcs_000000000000000000000001',
      sourceId: 'machine_test',
      workspaceId: 'mcw_000000000000000000000001',
    }]);
  });

  test('uses the device identity only for exchange and gives providers only the short grant', async () => {
    const calls = [];
    const identity = createLocalIdentityBroker({
      getSecret: async () => 'mem_device_bootstrap',
      readConfig: async () => ({ apiUrl: 'https://memoro.test' }),
      memoroFetch: async (_url, path, options) => {
        calls.push({ path, options });
        return {
          ok: true, schema: 1, grant: `mcg_${'b'.repeat(64)}`,
          expires_at: '2026-07-23T15:00:00.000Z',
          source: { id: 'local:device:one', kind: 'local' },
          provider: 'control', purpose: 'connection', coding_session_id: null,
          capability_families: ['connection.read'], resource: null,
        };
      },
    });
    const seen = [];
    const providers = [{
      id: 'control', label: 'Control', custody: 'control_plane', onboarding: true,
      status: async ({ grant }) => { seen.push(grant); return DESCRIPTOR; },
    }];
    const client = createConnectionClient({
      identityBroker: identity,
      providers,
      memoroFetch: async () => { throw new Error('provider network not expected'); },
    });

    assert.deepEqual(await client.status('control'), DESCRIPTOR);
    assert.deepEqual(seen, [`mcg_${'b'.repeat(64)}`]);
    assert.equal(calls[0].path, '/api/mc/capability-grants');
    assert.equal(calls[0].options.token, 'mem_device_bootstrap');
    assert.equal(JSON.stringify(seen).includes('mem_device_bootstrap'), false);
  });

  test('native runtime providers use the same descriptor without invoking identity', async () => {
    let exchanges = 0;
    const native = {
      ...DESCRIPTOR,
      provider: { id: 'native', label: 'Native', custody: 'native_runtime' },
    };
    const client = createConnectionClient({
      identityBroker: { withGrant: async () => { exchanges += 1; } },
      providers: [{
        id: 'native', label: 'Native', custody: 'native_runtime',
        status: async () => native,
      }],
    });
    assert.deepEqual(await client.status('native'), native);
    assert.equal(exchanges, 0);
  });

  test('normalizes the GitHub control-plane provider into the common vocabulary', async () => {
    const client = createConnectionClient({
      identityBroker: {
        withGrant: async (_request, use) => use({
          token: `mcg_${'c'.repeat(64)}`,
          apiUrl: 'https://memoro.test',
        }),
      },
      memoroFetch: async () => ({
        ok: true,
        github: {
          schema: 1,
          state: 'repo_not_installed',
          repair_action: 'select_repository',
          actor: { type: 'installation', login: 'memoro[bot]' },
          accounts: [{ login: 'renameable-account', type: 'Organization' }],
          repository: null,
          repositories: [{
            id: 301, full_name: 'acme/widgets', owner: 'acme', name: 'widgets',
            private: true, archived: false, account: 'acme',
          }],
          operations: ['pull_request.create'],
        },
      }),
    });
    const result = await client.status('github');
    assert.equal(result.state, 'resource_not_selected');
    assert.equal(result.repair_action, 'select_resource');
    assert.equal(result.account, null);
    assert.deepEqual(result.resources, [{ id: '301', label: 'acme/widgets', selected: false }]);
    // The existing GitHub codec strips operations until a repository is
    // selected; the common registry preserves that fail-closed behavior.
    assert.deepEqual(result.capabilities, []);
  });
});
