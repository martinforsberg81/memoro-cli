import assert from 'node:assert/strict';
import test from 'node:test';

import { importVaultKey } from '../../../src/vault/engine/client-crypto.js';
import { decryptEnvelopeSecret, encryptEnvelopeSecret, mintCustodyRoot } from '../../../src/vault/engine/custody-crypto.js';
import { persistCustodyCodexAuth } from '../../../src/vault/credential-domain/local-codex.js';

const portal = { apiUrl: 'https://memoro.test', token: 'test-token' };
const initialRevision = '0123456789abcdef0123456789abcdef';
const winnerRevision = 'abcdef0123456789abcdef0123456789';
const authBody = (token) => JSON.stringify({ auth_mode: 'chatgpt', tokens: { access_token: token } });

async function fixture({ conflict = false } = {}) {
  const vaultKey = await importVaultKey(new Uint8Array(32).fill(37));
  const custody = await mintCustodyRoot(vaultKey);
  const encrypt = (token) => encryptEnvelopeSecret(custody.crk, {
    secretClass: 'tool-auth',
    label: 'tool-auth:codex',
    data: { kind: 'tool_auth', tool: 'codex', source: 'keychain', body: authBody(token) },
  });
  const toWire = (encrypted) => ({
    encrypted_label: encrypted.encryptedLabel,
    label_iv: encrypted.labelIv,
    encrypted_data: encrypted.encryptedData,
    iv: encrypted.iv,
    wrapped_dek: encrypted.wrapped_dek ?? encrypted.wrappedDek,
    dek_iv: encrypted.dek_iv ?? encrypted.dekIv,
    class: encrypted.class ?? encrypted.secretClass,
    schema_version: encrypted.schema_version ?? encrypted.schemaVersion,
  });
  const wire = {
    id: 'codex-auth', secret_type: 'api_key',
    ...toWire(await encrypt('old')),
    revision: 7, row_revision: initialRevision,
  };
  const winner = { ...wire, ...toWire(await encrypt('winner')), row_revision: winnerRevision };
  let listCalls = 0;
  const updates = [];
  const api = {
    getStatus: async () => ({
      ok: true,
      vault: { wrapped_crk: custody.wrapped_crk, crk_iv: custody.crk_iv },
    }),
    unlockVault: async () => ({ ok: true }),
    listSecrets: async () => {
      listCalls += 1;
      return { ok: true, secrets: [{ ...wire }] };
    },
    updateSecret: async (_portal, id, body) => {
      assert.equal(id, wire.id);
      updates.push(body);
      if (conflict) {
        conflict = false;
        Object.assign(wire, winner);
        const error = new Error('Memoro 409: Vault secret revision is stale');
        error.status = 409;
        error.data = { code: 'VAULT_SECRET_CONFLICT' };
        throw error;
      }
      Object.assign(wire, toWire(body), { row_revision: winnerRevision });
      return { ok: true };
    },
  };
  return {
    wire, winner, updates,
    get listCalls() { return listCalls; },
    read: () => decryptEnvelopeSecret(custody.crk, wire),
    deps: {
      api,
      readCachedVaultKey: async () => ({ vaultKey, authHash: 'hash', deviceId: 'device' }),
    },
  };
}

const persist = (testFixture) => persistCustodyCodexAuth({
  portal, secretId: 'codex-auth', authBody: authBody('fresh'), deps: testFixture.deps,
});

test('Codex credential refresh sends the opaque row token, not numeric wire revision', async () => {
  const f = await fixture();
  assert.deepEqual(await persist(f), { ok: true, persisted: true });
  assert.equal(f.listCalls, 1);
  assert.deepEqual(f.updates.map((body) => body.expectedRevision), [initialRevision]);
  assert.equal((await f.read()).data.body, authBody('fresh'));
});

test('Codex credential refresh refuses a stale write without retry or changing winner ciphertext', async () => {
  const f = await fixture({ conflict: true });
  const result = await persist(f);
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'managed-domain-custody-revision-conflict');
  assert.equal(result.persisted, undefined);
  assert.equal(f.listCalls, 1);
  assert.deepEqual(f.updates.map((body) => body.expectedRevision), [initialRevision]);
  assert.deepEqual(f.wire, f.winner);
  assert.equal((await f.read()).data.body, authBody('winner'));
});

test('Codex credential refresh refuses missing, empty, numeric and malformed row tokens without writes', async () => {
  for (const revision of [undefined, '', 7, 'bad', 'A'.repeat(32)]) {
    const f = await fixture();
    if (revision === undefined) delete f.wire.row_revision;
    else f.wire.row_revision = revision;
    const before = structuredClone(f.wire);
    const result = await persist(f);
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'managed-domain-custody-revision-required');
    assert.equal(f.listCalls, 1);
    assert.deepEqual(f.updates, []);
    assert.deepEqual(f.wire, before);
  }
});
