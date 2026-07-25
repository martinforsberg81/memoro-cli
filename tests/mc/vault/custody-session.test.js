/**
 * Custody-session helpers (docs/plans/mc-custody.md S1): CRK resolution,
 * envelope adoption incl. the set-if-absent race, and schema-dispatching
 * secret writes.
 */
import test, { describe } from 'node:test';
import assert from 'node:assert/strict';

import { importVaultKey, decryptSecretPayload } from '../../../src/mc/vault/client-crypto.js';
import { decryptEnvelopeSecret } from '../../../src/mc/vault/custody-crypto.js';
import { ensureCustodyRoot, encryptForWrite } from '../../../src/mc/vault/custody-session.js';

const PORTAL = { apiUrl: 'https://memoro.test', token: 'tok' };

async function kuk(fill = 7) {
  return importVaultKey(new Uint8Array(32).fill(fill));
}

function apiStub({ wrapped = null, storeOk = true, onStore = null } = {}) {
  const state = { wrapped };
  return {
    state,
    getStatus: async () => ({ ok: true, vault: { setup: true, ...(state.wrapped || {}) } }),
    setCustodyKey: async (_portal, { wrappedCrk, crkIv }) => {
      if (onStore) return onStore({ wrappedCrk, crkIv, state });
      if (!storeOk) return { ok: false, error: 'nope' };
      state.wrapped = { wrapped_crk: wrappedCrk, crk_iv: crkIv };
      return { ok: true };
    },
  };
}

describe('ensureCustodyRoot', () => {
  test('adopts the envelope for a pre-envelope vault, then unwraps on the next call', async () => {
    const key = await kuk();
    const api = apiStub();
    const first = await ensureCustodyRoot({ portal: PORTAL, vaultKey: key, deps: { api } });
    assert.equal(first.ok, true);
    assert.equal(first.adopted, true);
    assert.ok(api.state.wrapped.wrapped_crk, 'wrap stored server-side');

    const second = await ensureCustodyRoot({ portal: PORTAL, vaultKey: key, deps: { api } });
    assert.equal(second.ok, true);
    assert.equal(second.adopted, false, 'existing wrap is unwrapped, not re-minted');
  });

  test('loses the set-if-absent race and unwraps the winner instead', async () => {
    const key = await kuk();
    let winner = null;
    const api = apiStub({
      onStore: async ({ state }) => {
        // Another device stored its CRK first: our POST returns not-ok and
        // the re-read surfaces the winner's wrap.
        if (!winner) {
          const winnerApi = apiStub();
          const res = await ensureCustodyRoot({
            portal: PORTAL, vaultKey: key, deps: { api: winnerApi },
          });
          winner = winnerApi.state.wrapped;
          assert.equal(res.ok, true);
        }
        state.wrapped = winner;
        return { ok: false, error: 'CRK_EXISTS' };
      },
    });
    const res = await ensureCustodyRoot({ portal: PORTAL, vaultKey: key, deps: { api } });
    assert.equal(res.ok, true);
    assert.equal(res.adopted, false, 'race loser adopts the stored winner');
  });

  test('a wrong key for an existing wrap fails closed', async () => {
    const api = apiStub();
    await ensureCustodyRoot({ portal: PORTAL, vaultKey: await kuk(1), deps: { api } });
    const res = await ensureCustodyRoot({ portal: PORTAL, vaultKey: await kuk(2), deps: { api } });
    assert.equal(res.ok, false);
    assert.equal(res.reason, 'crk-unwrap-failed');
  });
});

describe('encryptForWrite', () => {
  test('writes the envelope schema when a CRK is in hand', async () => {
    const key = await kuk();
    const api = apiStub();
    const { crk } = await ensureCustodyRoot({ portal: PORTAL, vaultKey: key, deps: { api } });
    const body = await encryptForWrite({ vaultKey: key, crk, label: 'gh', data: { token: 't1' } });
    assert.equal(body.schemaVersion, 2);
    assert.equal(body.secretClass, 'secret');
    assert.ok(body.wrappedDek && body.dekIv);
    const out = await decryptEnvelopeSecret(crk, {
      encrypted_label: body.encryptedLabel, label_iv: body.labelIv,
      encrypted_data: body.encryptedData, iv: body.iv,
      wrapped_dek: body.wrappedDek, dek_iv: body.dekIv, class: body.secretClass,
    });
    assert.deepEqual(out, { label: 'gh', data: { token: 't1' } });
  });

  test('falls back to the legacy schema without a CRK', async () => {
    const key = await kuk();
    const body = await encryptForWrite({ vaultKey: key, crk: null, label: 'gh', data: { token: 't1' } });
    assert.equal(body.wrappedDek, undefined);
    assert.equal(body.schemaVersion, undefined);
    const out = await decryptSecretPayload(key, {
      encrypted_label: body.encryptedLabel, label_iv: body.labelIv,
      encrypted_data: body.encryptedData, iv: body.iv,
    });
    assert.deepEqual(out, { label: 'gh', data: { token: 't1' } });
  });
});
