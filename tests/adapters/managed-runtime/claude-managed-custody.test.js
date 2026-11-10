import assert from 'node:assert/strict';
import test from 'node:test';

import {
  decryptEnvelopeSecret,
  encryptEnvelopeSecret,
  mintCustodyRoot,
} from '../../../src/vault/engine/custody-crypto.js';
import { importVaultKey } from '../../../src/vault/engine/client-crypto.js';
import {
  loadManagedClaudeCustody,
  persistManagedClaudeCustody,
  rotateManagedClaudeCustody,
} from '../../../src/adapters/managed-runtime/claude-managed-custody.js';

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
      row_revision: '0123456789abcdef0123456789abcdef',
      updated_at: '2026-07-29T20:00:00.000Z',
    });
  }
  let leaseToken = null;
  let updateCalls = 0;
  const events = [];
  const renewQueue = [];
  const timers = [];
  const clearedTimers = [];
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
      events.push('acquire');
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
      events.push('renew');
      if (renewQueue.length > 0) return renewQueue.shift();
      return { ok: true, renewed: true, leaseExpiresAt: now + 90_000 };
    },
    releaseSecretRefreshLease: async (_portal, secretId, input) => {
      events.push('release');
      assert.equal(secretId, 'secret_1');
      assert.equal(input.refreshLeaseToken, leaseToken);
      leaseToken = null;
      return { ok: true, released: true };
    },
    updateSecret: async (_portal, secretId, body) => {
      events.push('update');
      updateCalls += 1;
      const wire = secrets.find((entry) => entry.id === secretId);
      assert.equal(body.expectedRevision, wire.row_revision);
      assert.equal(body.refreshLeaseToken, leaseToken);
      const nextRowRevision = 'fedcba9876543210fedcba9876543210';
      Object.assign(wire, {
        ...envelopeFromWrite(body),
        revision: wire.revision + 1,
        row_revision: nextRowRevision,
      });
      return {
        ok: true,
        secret: {
          revision: wire.revision,
          row_revision: nextRowRevision,
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
    // The keeper's interval is recorded, never fired: no background renewal
    // can interleave with the order under test.
    setInterval(callback, intervalMs) {
      const handle = { callback, intervalMs };
      timers.push(handle);
      return handle;
    },
    clearInterval(handle) {
      clearedTimers.push(handle);
    },
  };
  return {
    api,
    custody,
    deps,
    secrets,
    getEvents() { return events; },
    getLeaseToken() { return leaseToken; },
    getUpdateCalls() { return updateCalls; },
    getTimers() { return timers; },
    getClearedTimers() { return clearedTimers; },
    queueRenewal(result) { renewQueue.push(result); },
    setLeaseToken(value) { leaseToken = value; },
  };
}

function oauthResponse() {
  return {
    status: 200,
    async json() {
      return {
        access_token: 'access-new',
        refresh_token: 'refresh-new',
        expires_in: 3_600,
        scope: 'user:profile user:inference',
      };
    },
  };
}

function oauthSuccess(state) {
  return async () => {
    state.getEvents().push('oauth');
    return oauthResponse();
  };
}

test('managed Claude custody selects exactly one revisioned vault record', async () => {
  const one = await fixture();
  const loaded = await loadManagedClaudeCustody({ portal, deps: one.deps });
  assert.equal(loaded.ok, true);
  assert.equal(loaded.secretId, 'secret_1');
  assert.equal(loaded.revision, '0123456789abcdef0123456789abcdef');
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
      fetchImpl: oauthSuccess(state),
    },
  });
  assert.deepEqual(
    state.getEvents(),
    ['acquire', 'renew', 'oauth', 'renew', 'update', 'release'],
  );
  assert.equal(state.getLeaseToken(), null);
  assert.equal(rotated.ok, true);
  assert.equal(rotated.refreshed, true);
  assert.equal(rotated.revision, 'fedcba9876543210fedcba9876543210');
  assert.equal(rotated.grant.accessToken, 'access-new');

  const opened = await decryptEnvelopeSecret(state.custody.crk, state.secrets[0]);
  const persisted = JSON.parse(opened.data.body).claudeAiOauth;
  assert.equal(persisted.accessToken, 'access-new');
  assert.equal(persisted.refreshToken, 'refresh-new');
});

test('managed Claude custody refuses stale writes before encryption leaves the host', async () => {
  const state = await fixture();
  state.secrets[0].row_revision = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
  const ciphertextBefore = state.secrets[0].encrypted_data;
  const result = await persistManagedClaudeCustody({
    portal,
    secretId: 'secret_1',
    expectedRevision: '0123456789abcdef0123456789abcdef',
    refreshLeaseToken: 'E'.repeat(43),
    grant: JSON.parse(authData().body).claudeAiOauth,
    deps: state.deps,
  });
  assert.equal(result.reason, 'managed-claude-custody-revision-conflict');
  assert.equal(result.conflict, true);
  assert.equal(state.getUpdateCalls(), 0);
  assert.equal(state.secrets[0].encrypted_data, ciphertextBefore);
});

test('managed Claude custody surfaces the server row conflict without retry', async () => {
  const state = await fixture();
  const ciphertextBefore = state.secrets[0].encrypted_data;
  let updateCalls = 0;
  state.api.updateSecret = async () => {
    updateCalls += 1;
    const error = new Error('stale row');
    error.status = 409;
    error.data = { code: 'VAULT_SECRET_CONFLICT' };
    throw error;
  };
  const result = await persistManagedClaudeCustody({
    portal,
    secretId: 'secret_1',
    expectedRevision: '0123456789abcdef0123456789abcdef',
    refreshLeaseToken: 'E'.repeat(43),
    grant: JSON.parse(authData().body).claudeAiOauth,
    deps: state.deps,
  });
  assert.equal(result.reason, 'managed-claude-custody-revision-conflict');
  assert.equal(result.conflict, true);
  assert.equal(updateCalls, 1, 'a conflicting write is not retried');
  assert.equal(state.secrets[0].encrypted_data, ciphertextBefore);
});

test('managed Claude custody rejects absent and malformed row tokens before OAuth or write', async (t) => {
  for (const [name, invalid] of [
    ['missing', undefined],
    ['empty', ''],
    ['numeric', 1],
    ['malformed', 'ABCDEF0123456789ABCDEF0123456789'],
  ]) {
    await t.test(name, async () => {
      const state = await fixture();
      if (invalid === undefined) delete state.secrets[0].row_revision;
      else state.secrets[0].row_revision = invalid;
      const ciphertextBefore = state.secrets[0].encrypted_data;
      let providerCalls = 0;
      const result = await rotateManagedClaudeCustody({
        portal,
        deps: {
          ...state.deps,
          fetchImpl: async () => {
            providerCalls += 1;
            throw new Error('OAuth must not run');
          },
        },
      });
      assert.equal(result.reason, 'managed-claude-custody-revision-required');
      assert.equal(providerCalls, 0);
      assert.equal(state.getUpdateCalls(), 0);
      assert.equal(state.secrets[0].encrypted_data, ciphertextBefore);
    });
  }
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

test('managed Claude refresh lease lost before the write refuses the CAS', async () => {
  const state = await fixture();
  state.queueRenewal({ ok: true, renewed: true, leaseExpiresAt: now + 90_000 });
  state.queueRenewal({ ok: false });
  const result = await rotateManagedClaudeCustody({
    portal,
    deps: {
      ...state.deps,
      fetchImpl: oauthSuccess(state),
    },
  });
  assert.equal(result.reason, 'managed-claude-refresh-lease-lost');
  assert.deepEqual(state.getEvents(), ['acquire', 'renew', 'oauth', 'renew', 'release']);
  assert.equal(state.getUpdateCalls(), 0);
  assert.equal(state.getLeaseToken(), null);
});

test('managed Claude refresh lease lost during OAuth aborts the request and writes nothing', async () => {
  const state = await fixture();
  state.queueRenewal({ ok: true, renewed: true, leaseExpiresAt: now + 90_000 });
  state.queueRenewal({ ok: false });
  let fetchSignal = null;
  let releaseFetch = () => {};
  let markFetchStarted = () => {};
  const fetchStarted = new Promise((resolve) => { markFetchStarted = resolve; });
  const pending = rotateManagedClaudeCustody({
    portal,
    deps: {
      ...state.deps,
      // Like real fetch: rejects with AbortError once its signal aborts,
      // otherwise resolves when the test releases it.
      fetchImpl: (_url, init) => {
        state.getEvents().push('oauth');
        fetchSignal = init.signal;
        markFetchStarted();
        return new Promise((resolve, reject) => {
          init.signal.addEventListener('abort', () => {
            reject(new DOMException('The operation was aborted.', 'AbortError'));
          }, { once: true });
          releaseFetch = () => resolve(oauthResponse());
        });
      },
    },
  });
  try {
    await Promise.race([fetchStarted, pending]);
    assert.ok(fetchSignal, 'OAuth started while the lease was held');
    const [keeper] = state.getTimers();
    keeper.callback();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(fetchSignal.aborted, true);
    releaseFetch();
    const result = await pending;
    assert.equal(result.reason, 'managed-claude-refresh-lease-lost');
    assert.deepEqual(state.getEvents(), ['acquire', 'renew', 'oauth', 'renew', 'release']);
    assert.equal(state.getUpdateCalls(), 0);
    assert.equal(state.getLeaseToken(), null);
  } finally {
    releaseFetch();
  }
});

test('managed Claude refresh stops the keeper through the handle it started', async () => {
  const state = await fixture();
  const result = await rotateManagedClaudeCustody({
    portal,
    deps: {
      ...state.deps,
      fetchImpl: oauthSuccess(state),
    },
  });
  assert.equal(result.ok, true);
  const [started] = state.getTimers();
  assert.equal(state.getTimers().length, 1);
  assert.equal(state.getClearedTimers().length, 1);
  assert.equal(state.getClearedTimers()[0], started);
});

test('managed Claude refresh reports an unconfirmed lease release', async () => {
  const state = await fixture();
  state.api.releaseSecretRefreshLease = async (_portal, secretId) => {
    state.getEvents().push('release');
    assert.equal(secretId, 'secret_1');
    return { ok: true, released: false };
  };
  const result = await rotateManagedClaudeCustody({
    portal,
    deps: {
      ...state.deps,
      fetchImpl: oauthSuccess(state),
    },
  });
  assert.deepEqual(state.getEvents(), ['acquire', 'renew', 'oauth', 'renew', 'update', 'release']);
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'managed-claude-refresh-lease-release-unconfirmed');
});

test('managed Claude custody refuses a write whose row revision did not advance', async () => {
  const state = await fixture();
  const updateSecret = state.api.updateSecret;
  state.api.updateSecret = async (...args) => {
    const updated = await updateSecret(...args);
    return {
      ...updated,
      secret: { ...updated.secret, row_revision: '0123456789abcdef0123456789abcdef' },
    };
  };
  state.setLeaseToken('E'.repeat(43));
  const result = await persistManagedClaudeCustody({
    portal,
    secretId: 'secret_1',
    expectedRevision: '0123456789abcdef0123456789abcdef',
    refreshLeaseToken: 'E'.repeat(43),
    grant: JSON.parse(authData().body).claudeAiOauth,
    deps: state.deps,
  });
  assert.equal(result.reason, 'managed-claude-custody-write-unconfirmed');
  assert.deepEqual(state.getEvents(), ['update']);
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
