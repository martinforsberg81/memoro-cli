/**
 * The step-credit API key, read from the vault for one purpose.
 *
 * Runner step sessions whose billing is `credits` run on the Max plan's API
 * credit (step-credits ruling, `docs/project/mc/rulings.md` § 38). This module
 * opens exactly one mc-vault record — the one labelled `mc-api-key` — with the
 * cached vault key and returns its token. It deliberately has no label, path,
 * destination or environment parameter: `deps` carries only test seams.
 *
 * Every failure returns `{ ok: false, reason }` and never throws. No return
 * value names the key or any decrypted label other than the constant.
 */

import { getSecret as keychainGet } from '../../lib/keychain.js';
import { memoroFetch } from '../../lib/api.js';
import { readConfig } from '../../lib/config.js';
import { readCachedVaultKey as defaultReadCachedVaultKey } from './key-cache.js';
import {
  decryptEnvelopeLabel,
  decryptEnvelopeSecret,
  isEnvelopeSecret,
  unwrapCustodyRoot,
} from './custody-crypto.js';
import { decryptSecret, decryptSecretPayload } from './client-crypto.js';
import * as VaultApi from './api.js';

export const STEP_CREDIT_KEY_LABEL = 'mc-api-key';

const MEMORO_PRIMARY_AUTH_TOKEN_ACCOUNT = 'memoro-api-token';

/**
 * @param {object} [opts]
 * @param {object} [opts.deps] - test seams only: `readCachedVaultKey`, `portal`, `api`
 * @returns {Promise<{ ok: true, key: string } | { ok: false, reason: string }>}
 */
export async function readStepCreditKey({ deps = {} } = {}) {
  const readCache = deps.readCachedVaultKey || defaultReadCachedVaultKey;
  const api = deps.api || VaultApi;
  let cache = null;
  try {
    cache = await readCache().catch(() => null);
    if (!cache?.vaultKey) return failure('vault-locked');
    const portal = deps.portal || await resolveTrustedPortal();
    if (!portal) return failure('not-logged-in');
    return await readWithCache(api, portal, cache);
  } catch {
    return failure('key-unreadable');
  } finally {
    cache?.vaultKeyBytes?.fill?.(0);
  }
}

async function readWithCache(api, portal, cache) {
  if (cache.authHash) {
    const unlocked = await api.unlockVault(portal, {
      authHash: cache.authHash,
      deviceId: cache.deviceId || null,
    }).catch(() => null);
    if (!unlocked?.ok) return failure('vault-refused');
  }
  const status = await api.getStatus(portal).catch(() => null);
  if (!status?.ok || !status.vault?.setup) return failure('vault-unreachable');
  let custodyRoot = null;
  if (status.vault.wrapped_crk && status.vault.crk_iv) {
    try {
      custodyRoot = await unwrapCustodyRoot(cache.vaultKey, status.vault.wrapped_crk, status.vault.crk_iv);
    } catch {
      // A cached key that cannot open the custody root is a stale unlock.
      return failure('vault-locked');
    }
  }
  const listed = await api.listSecrets(portal).catch(() => null);
  if (!listed?.ok || !Array.isArray(listed.secrets)) return failure('vault-unreachable');

  const matching = [];
  for (const row of listed.secrets) {
    let label;
    if (isEnvelopeSecret(row)) {
      if (!custodyRoot || (row.class || 'secret') !== 'secret') continue;
      try { label = await decryptEnvelopeLabel(custodyRoot, row); } catch { continue; }
    } else {
      try { label = await decryptSecret(cache.vaultKey, row.encrypted_label, row.label_iv); } catch { continue; }
    }
    if (label === STEP_CREDIT_KEY_LABEL) matching.push(row);
  }
  if (matching.length === 0) return failure('no-key');
  if (matching.length > 1) return failure('key-ambiguous');

  const row = matching[0];
  let opened;
  try {
    opened = isEnvelopeSecret(row)
      ? await decryptEnvelopeSecret(custodyRoot, row)
      : await decryptSecretPayload(cache.vaultKey, row);
  } catch {
    return failure('key-unreadable');
  }
  const key = exactApiToken(opened?.data);
  return key ? { ok: true, key } : failure('key-unreadable');
}

function exactApiToken(data) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return null;
  if (data.kind !== 'api_token') return null;
  const token = data.token;
  if (typeof token !== 'string' || token.length === 0 || /\s/u.test(token)) return null;
  return token;
}

async function resolveTrustedPortal() {
  const token = await keychainGet(MEMORO_PRIMARY_AUTH_TOKEN_ACCOUNT).catch(() => null);
  if (!token) return null;
  const config = await readConfig().catch(() => ({}));
  return {
    apiUrl: config.apiUrl || 'https://meetmemoro.app',
    token,
    memoroFetch,
  };
}

function failure(reason) {
  return { ok: false, reason };
}
