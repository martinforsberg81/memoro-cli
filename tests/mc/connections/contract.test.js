import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, test } from 'node:test';
import { globSync } from 'node:fs';

import {
  decodeBrokerGrant,
  decodeConnectionDescriptor,
} from '../../../src/mc/connections/contract.js';

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

  test('only the common identity module imports credential storage', () => {
    const files = globSync('src/mc/connections/*.js');
    for (const file of files.filter((path) => !path.endsWith('/identity.js'))) {
      const source = readFileSync(file, 'utf8');
      assert.doesNotMatch(source, /lib\/keychain|mc\/vault|\/vault\//, file);
    }
    for (const file of [
      'src/mc/commands/github.js',
      'src/mc/github-session.js',
      'src/mc/broker/launch-client.js',
      'src/mc/broker/session-sidecars.js',
    ]) {
      const source = readFileSync(file, 'utf8');
      assert.doesNotMatch(source, /lib\/keychain|mc\/vault|\/vault\/|ACCOUNTS\.TOKEN/, file);
    }
  });
});
