/**
 * Thin typed wrappers around the Memoro vault HTTP API.
 *
 * Every function takes a `portal` object (`{ memoroFetch, apiUrl, token }`)
 * so tests can inject a stub fetch and assert on requests without going
 * over the wire. Production wires the default portal from
 * `src/lib/api.js` + `src/lib/config.js` + `src/lib/keychain.js`.
 *
 * Soft-degrade policy: network/server errors bubble up with the message
 * the underlying memoroFetch produced (already prefixed "Memoro …"). The
 * commands wrap those into friendly strings — this layer stays neutral.
 */

import { memoroFetch as defaultMemoroFetch } from '../../lib/api.js';

const DEFAULT_PORTAL = {
  memoroFetch: defaultMemoroFetch,
};

function portalOrDefault(p) {
  if (!p) throw new Error('vault api: portal {apiUrl, token} required');
  const memoroFetch = p.memoroFetch || DEFAULT_PORTAL.memoroFetch;
  if (!p.apiUrl) throw new Error('vault api: apiUrl missing');
  if (!p.token) throw new Error('vault api: token missing (run mc to sign in first)');
  return { ...p, memoroFetch };
}

export async function getStatus(portal) {
  const p = portalOrDefault(portal);
  return p.memoroFetch(p.apiUrl, '/api/vault/status', { token: p.token });
}

export async function setupVault(portal, { authHash }) {
  const p = portalOrDefault(portal);
  return p.memoroFetch(p.apiUrl, '/api/vault/setup', {
    token: p.token, method: 'POST', body: { authHash },
  });
}

export async function unlockVault(portal, { authHash, deviceId = null, deviceName = null, devicePlatform = null }) {
  const p = portalOrDefault(portal);
  return p.memoroFetch(p.apiUrl, '/api/vault/unlock', {
    token: p.token, method: 'POST',
    body: {
      authHash,
      ...(deviceId ? { deviceId, deviceName, devicePlatform } : {}),
    },
  });
}

export async function listDevices(portal) {
  const p = portalOrDefault(portal);
  return p.memoroFetch(p.apiUrl, '/api/vault/devices', { token: p.token });
}

export async function revokeDevice(portal, { deviceId }) {
  const p = portalOrDefault(portal);
  return p.memoroFetch(p.apiUrl, '/api/vault/devices/revoke', {
    token: p.token, method: 'POST', body: { deviceId },
  });
}

export async function lockVault(portal) {
  const p = portalOrDefault(portal);
  return p.memoroFetch(p.apiUrl, '/api/vault/lock', {
    token: p.token, method: 'POST', body: {},
  });
}

export async function destroyVault(portal) {
  const p = portalOrDefault(portal);
  return p.memoroFetch(p.apiUrl, '/api/vault', {
    token: p.token, method: 'DELETE',
  });
}

export async function destroyVaultForgotten(portal) {
  const p = portalOrDefault(portal);
  return p.memoroFetch(p.apiUrl, '/api/vault/destroy-forgotten', {
    token: p.token, method: 'POST', body: {},
  });
}

export async function listSecrets(portal) {
  const p = portalOrDefault(portal);
  return p.memoroFetch(p.apiUrl, '/api/vault/secrets', { token: p.token });
}

export async function createSecret(portal, body) {
  const p = portalOrDefault(portal);
  return p.memoroFetch(p.apiUrl, '/api/vault/secrets', {
    token: p.token, method: 'POST', body,
  });
}

export async function updateSecret(portal, id, body) {
  requireRowRevision(body?.expectedRevision);
  const p = portalOrDefault(portal);
  return p.memoroFetch(p.apiUrl, `/api/vault/secrets/${encodeURIComponent(id)}`, {
    token: p.token, method: 'PUT', body,
  });
}

export async function acquireSecretRefreshLease(portal, id, {
  refreshLeaseToken,
} = {}) {
  const p = portalOrDefault(portal);
  return p.memoroFetch(
    p.apiUrl,
    `/api/vault/secrets/${encodeURIComponent(id)}/refresh-lease`,
    {
      token: p.token,
      method: 'POST',
      body: {
        operation: 'acquire',
        refreshLeaseToken,
      },
    },
  );
}

export async function releaseSecretRefreshLease(portal, id, {
  refreshLeaseToken,
} = {}) {
  const p = portalOrDefault(portal);
  return p.memoroFetch(
    p.apiUrl,
    `/api/vault/secrets/${encodeURIComponent(id)}/refresh-lease`,
    {
      token: p.token,
      method: 'POST',
      body: {
        operation: 'release',
        refreshLeaseToken,
      },
    },
  );
}

export async function renewSecretRefreshLease(portal, id, {
  refreshLeaseToken,
} = {}) {
  const p = portalOrDefault(portal);
  return p.memoroFetch(
    p.apiUrl,
    `/api/vault/secrets/${encodeURIComponent(id)}/refresh-lease`,
    {
      token: p.token,
      method: 'POST',
      body: {
        operation: 'renew',
        refreshLeaseToken,
      },
    },
  );
}

export async function deleteSecret(portal, id, { expectedRevision } = {}) {
  requireRowRevision(expectedRevision);
  const p = portalOrDefault(portal);
  return p.memoroFetch(p.apiUrl, `/api/vault/secrets/${encodeURIComponent(id)}`, {
    token: p.token, method: 'DELETE', body: { expectedRevision },
  });
}

function requireRowRevision(value) {
  if (typeof value !== 'string' || !/^[0-9a-f]{32}$/u.test(value)) {
    throw new TypeError('a valid opaque row_revision is required for vault secret writes');
  }
}

export async function changePassword(portal, { currentAuthHash, newAuthHash, newSalt, wrappedCrk = null, crkIv = null }) {
  const p = portalOrDefault(portal);
  return p.memoroFetch(p.apiUrl, '/api/vault/change-password', {
    // Non-idempotent: a lost fetch response may follow a committed rotation.
    // Never replay it via curl, even if the default transport enables fallback.
    curlFallback: false,
    token: p.token, method: 'POST',
    body: {
      currentAuthHash, newAuthHash, newSalt,
      ...(wrappedCrk ? { wrappedCrk, crkIv } : {}),
    },
  });
}

export async function setRecoveryKey(portal, { wrappedCrkRecovery, recoveryIv, recoverySalt, recoveryAuthHash, currentAuthHash }) {
  // Every request carries the fresh current-password proof: the server needs
  // it to replace a code, and a first code must not be a bypass.
  if (typeof currentAuthHash !== 'string' || !currentAuthHash) {
    throw new TypeError('currentAuthHash is required to create or replace a recovery code');
  }
  const p = portalOrDefault(portal);
  return p.memoroFetch(p.apiUrl, '/api/vault/recovery-key', {
    // Non-idempotent: a lost fetch response may follow a committed replacement.
    // Never replay it via curl, even if the default transport enables fallback.
    curlFallback: false,
    token: p.token, method: 'POST',
    body: { wrappedCrkRecovery, recoveryIv, recoverySalt, recoveryAuthHash, currentAuthHash },
  });
}

export async function recoverVault(portal, { recoveryAuthHash, newAuthHash, newSalt, wrappedCrk, crkIv }) {
  const p = portalOrDefault(portal);
  return p.memoroFetch(p.apiUrl, '/api/vault/recover', {
    token: p.token, method: 'POST',
    body: { recoveryAuthHash, newAuthHash, newSalt, wrappedCrk, crkIv },
  });
}

export async function setCustodyKey(portal, { wrappedCrk, crkIv }) {
  const p = portalOrDefault(portal);
  return p.memoroFetch(p.apiUrl, '/api/vault/custody-key', {
    token: p.token, method: 'POST', body: { wrappedCrk, crkIv },
  });
}
