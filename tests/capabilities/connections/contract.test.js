import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, test } from 'node:test';
import { globSync } from 'node:fs';

import {
  decodeBrokerGrant,
  decodeConnectionDescriptor,
} from '../../../src/capabilities/connections/contract.js';

const READY = {
  schema: 1,
  provider: { id: 'fixture', label: 'Fixture', custody: 'control_plane' },
  state: 'ready',
  repair_action: null,
  account: { id: 'acct_1', label: 'Example' },
  resources: [{ id: 'resource_1', label: 'One', selected: true }],
  sources: { local: 'ready', cloud: 'unavailable' },
  capabilities: [{ name: 'thing.read', effect: 'read' }],
};

describe('connected capability codecs', () => {
  test('accepts the shared token-free envelope and rejects secret-shaped extensions', () => {
    assert.deepEqual(decodeConnectionDescriptor(READY, { providerId: 'fixture' }), READY);
    assert.equal(decodeConnectionDescriptor({
      ...READY,
      extension: { access_token: 'secret' },
    }, { providerId: 'fixture' }), null);
    assert.equal(decodeConnectionDescriptor({
      ...READY,
      state: 'provider_custom_state',
    }, { providerId: 'fixture' }), null);
  });

  test('narrows a verified grant without retaining the bootstrap identity', () => {
    const decoded = decodeBrokerGrant({
      ok: true,
      schema: 1,
      grant: `mcg_${'a'.repeat(64)}`,
      expires_at: '2026-07-23T15:00:00.000Z',
      source: { id: 'local:device:one', kind: 'local' },
      provider: 'fixture',
      purpose: 'connection',
      coding_session_id: null,
      capability_families: ['connection.read'],
      resource: null,
    }, { provider: 'fixture', purpose: 'connection' });
    assert.equal(decoded.token, `mcg_${'a'.repeat(64)}`);
    assert.equal(Object.hasOwn(decoded, 'deviceToken'), false);
  });

  test('binds V1 grants to the exact local source and workspace', () => {
    const response = {
      ok: true,
      schema: 1,
      grant: `mcg_${'b'.repeat(64)}`,
      expires_at: '2026-08-03T15:00:00.000Z',
      source: { id: 'machine_test', kind: 'local' },
      provider: 'github',
      purpose: 'session',
      coding_session_id: 'mcs_000000000000000000000001',
      capability_families: ['session.read'],
      resource: {
        type: 'github.workspace:mcw_000000000000000000000001',
        id: '301',
      },
    };
    const expected = {
      provider: 'github',
      purpose: 'session',
      codingSessionId: 'mcs_000000000000000000000001',
      sourceId: 'machine_test',
      workspaceId: 'mcw_000000000000000000000001',
    };
    assert.equal(decodeBrokerGrant(response, expected).resource.id, '301');
    assert.equal(decodeBrokerGrant(response, { ...expected, sourceId: 'machine_other' }), null);
    assert.equal(decodeBrokerGrant(response, {
      ...expected,
      workspaceId: 'mcw_000000000000000000000002',
    }), null);
    assert.equal(decodeBrokerGrant(response, { ...expected, workspaceId: null }), null);
  });

  test('only the common identity module imports credential storage', () => {
    const files = globSync('src/capabilities/connections/*.js');
    for (const file of files.filter((path) => !path.endsWith('/identity.js'))) {
      const source = readFileSync(file, 'utf8');
      assert.doesNotMatch(source, /lib\/keychain|mc\/vault|\/vault\//, file);
    }
    for (const file of [
      'src/cli/github.js',
      'src/capabilities/github/github-session.js',
      'src/runtime/broker/launch-client.js',
      'src/runtime/broker/session-sidecars.js',
    ]) {
      const source = readFileSync(file, 'utf8');
      assert.doesNotMatch(source, /lib\/keychain|mc\/vault|\/vault\/|ACCOUNTS\.TOKEN/, file);
    }
  });
});
