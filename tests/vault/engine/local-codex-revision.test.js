import assert from 'node:assert/strict';
import test from 'node:test';

import { importVaultKey } from '../../../src/vault/engine/client-crypto.js';
import { encryptEnvelopeSecret, mintCustodyRoot } from '../../../src/vault/engine/custody-crypto.js';
import { persistCustodyCodexAuth } from '../../../src/vault/credential-domain/local-codex.js';

const portal = { apiUrl: 'https://memoro.test', token: 'test-token' };

async function fixture({ conflicts = 1 } = {}) {
  const vaultKey = await importVaultKey(new Uint8Array(32).fill(37));
  const custody = await mintCustodyRoot(vaultKey);
  const encrypted = await encryptEnvelopeSecret(custody.crk, {
    secretClass: 'tool-auth',
    label: 'tool-auth:codex',
    data: {
      kind: 'tool_auth',
      tool: 'codex',
      source: 'keychain',
      body: JSON.stringify({ auth_mode: 'chatgpt', tokens: { access_token: 'old' } }),
    },
  });
  const wire = {
    id: 'codex-auth',
    secret_type: 'api_key',
    encrypted_label: encrypted.encryptedLabel,
    label_iv: encrypted.labelIv,
    encrypted_data: encrypted.encryptedData,
    iv: encrypted.iv,
    wrapped_dek: encrypted.wrapped_dek,
    dek_iv: encrypted.dek_iv,
    class: encrypted.class,
    schema_version: encrypted.schema_version,
    revision: 1,
    row_revision: 1,
  };
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
      if (conflicts > 0) {
        conflicts -= 1;
        wire.revision += 1;
        wire.row_revision = wire.revision;
        const error = new Error('Memoro 409: Vault secret revision is stale');
        error.status = 409;
        error.data = { code: 'VAULT_SECRET_CONFLICT' };
        throw error;
      }
      Object.assign(wire, {
        encrypted_label: body.encryptedLabel,
        label_iv: body.labelIv,
        encrypted_data: body.encryptedData,
        iv: body.iv,
        wrapped_dek: body.wrappedDek,
        dek_iv: body.dekIv,
        revision: wire.revision + 1,
        row_revision: wire.row_revision + 1,
      });
      return { ok: true };
    },
  };
  return {
    api,
    updates,
    get listCalls() { return listCalls; },
    deps: {
      api,
      readCachedVaultKey: async () => ({ vaultKey, authHash: 'hash', deviceId: 'device' }),
    },
  };
}

test('Codex credential refresh re-reads and retries once after a row conflict', async () => {
  const testFixture = await fixture({ conflicts: 1 });
  const result = await persistCustodyCodexAuth({
    portal,
    secretId: 'codex-auth',
    authBody: JSON.stringify({ auth_mode: 'chatgpt', tokens: { access_token: 'fresh' } }),
    deps: testFixture.deps,
  });
  assert.deepEqual(result, { ok: true, persisted: true });
  assert.equal(testFixture.listCalls, 2);
  assert.deepEqual(testFixture.updates.map((body) => body.expectedRevision), [1, 2]);
});

test('Codex credential refresh fails after the second row conflict', async () => {
  const testFixture = await fixture({ conflicts: 2 });
  const result = await persistCustodyCodexAuth({
    portal,
    secretId: 'codex-auth',
    authBody: JSON.stringify({ auth_mode: 'chatgpt', tokens: { access_token: 'fresh' } }),
    deps: testFixture.deps,
  });
  assert.equal(result.ok, false);
  assert.equal(result.persisted, undefined);
  assert.equal(testFixture.listCalls, 2);
  assert.deepEqual(testFixture.updates.map((body) => body.expectedRevision), [1, 2]);
});
