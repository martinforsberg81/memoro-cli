/**
 * readStepCreditKey — the one vault record `mc-api-key`, read with the cached
 * vault key, for runner step sessions on credits (ruling 38).
 */

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import * as StepCreditKey from '../../../src/vault/engine/step-credit-key.js';
import { readStepCreditKey, STEP_CREDIT_KEY_LABEL } from '../../../src/vault/engine/step-credit-key.js';
import { encryptSecretPayload, importVaultKey } from '../../../src/vault/engine/client-crypto.js';
import { encryptEnvelopeSecret, mintCustodyRoot } from '../../../src/vault/engine/custody-crypto.js';
import { buildSecretPayload } from '../../../src/vault/engine/types.js';
import { createMockVaultServer, makeTestPortal } from './_helpers/mock-server.js';

const AUTH_HASH = 'test-auth-hash';
const KEY = 'sk-ant-api03-test-step-credit-key';

let server;
let portal;
let vaultKey;
let vaultKeyBytes;
let custody;

async function setup({ envelope = true } = {}) {
  server = createMockVaultServer();
  vaultKeyBytes = new Uint8Array(32).fill(7);
  vaultKey = await importVaultKey(vaultKeyBytes);
  custody = envelope ? await mintCustodyRoot(vaultKey) : null;
  await server.memoroFetch('x', '/api/vault/setup', { method: 'POST', body: { authHash: AUTH_HASH } });
  await server.memoroFetch('x', '/api/vault/unlock', { method: 'POST', body: { authHash: AUTH_HASH } });
  const base = makeTestPortal(server);
  // The mock's status carries no custody root; the real server does.
  portal = {
    ...base,
    memoroFetch: async (apiUrl, path, opts = {}) => {
      const res = await server.memoroFetch(apiUrl, path, opts);
      if (path === '/api/vault/status' && custody) {
        return { ...res, vault: { ...res.vault, wrapped_crk: custody.wrapped_crk, crk_iv: custody.crk_iv } };
      }
      return res;
    },
  };
}

function cacheStub() {
  return async () => ({ vaultKey, vaultKeyBytes: new Uint8Array(vaultKeyBytes), authHash: AUTH_HASH, deviceId: null });
}

async function addLegacy(label, data) {
  const enc = await encryptSecretPayload(vaultKey, label, data);
  await server.memoroFetch('x', '/api/vault/secrets', { method: 'POST', body: { secretType: 'token', ...enc } });
}

async function addEnvelope(label, data, secretClass = 'secret') {
  const env = await encryptEnvelopeSecret(custody.crk, { secretClass, label, data });
  await server.memoroFetch('x', '/api/vault/secrets', {
    method: 'POST',
    body: {
      secretType: 'token',
      encryptedLabel: env.encryptedLabel,
      labelIv: env.labelIv,
      encryptedData: env.encryptedData,
      iv: env.iv,
      wrappedDek: env.wrapped_dek,
      dekIv: env.dek_iv,
      secretClass: env.class,
      schemaVersion: env.schema_version,
    },
  });
}

function read() {
  return readStepCreditKey({ deps: { readCachedVaultKey: cacheStub(), portal } });
}

const apiToken = (token = KEY) => buildSecretPayload({ kind: 'api_token', token, provider: 'anthropic' });

describe('readStepCreditKey', () => {
  beforeEach(() => setup());

  it('the label is the constant mc-api-key', () => {
    assert.equal(STEP_CREDIT_KEY_LABEL, 'mc-api-key');
  });

  it('finds the key in an envelope row', async () => {
    await addEnvelope('other', apiToken('sk-other'));
    await addEnvelope(STEP_CREDIT_KEY_LABEL, apiToken());
    assert.deepEqual(await read(), { ok: true, key: KEY });
  });

  it('finds the key in a legacy row', async () => {
    await addLegacy('other', apiToken('sk-other'));
    await addLegacy(STEP_CREDIT_KEY_LABEL, apiToken());
    assert.deepEqual(await read(), { ok: true, key: KEY });
  });

  it('finds a legacy row when the vault has no custody root', async () => {
    await setup({ envelope: false });
    await addLegacy(STEP_CREDIT_KEY_LABEL, apiToken());
    assert.deepEqual(await read(), { ok: true, key: KEY });
  });

  it('ignores an envelope row of another class with the same label', async () => {
    await addEnvelope(STEP_CREDIT_KEY_LABEL, apiToken(), 'tool-auth');
    assert.deepEqual(await read(), { ok: false, reason: 'no-key' });
  });

  it('no record is no-key', async () => {
    await addLegacy('other', apiToken('sk-other'));
    assert.deepEqual(await read(), { ok: false, reason: 'no-key' });
  });

  it('two records, envelope and legacy, is key-ambiguous', async () => {
    await addLegacy(STEP_CREDIT_KEY_LABEL, apiToken());
    await addEnvelope(STEP_CREDIT_KEY_LABEL, apiToken());
    assert.deepEqual(await read(), { ok: false, reason: 'key-ambiguous' });
  });

  it('no cached vault key is vault-locked, before any request', async () => {
    const r = await readStepCreditKey({ deps: { readCachedVaultKey: async () => null, portal } });
    assert.deepEqual(r, { ok: false, reason: 'vault-locked' });
    assert.equal(server.calls.filter((c) => c.path !== '/api/vault/setup' && c.path !== '/api/vault/unlock').length, 0);
  });

  it('a refused unlock is vault-refused', async () => {
    const r = await readStepCreditKey({
      deps: { readCachedVaultKey: async () => ({ vaultKey, vaultKeyBytes, authHash: 'wrong' }), portal },
    });
    assert.deepEqual(r, { ok: false, reason: 'vault-refused' });
  });

  it('an oauth_token payload is key-unreadable', async () => {
    await addEnvelope(STEP_CREDIT_KEY_LABEL, buildSecretPayload({ kind: 'oauth_token', token: KEY }));
    const r = await read();
    assert.deepEqual(r, { ok: false, reason: 'key-unreadable' });
  });

  it('a token with whitespace is key-unreadable and not echoed', async () => {
    await addLegacy(STEP_CREDIT_KEY_LABEL, apiToken(`${KEY}\n`));
    const r = await read();
    assert.deepEqual(r, { ok: false, reason: 'key-unreadable' });
    assert.ok(!JSON.stringify(r).includes(KEY));
  });

  it('zeroes the cached vault key bytes', async () => {
    await addLegacy(STEP_CREDIT_KEY_LABEL, apiToken());
    const bytes = new Uint8Array(vaultKeyBytes);
    await readStepCreditKey({ deps: { readCachedVaultKey: async () => ({ vaultKey, vaultKeyBytes: bytes, authHash: AUTH_HASH }), portal } });
    assert.ok(bytes.every((b) => b === 0));
  });

  it('a throwing api returns, never throws', async () => {
    const boom = async () => { throw new Error(KEY); };
    const r = await readStepCreditKey({
      deps: { readCachedVaultKey: cacheStub(), portal, api: { unlockVault: boom, getStatus: boom, listSecrets: boom } },
    });
    assert.equal(r.ok, false);
    assert.ok(!JSON.stringify(r).includes(KEY));
  });

  it('no failure reason carries the key', async () => {
    await addLegacy(STEP_CREDIT_KEY_LABEL, apiToken());
    await addEnvelope(STEP_CREDIT_KEY_LABEL, apiToken());
    const r = await read();
    assert.equal(r.ok, false);
    assert.ok(!r.reason.includes(KEY));
  });
});

describe('readStepCreditKey takes no label', () => {
  it('its only parameter is the options object, and no export takes a label', () => {
    assert.equal(readStepCreditKey.length, 0);
    assert.deepEqual(Object.keys(StepCreditKey).sort(), ['STEP_CREDIT_KEY_LABEL', 'readStepCreditKey']);
  });

  it('deps accepts only the test seams', () => {
    const src = readFileSync(new URL('../../../src/vault/engine/step-credit-key.js', import.meta.url), 'utf8');
    const used = [...new Set([...src.matchAll(/deps\.(\w+)/g)].map((m) => m[1]))].sort();
    assert.deepEqual(used, ['api', 'portal', 'readCachedVaultKey']);
  });
});
