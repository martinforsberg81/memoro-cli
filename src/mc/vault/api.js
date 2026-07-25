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
  const p = portalOrDefault(portal);
  return p.memoroFetch(p.apiUrl, `/api/vault/secrets/${encodeURIComponent(id)}`, {
    token: p.token, method: 'PUT', body,
  });
}

export async function deleteSecret(portal, id) {
  const p = portalOrDefault(portal);
  return p.memoroFetch(p.apiUrl, `/api/vault/secrets/${encodeURIComponent(id)}`, {
    token: p.token, method: 'DELETE',
  });
}

export async function changePassword(portal, { currentAuthHash, newAuthHash, newSalt }) {
  const p = portalOrDefault(portal);
  return p.memoroFetch(p.apiUrl, '/api/vault/change-password', {
    token: p.token, method: 'POST', body: { currentAuthHash, newAuthHash, newSalt },
  });
}

export async function setCustodyKey(portal, { wrappedCrk, crkIv }) {
  const p = portalOrDefault(portal);
  return p.memoroFetch(p.apiUrl, '/api/vault/custody-key', {
    token: p.token, method: 'POST', body: { wrappedCrk, crkIv },
  });
}
