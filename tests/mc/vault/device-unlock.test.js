/** S2 (docs/plans/mc-custody.md): durable per-device unlock entries. */
import test, { describe } from 'node:test';
import assert from 'node:assert/strict';

import { cacheVaultKey, readCachedVaultKey } from '../../../src/mc/vault/key-cache.js';

function memKeychain() {
  const store = new Map();
  return {
    setSecret: async (account, value) => { store.set(account, value); },
    getSecret: async (account) => store.get(account) || null,
    deleteSecret: async (account) => { store.delete(account); },
  };
}

const KEY = new Uint8Array(32).fill(9);

describe('durable device unlock (S2)', () => {
  test('a durable entry survives far beyond the legacy TTL and carries authHash + deviceId', async () => {
    const deps = memKeychain();
    let now = Date.now();
    deps.now = () => now;
    await cacheVaultKey(KEY, {
      authHash: 'ah-b64', durable: true, deviceId: 'dev-1', deps,
    });
    now += 365 * 24 * 60 * 60 * 1000; // one year later
    const read = await readCachedVaultKey({ deps });
    assert.ok(read, 'still present');
    assert.equal(read.durable, true);
    assert.equal(read.authHash, 'ah-b64');
    assert.equal(read.deviceId, 'dev-1');
    assert.equal(read.expiresAt, null);
  });

  test('legacy TTL entries still expire and carry no authHash', async () => {
    const deps = memKeychain();
    let now = Date.now();
    deps.now = () => now;
    await cacheVaultKey(KEY, { deps });
    const fresh = await readCachedVaultKey({ deps });
    assert.equal(fresh.durable, false);
    assert.equal(fresh.authHash, null);
    now += 16 * 60 * 1000;
    assert.equal(await readCachedVaultKey({ deps }), null, 'expired after TTL');
  });
});
