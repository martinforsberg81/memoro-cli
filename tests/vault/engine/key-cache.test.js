/**
 * Pure-helper tests for src/mc/vault/key-cache.js (§12f).
 *
 * Injects an in-memory `deps` object so we never touch the real OS
 * keychain. Verifies:
 *   - round-trip cache: write → read returns the same key bytes
 *   - expiry: read past the TTL returns null and clears the entry
 *   - tampered JSON / wrong length: returns null, doesn't throw
 *   - inspect-only path doesn't import the key
 *   - clear() is idempotent
 *   - cacheAccountFor identity suffix shape
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  cacheVaultKey,
  readCachedVaultKey,
  clearCachedVaultKey,
  inspectCachedVaultKey,
  cacheAccountFor,
  VAULT_CACHE_ACCOUNT,
  TTL_MS,
} from '../../../src/vault/engine/key-cache.js';

function makeMemDeps({ initialNow = 1_000_000 } = {}) {
  const store = new Map();
  let now = initialNow;
  const deps = {
    async getSecret(account) { return store.has(account) ? store.get(account) : null; },
    async setSecret(account, value) { store.set(account, value); return 'mock'; },
    async deleteSecret(account) { store.delete(account); return 'mock'; },
    now: () => now,
  };
  return {
    deps,
    inspectStore: () => new Map(store),
    advance: (ms) => { now += ms; },
    setNow: (v) => { now = v; },
  };
}

function makeKeyBytes(seed = 1) {
  const out = new Uint8Array(32);
  for (let i = 0; i < 32; i++) out[i] = (seed * 31 + i * 7) & 0xff;
  return out;
}

describe('cacheAccountFor', () => {
  it('returns the constant when identity is null/undefined', () => {
    assert.equal(cacheAccountFor(), VAULT_CACHE_ACCOUNT);
    assert.equal(cacheAccountFor(null), VAULT_CACHE_ACCOUNT);
    assert.equal(cacheAccountFor(''), VAULT_CACHE_ACCOUNT);
  });

  it('appends identity when given', () => {
    assert.equal(cacheAccountFor('usr_42'), `${VAULT_CACHE_ACCOUNT}:usr_42`);
  });
});

describe('cacheVaultKey + readCachedVaultKey round-trip', () => {
  it('cached bytes come back equal after read', async () => {
    const { deps } = makeMemDeps();
    const bytes = makeKeyBytes(7);
    const ok = await cacheVaultKey(bytes, { deps });
    assert.equal(ok, true);
    const got = await readCachedVaultKey({ deps });
    assert.ok(got, 'should hit cache');
    assert.equal(got.vaultKeyBytes.length, 32);
    for (let i = 0; i < 32; i++) {
      assert.equal(got.vaultKeyBytes[i], bytes[i], `byte ${i} mismatch`);
    }
    // Imported CryptoKey should be present.
    assert.ok(got.vaultKey, 'CryptoKey must be returned');
  });

  it('rejects bytes that are not a 32-byte Uint8Array', async () => {
    const { deps } = makeMemDeps();
    await assert.rejects(() => cacheVaultKey(new Uint8Array(16), { deps }),
      /32-byte/);
    await assert.rejects(() => cacheVaultKey('not-bytes', { deps }),
      /32-byte/);
  });

  it('soft-degrades on keychain write failure', async () => {
    const failingDeps = {
      async setSecret() { throw new Error('keychain busy'); },
      async getSecret() { return null; },
      async deleteSecret() { /* noop */ },
      now: () => 1_000_000,
    };
    const ok = await cacheVaultKey(makeKeyBytes(), { deps: failingDeps });
    assert.equal(ok, false, 'should report failure but not throw');
  });
});

describe('expiry', () => {
  it('returns null and clears when past expiresAt', async () => {
    const { deps, advance, inspectStore } = makeMemDeps();
    await cacheVaultKey(makeKeyBytes(3), { ttlMs: 1000, deps });
    assert.equal(inspectStore().size, 1, 'cache populated');
    advance(2000);
    const got = await readCachedVaultKey({ deps });
    assert.equal(got, null, 'expired entry must return null');
    assert.equal(inspectStore().size, 0, 'expired entry must be cleared');
  });

  it('returns the key when read just before expiry', async () => {
    const { deps, advance } = makeMemDeps();
    await cacheVaultKey(makeKeyBytes(4), { ttlMs: 1000, deps });
    advance(500);
    const got = await readCachedVaultKey({ deps });
    assert.ok(got, 'should be a hit just before expiry');
  });
});

describe('malformed entry handling', () => {
  it('non-JSON returns null, doesn\'t throw', async () => {
    const store = new Map();
    store.set(VAULT_CACHE_ACCOUNT, 'not-json{{{');
    const deps = {
      async getSecret(a) { return store.get(a) ?? null; },
      async setSecret() { /* noop */ },
      async deleteSecret(a) { store.delete(a); },
      now: () => 1_000_000,
    };
    const got = await readCachedVaultKey({ deps });
    assert.equal(got, null);
  });

  it('missing fields returns null', async () => {
    const store = new Map();
    store.set(VAULT_CACHE_ACCOUNT, JSON.stringify({ vaultKeyB64: 'AAA' })); // no expiresAt
    const deps = {
      async getSecret(a) { return store.get(a) ?? null; },
      async setSecret() {},
      async deleteSecret(a) { store.delete(a); },
      now: () => 1_000_000,
    };
    assert.equal(await readCachedVaultKey({ deps }), null);
  });

  it('wrong key length returns null', async () => {
    const store = new Map();
    // 16-byte base64 won't import as AES-256.
    const sixteen = btoa(String.fromCharCode(...new Uint8Array(16)));
    store.set(VAULT_CACHE_ACCOUNT, JSON.stringify({
      vaultKeyB64: sixteen,
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    }));
    const deps = {
      async getSecret(a) { return store.get(a) ?? null; },
      async setSecret() {},
      async deleteSecret(a) { store.delete(a); },
      now: () => Date.now(),
    };
    assert.equal(await readCachedVaultKey({ deps }), null);
  });
});

describe('inspectCachedVaultKey', () => {
  it('reports present + expiresInMs without importing the key', async () => {
    const { deps, advance } = makeMemDeps();
    await cacheVaultKey(makeKeyBytes(8), { ttlMs: TTL_MS, deps });
    const info = await inspectCachedVaultKey({ deps });
    assert.equal(info.present, true);
    assert.ok(info.expiresAt, 'expiresAt populated');
    assert.ok(info.expiresInMs > 0);
    advance(TTL_MS + 1000);
    const info2 = await inspectCachedVaultKey({ deps });
    assert.equal(info2.present, false);
  });

  it('reports absent when no entry', async () => {
    const { deps } = makeMemDeps();
    const info = await inspectCachedVaultKey({ deps });
    assert.equal(info.present, false);
    assert.equal(info.expiresInMs, 0);
  });

  it('does not report TTL-only entries as present', async () => {
    const store = new Map();
    store.set(VAULT_CACHE_ACCOUNT, JSON.stringify({
      expiresAt: new Date(1_000_000 + TTL_MS).toISOString(),
    }));
    const deps = {
      async getSecret(a) { return store.get(a) ?? null; },
      async setSecret() {},
      async deleteSecret(a) { store.delete(a); },
      now: () => 1_000_000,
    };
    const info = await inspectCachedVaultKey({ deps });
    assert.equal(info.present, false);
    assert.equal(info.reason, 'missing-vault-key');
  });

  it('does not report wrong-length key entries as present', async () => {
    const store = new Map();
    const sixteen = btoa(String.fromCharCode(...new Uint8Array(16)));
    store.set(VAULT_CACHE_ACCOUNT, JSON.stringify({
      vaultKeyB64: sixteen,
      expiresAt: new Date(1_000_000 + TTL_MS).toISOString(),
    }));
    const deps = {
      async getSecret(a) { return store.get(a) ?? null; },
      async setSecret() {},
      async deleteSecret(a) { store.delete(a); },
      now: () => 1_000_000,
    };
    const info = await inspectCachedVaultKey({ deps });
    assert.equal(info.present, false);
    assert.equal(info.reason, 'invalid-vault-key');
  });
});

describe('clearCachedVaultKey', () => {
  it('is idempotent', async () => {
    const { deps } = makeMemDeps();
    await clearCachedVaultKey({ deps }); // missing
    await cacheVaultKey(makeKeyBytes(), { deps });
    await clearCachedVaultKey({ deps });
    await clearCachedVaultKey({ deps }); // again
    assert.equal(await readCachedVaultKey({ deps }), null);
  });
});
