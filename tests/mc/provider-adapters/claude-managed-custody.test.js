import assert from 'node:assert/strict';
import test from 'node:test';

import {
  decryptEnvelopeSecret,
  encryptEnvelopeSecret,
  mintCustodyRoot,
} from '../../../src/mc/vault/custody-crypto.js';
import { importVaultKey } from '../../../src/mc/vault/client-crypto.js';
import {
  loadManagedClaudeCustody,
  persistManagedClaudeCustody,
  rotateManagedClaudeCustody,
} from '../../../src/mc/provider-adapters/claude-managed-custody.js';

const now = 1_800_000_000_000;
const portal = {
  apiUrl: 'https://memoro.test',
  token: 'memoro-test-token',
};

function authData(overrides = {}) {
  return {
    kind: 'tool_auth',
    tool: 'claude-code',
    source: 'keychain',
    body: JSON.stringify({
      claudeAiOauth: {
        accessToken: 'access-old',
        refreshToken: 'refresh-old',
        expiresAt: now + 2 * 60_000,
        scopes: ['user:profile', 'user:inference'],
        ...overrides,
      },
    }),
  };
}

async function fixture({ records = 1 } = {}) {
  const vaultKey = await importVaultKey(new Uint8Array(32).fill(23));
  const custody = await mintCustodyRoot(vaultKey);
  const secrets = [];
  for (let index = 0; index < records; index += 1) {
    const encrypted = await encryptEnvelopeSecret(custody.crk, {
      secretClass: 'tool-auth',
      label: 'tool-auth:claude-code',
      data: authData(),
    });
    secrets.push({
      id: `secret_${index + 1}`,
      ...envelopeToWire(encrypted),
      revision: 1,
      updated_at: '2026-07-29T20:00:00.000Z',
    });
  }
  let leaseToken = null;
  let renewalCalls = 0;
  const api = {
    getStatus: async () => ({
      ok: true,
      vault: {
        setup: true,
        wrapped_crk: custody.wrapped_crk,
        crk_iv: custody.crk_iv,
      },
    }),
    unlockVault: async () => ({ ok: true }),
    listSecrets: async () => ({ ok: true, secrets }),
    acquireSecretRefreshLease: async (_portal, secretId, input) => {
      assert.equal(secretId, 'secret_1');
      if (leaseToken && leaseToken !== input.refreshLeaseToken) {
        const error = new Error('busy');
        error.status = 409;
        error.data = {
          code: 'VAULT_REFRESH_LEASE_CONFLICT',
          leaseExpiresAt: now + 90_000,
        };
        throw error;
      }
      leaseToken = input.refreshLeaseToken;
      return { ok: true, acquired: true, leaseExpiresAt: now + 90_000 };
    },
    renewSecretRefreshLease: async (_portal, secretId, input) => {
      assert.equal(secretId, 'secret_1');
      assert.equal(input.refreshLeaseToken, leaseToken);
      renewalCalls += 1;
      return { ok: true, renewed: true, leaseExpiresAt: now + 90_000 };
    },
    releaseSecretRefreshLease: async (_portal, secretId, input) => {
      assert.equal(secretId, 'secret_1');
      assert.equal(input.refreshLeaseToken, leaseToken);
      leaseToken = null;
      return { ok: true, released: true };
    },
    updateSecret: async (_portal, secretId, body) => {
      const wire = secrets.find((entry) => entry.id === secretId);
      assert.equal(body.expectedRevision, wire.revision);
      assert.equal(body.refreshLeaseToken, leaseToken);
      Object.assign(wire, {
        ...envelopeFromWrite(body),
        revision: wire.revision + 1,
      });
      return {
        ok: true,
        secret: {
          revision: wire.revision,
          updated_at: '2026-07-29T20:01:00.000Z',
        },
      };
    },
  };
  const deps = {
    api,
    readCachedVaultKey: async () => ({
      vaultKey,
      authHash: 'hash',
      deviceId: 'device',
    }),
    now: () => now,
  };
  return {
    api,
    custody,
    deps,
    getRenewalCalls() { return renewalCalls; },
    secrets,
    setLeaseToken(value) { leaseToken = value; },
  };
}

test('managed Claude custody selects exactly one revisioned vault record', async () => {
  const one = await fixture();
  const loaded = await loadManagedClaudeCustody({ portal, deps: one.deps });
  assert.equal(loaded.ok, true);
  assert.equal(loaded.secretId, 'secret_1');
  assert.equal(loaded.revision, 1);
  assert.equal(loaded.grant.refreshToken, 'refresh-old');

  const ambiguous = await fixture({ records: 2 });
  assert.equal((await loadManagedClaudeCustody({
    portal,
    deps: ambiguous.deps,
  })).reason, 'managed-claude-custody-ambiguous');
});

test('managed Claude rotation holds the distributed lease through durable CAS', async () => {
  const state = await fixture();
  const rotated = await rotateManagedClaudeCustody({
    portal,
    deps: {
      ...state.deps,
      fetchImpl: async () => ({
        status: 200,
        async json() {
          return {
            access_token: 'access-new',
            refresh_token: 'refresh-new',
            expires_in: 3_600,
            scope: 'user:profile user:inference',
          };
        },
      }),
    },
  });
  assert.equal(rotated.ok, true);
  assert.equal(rotated.refreshed, true);
  assert.equal(rotated.revision, 2);
  assert.equal(rotated.grant.accessToken, 'access-new');
  assert.equal(state.getRenewalCalls(), 2);

  const opened = await decryptEnvelopeSecret(state.custody.crk, state.secrets[0]);
  const persisted = JSON.parse(opened.data.body).claudeAiOauth;
  assert.equal(persisted.accessToken, 'access-new');
  assert.equal(persisted.refreshToken, 'refresh-new');
});

test('managed Claude custody refuses stale writes before encryption leaves the host', async () => {
  const state = await fixture();
  state.secrets[0].revision = 2;
  const result = await persistManagedClaudeCustody({
    portal,
    secretId: 'secret_1',
    expectedRevision: 1,
    refreshLeaseToken: 'E'.repeat(43),
    grant: JSON.parse(authData().body).claudeAiOauth,
    deps: state.deps,
  });
  assert.equal(result.reason, 'managed-claude-custody-revision-conflict');
  assert.equal(result.conflict, true);
});

test('managed Claude rotation surfaces another refresh owner without using OAuth', async () => {
  const state = await fixture();
  state.setLeaseToken('F'.repeat(43));
  let providerCalls = 0;
  const result = await rotateManagedClaudeCustody({
    portal,
    deps: {
      ...state.deps,
      fetchImpl: async () => {
        providerCalls += 1;
        throw new Error('must not run');
      },
    },
  });
  assert.equal(result.reason, 'managed-claude-refresh-busy');
  assert.equal(result.retryAt, now + 90_000);
  assert.equal(providerCalls, 0);
});

test('managed Claude rotation refuses OAuth after refresh lease renewal is lost', async () => {
  const state = await fixture();
  state.api.renewSecretRefreshLease = async () => {
    const error = new Error('lost');
    error.status = 409;
    error.data = { code: 'VAULT_REFRESH_LEASE_LOST' };
    throw error;
  };
  let providerCalls = 0;
  const result = await rotateManagedClaudeCustody({
    portal,
    deps: {
      ...state.deps,
      fetchImpl: async () => {
        providerCalls += 1;
        throw new Error('must not run');
      },
    },
  });
  assert.equal(result.reason, 'managed-claude-refresh-lease-lost');
  assert.equal(providerCalls, 0);
});

function envelopeToWire(envelope) {
  return {
    encrypted_label: envelope.encryptedLabel,
    label_iv: envelope.labelIv,
    encrypted_data: envelope.encryptedData,
    iv: envelope.iv,
    wrapped_dek: envelope.wrapped_dek,
    dek_iv: envelope.dek_iv,
    class: envelope.class,
    schema_version: envelope.schema_version,
  };
}

function envelopeFromWrite(body) {
  return {
    encrypted_label: body.encryptedLabel,
    label_iv: body.labelIv,
    encrypted_data: body.encryptedData,
    iv: body.iv,
    wrapped_dek: body.wrappedDek,
    dek_iv: body.dekIv,
    class: body.secretClass,
    schema_version: body.schemaVersion,
  };
}
