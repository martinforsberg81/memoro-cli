/**
 * Trusted vault custody for the managed Claude adapter.
 *
 * Access and refresh tokens returned here are consumed only by the trusted
 * runtime wrapper. This module must never be imported into broker wire,
 * provider hook, or executor code.
 */
import { randomBytes } from 'node:crypto';

import {
  decryptEnvelopeLabel,
  decryptEnvelopeSecret,
  isEnvelopeSecret,
  unwrapCustodyRoot,
} from '../vault/custody-crypto.js';
import { encryptForWrite } from '../vault/custody-session.js';
import { readCachedVaultKey } from '../vault/key-cache.js';
import * as VaultApi from '../vault/api.js';
import { WIRE_SECRET_TYPE } from '../vault/types.js';
import { resolveTrustedVaultPortal } from '../vault/trusted-portal.js';
import {
  managedClaudeRefreshDelay,
  parseManagedClaudeToolAuth,
  refreshManagedClaudeOauthGrant,
  replaceManagedClaudeToolAuthGrant,
} from './claude-managed-refresh.js';

export const MANAGED_CLAUDE_TOOL_AUTH_LABEL = 'tool-auth:claude-code';
const REFRESH_LEASE_RENEW_INTERVAL_MS = 20_000;

export async function inspectManagedClaudeCustody(options = {}) {
  const loaded = await loadManagedClaudeCustody(options);
  return loaded.ok
    ? {
        ok: true,
        secretId: loaded.secretId,
        revision: loaded.revision,
      }
    : loaded;
}

export async function loadManagedClaudeCustody({
  portal,
  deps = {},
} = {}) {
  const opened = await openVault({ portal, deps });
  if (!opened.ok) return opened;
  try {
    const matches = [];
    for (const wire of opened.secrets) {
      if (!isEnvelopeSecret(wire) || wire.class !== 'tool-auth') continue;
      let label;
      try { label = await decryptEnvelopeLabel(opened.crk, wire); } catch { continue; }
      if (label === MANAGED_CLAUDE_TOOL_AUTH_LABEL) matches.push(wire);
    }
    if (matches.length !== 1) {
      return failure(matches.length > 1
        ? 'managed-claude-custody-ambiguous'
        : 'managed-claude-custody-missing');
    }
    const wire = matches[0];
    if (!Number.isSafeInteger(wire.revision) || wire.revision < 1) {
      return failure('managed-claude-custody-revision-required');
    }
    let secret;
    try { secret = await decryptEnvelopeSecret(opened.crk, wire); } catch {
      return failure('managed-claude-custody-invalid');
    }
    if (secret.label !== MANAGED_CLAUDE_TOOL_AUTH_LABEL) {
      return failure('managed-claude-custody-invalid');
    }
    const parsed = parseManagedClaudeToolAuth(secret.data);
    if (!parsed.ok) return parsed;
    return {
      ok: true,
      secretId: wire.id,
      revision: wire.revision,
      updatedAt: typeof wire.updated_at === 'string' ? wire.updated_at : null,
      data: structuredClone(secret.data),
      grant: parsed.grant,
      portal: opened.portal,
    };
  } finally {
    opened.cache?.vaultKeyBytes?.fill?.(0);
  }
}

export async function persistManagedClaudeCustody({
  portal,
  secretId,
  expectedRevision,
  refreshLeaseToken,
  grant,
  deps = {},
} = {}) {
  if (typeof secretId !== 'string'
    || !secretId
    || !Number.isSafeInteger(expectedRevision)
    || expectedRevision < 1
    || !/^[A-Za-z0-9_-]{43}$/u.test(refreshLeaseToken || '')) {
    return failure('managed-claude-custody-write-invalid');
  }
  const opened = await openVault({ portal, deps });
  if (!opened.ok) return opened;
  try {
    const wire = opened.secrets.find((entry) => entry?.id === secretId);
    if (!wire
      || !isEnvelopeSecret(wire)
      || wire.class !== 'tool-auth'
      || wire.revision !== expectedRevision) {
      return wire?.revision !== expectedRevision
        ? failure('managed-claude-custody-revision-conflict', { conflict: true })
        : failure('managed-claude-custody-record-mismatch');
    }
    let current;
    try { current = await decryptEnvelopeSecret(opened.crk, wire); } catch {
      return failure('managed-claude-custody-record-mismatch');
    }
    if (current.label !== MANAGED_CLAUDE_TOOL_AUTH_LABEL) {
      return failure('managed-claude-custody-record-mismatch');
    }
    const nextData = replaceManagedClaudeToolAuthGrant(current.data, grant);
    if (!nextData) return failure('managed-claude-custody-write-invalid');
    const encrypted = await encryptForWrite({
      vaultKey: opened.cache.vaultKey,
      crk: opened.crk,
      label: current.label,
      data: nextData,
      secretClass: 'tool-auth',
    });
    let updated;
    try {
      updated = await opened.api.updateSecret(opened.portal, secretId, {
        secretType: WIRE_SECRET_TYPE,
        ...encrypted,
        expectedRevision,
        refreshLeaseToken,
      });
    } catch (error) {
      if (error?.status === 409
        && error?.data?.code === 'VAULT_SECRET_REVISION_CONFLICT') {
        return failure('managed-claude-custody-revision-conflict', { conflict: true });
      }
      if (error?.status === 409
        && ['VAULT_REFRESH_LEASE_CONFLICT', 'VAULT_REFRESH_LEASE_LOST']
          .includes(error?.data?.code)) {
        return failure('managed-claude-refresh-lease-lost');
      }
      return failure('managed-claude-custody-write-failed');
    }
    return updated?.ok
      && updated.secret?.revision === expectedRevision + 1
      ? {
          ok: true,
          revision: updated.secret.revision,
          data: nextData,
          grant: Object.freeze(structuredClone(grant)),
        }
      : failure('managed-claude-custody-write-unconfirmed');
  } finally {
    opened.cache?.vaultKeyBytes?.fill?.(0);
  }
}

export async function rotateManagedClaudeCustody({
  portal,
  deps = {},
} = {}) {
  let current = await loadManagedClaudeCustody({ portal, deps });
  if (!current.ok) return current;
  const refreshLeaseToken = randomBytes(32).toString('base64url');
  const api = deps.api || VaultApi;
  let acquired;
  try {
    acquired = await api.acquireSecretRefreshLease(
      current.portal,
      current.secretId,
      { refreshLeaseToken },
    );
  } catch (error) {
    if (error?.status === 409
      && error?.data?.code === 'VAULT_REFRESH_LEASE_CONFLICT') {
      return failure('managed-claude-refresh-busy', {
        retryAt: Number.isSafeInteger(error.data.leaseExpiresAt)
          ? error.data.leaseExpiresAt
          : null,
      });
    }
    return failure('managed-claude-refresh-lease-unavailable');
  }
  if (!acquired?.ok || acquired.acquired !== true) {
    return failure('managed-claude-refresh-lease-unavailable');
  }

  const leasedPortal = current.portal;
  const leasedSecretId = current.secretId;
  const lease = startRefreshLeaseKeeper({
    api,
    portal: leasedPortal,
    secretId: leasedSecretId,
    refreshLeaseToken,
    deps,
  });
  let result = null;
  let releaseConfirmed = false;
  try {
    // Reload after acquiring the distributed lease. Another device may have
    // completed a rotation between our first read and the lease acquisition.
    current = await loadManagedClaudeCustody({
      portal: current.portal,
      deps,
    });
    if (!current.ok) {
      result = current;
      return result;
    }
    const delay = managedClaudeRefreshDelay(current.grant, {
      now: (deps.now || Date.now)(),
    });
    if (delay === null) {
      result = failure('managed-claude-refresh-schedule-invalid');
      return result;
    }
    if (delay > 0) {
      result = {
        ok: true,
        refreshed: false,
        revision: current.revision,
        grant: current.grant,
        nextRefreshInMs: delay,
      };
      return result;
    }
    if (!await lease.renew()) {
      result = failure('managed-claude-refresh-lease-lost');
      return result;
    }
    const refreshSignal = deps.signal
      ? AbortSignal.any([deps.signal, lease.signal])
      : lease.signal;
    const refreshed = await refreshManagedClaudeOauthGrant(current.grant, {
      fetchImpl: deps.fetchImpl || globalThis.fetch,
      now: deps.now || Date.now,
      signal: refreshSignal,
    });
    if (lease.lost()) {
      result = failure('managed-claude-refresh-lease-lost');
      return result;
    }
    if (!refreshed.ok) {
      result = refreshed;
      return result;
    }
    // Provider refresh can rotate the only valid refresh token. Confirm that
    // this writer still owns the distributed lease immediately before the
    // durable CAS which publishes that rotated grant.
    if (!await lease.renew()) {
      result = failure('managed-claude-refresh-lease-lost');
      return result;
    }
    const persisted = await persistManagedClaudeCustody({
      portal: current.portal,
      secretId: current.secretId,
      expectedRevision: current.revision,
      refreshLeaseToken,
      grant: refreshed.grant,
      deps,
    });
    if (!persisted.ok) {
      result = persisted;
      return result;
    }
    result = {
      ok: true,
      refreshed: true,
      revision: persisted.revision,
      grant: persisted.grant,
      nextRefreshInMs: managedClaudeRefreshDelay(persisted.grant, {
        now: (deps.now || Date.now)(),
      }),
    };
    return result;
  } finally {
    await lease.stop();
    try {
      const released = await api.releaseSecretRefreshLease(
        leasedPortal,
        leasedSecretId,
        { refreshLeaseToken },
      );
      releaseConfirmed = released?.ok === true && released.released === true;
    } catch {
      releaseConfirmed = false;
    }
    if (!releaseConfirmed && result?.ok) {
      result.ok = false;
      result.reason = 'managed-claude-refresh-lease-release-unconfirmed';
      result.error = result.reason;
    }
  }
}

function startRefreshLeaseKeeper({
  api,
  portal,
  secretId,
  refreshLeaseToken,
  deps,
} = {}) {
  const controller = new AbortController();
  const intervalMs = Number.isSafeInteger(deps.refreshLeaseRenewIntervalMs)
    && deps.refreshLeaseRenewIntervalMs > 0
    ? deps.refreshLeaseRenewIntervalMs
    : REFRESH_LEASE_RENEW_INTERVAL_MS;
  const setIntervalFn = deps.setInterval || setInterval;
  const clearIntervalFn = deps.clearInterval || clearInterval;
  let stopped = false;
  let leaseLost = false;
  let renewal = null;

  const markLost = () => {
    leaseLost = true;
    if (!controller.signal.aborted) controller.abort();
  };
  const renew = async () => {
    if (stopped || leaseLost) return false;
    if (renewal) return renewal;
    renewal = (async () => {
      try {
        const response = await api.renewSecretRefreshLease(
          portal,
          secretId,
          { refreshLeaseToken },
        );
        if (response?.ok === true && response.renewed === true) return true;
      } catch {}
      markLost();
      return false;
    })();
    try {
      return await renewal;
    } finally {
      renewal = null;
    }
  };
  const timer = setIntervalFn(() => {
    void renew();
  }, intervalMs);
  timer?.unref?.();

  return {
    signal: controller.signal,
    lost: () => leaseLost,
    renew,
    async stop() {
      stopped = true;
      clearIntervalFn(timer);
      if (renewal) await renewal;
    },
  };
}

async function openVault({ portal, deps }) {
  const effectivePortal = portal?.apiUrl && portal?.token
    ? portal
    : await (deps.resolveTrustedPortal || resolveTrustedVaultPortal)({ deps })
      .catch(() => null);
  if (!effectivePortal) return failure('managed-claude-memoro-auth-missing');
  const cache = await (deps.readCachedVaultKey || readCachedVaultKey)({
    deps: deps.cacheDeps || {},
  }).catch(() => null);
  if (!cache?.vaultKey) return failure('managed-claude-custody-locked');
  const api = deps.api || VaultApi;
  const status = await api.getStatus(effectivePortal).catch(() => null);
  if (!status?.ok
    || !status.vault?.setup
    || !status.vault.wrapped_crk
    || !status.vault.crk_iv) {
    cache.vaultKeyBytes?.fill?.(0);
    return failure('managed-claude-custody-locked');
  }
  if (cache.authHash) {
    const unlocked = await api.unlockVault(effectivePortal, {
      authHash: cache.authHash,
      deviceId: cache.deviceId || null,
    }).catch(() => null);
    if (!unlocked?.ok) {
      cache.vaultKeyBytes?.fill?.(0);
      return failure('managed-claude-custody-locked');
    }
  }
  let crk;
  try {
    crk = await unwrapCustodyRoot(
      cache.vaultKey,
      status.vault.wrapped_crk,
      status.vault.crk_iv,
    );
  } catch {
    cache.vaultKeyBytes?.fill?.(0);
    return failure('managed-claude-custody-locked');
  }
  const listed = await api.listSecrets(effectivePortal).catch(() => null);
  if (!listed?.ok || !Array.isArray(listed.secrets)) {
    cache.vaultKeyBytes?.fill?.(0);
    return failure('managed-claude-custody-locked');
  }
  return {
    ok: true,
    portal: effectivePortal,
    api,
    cache,
    crk,
    secrets: listed.secrets,
  };
}

function failure(reason, extra = {}) {
  return { ok: false, reason, error: reason, ...extra };
}
