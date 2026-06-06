/**
 * Vault-key OS-keychain cache (§12f).
 *
 * Phase 1 prompted for the master password on every `mc vault <verb>`.
 * Phase 2 caches the derived vault-key under
 *   service=memoro-cli, account=mc-vault:active-key
 * with a 15-min TTL so subsequent commands don't re-derive PBKDF2.
 *
 * Why a single keychain entry rather than per-user-id: the mc client
 * doesn't know its own Memoro user id without a server roundtrip, and
 * one mc install ↔ one OS user account ↔ one vault is the dominant case.
 * The brief's `<user-id-or-host>` formulation explicitly permits the
 * host-scoped name. Per-user id-scoped naming can land cheap later by
 * appending the user id to the account name; the API below stays the
 * same.
 *
 * Cache value shape (JSON in the keychain entry):
 *   { vaultKeyB64: string, expiresAt: ISO-string }
 *
 * We embed expiresAt rather than relying on OS-keychain TTL because:
 *   - Linux libsecret has no native expiry
 *   - macOS Keychain "session" entries die with the login session, not
 *     after N minutes
 * Embedding `expiresAt` lets cache-hit checks validate freshness
 * portably and lets `mc auth status` surface the remaining time.
 *
 * IMPORTANT: the vault-key in the keychain is access-controlled by the OS
 * (TouchID on macOS, libsecret/secret-service on Linux, file-mode 0600 on
 * the cross-platform fallback). We deliberately do NOT add an extra app-
 * level encryption layer — that'd just move the new key into the same
 * keychain we're using anyway. Document the tradeoff; don't shadow it.
 *
 * Test injection: every function accepts an optional `deps` arg with
 *   { getSecret, setSecret, deleteSecret, now }
 * so tests can drive the cache without touching a real keychain.
 */

import {
  getSecret as defaultGetSecret,
  setSecret as defaultSetSecret,
  deleteSecret as defaultDeleteSecret,
} from '../../lib/keychain.js';
import { bytesToBase64, base64ToBytes, importVaultKey } from './client-crypto.js';

export const VAULT_CACHE_ACCOUNT = 'mc-vault:active-key';
export const TTL_MS = 15 * 60 * 1000;

/**
 * Compute the cache key for a given identity. Today we don't have a
 * user-id at hand without a server call, so the default is the host-
 * scoped constant. Tests + future per-account variants can override.
 */
export function cacheAccountFor(identity = null) {
  if (!identity) return VAULT_CACHE_ACCOUNT;
  return `${VAULT_CACHE_ACCOUNT}:${identity}`;
}

/**
 * Cache an unlocked vault-key. Writes JSON-encoded
 * { vaultKeyB64, expiresAt } into the keychain entry. Best-effort:
 * a keychain write failure does NOT throw — falling back to "prompt
 * every command" is preferable to refusing to operate.
 *
 * @param {Uint8Array} vaultKeyBytes - 32-byte raw AES key from
 *   deriveVaultKeys(); not the CryptoKey handle.
 * @param {object} [opts]
 * @param {number} [opts.ttlMs=TTL_MS] - lifetime starting from now.
 * @param {string|null} [opts.identity] - optional per-identity suffix.
 * @param {object} [opts.deps]
 */
export async function cacheVaultKey(vaultKeyBytes, {
  ttlMs = TTL_MS,
  identity = null,
  deps = {},
} = {}) {
  const setSecret = deps.setSecret || defaultSetSecret;
  const now = typeof deps.now === 'function' ? deps.now() : Date.now();
  if (!(vaultKeyBytes instanceof Uint8Array) || vaultKeyBytes.length !== 32) {
    throw new Error('cacheVaultKey: vaultKeyBytes must be a 32-byte Uint8Array');
  }
  const value = JSON.stringify({
    vaultKeyB64: bytesToBase64(vaultKeyBytes),
    expiresAt: new Date(now + ttlMs).toISOString(),
  });
  try {
    await setSecret(cacheAccountFor(identity), value);
    return true;
  } catch {
    // Soft-degrade: caller falls back to prompt path on next call.
    return false;
  }
}

/**
 * Read the cached vault-key if present + unexpired. Returns
 * { vaultKey: CryptoKey, vaultKeyBytes: Uint8Array, expiresAt: string }
 * or null. Expired entries are eagerly cleared.
 */
export async function readCachedVaultKey({
  identity = null,
  deps = {},
} = {}) {
  const getSecret = deps.getSecret || defaultGetSecret;
  const now = typeof deps.now === 'function' ? deps.now() : Date.now();

  let raw;
  try {
    raw = await getSecret(cacheAccountFor(identity));
  } catch {
    return null;
  }
  if (!raw) return null;
  const parsed = parseCacheRecord(raw, now);
  if (!parsed.present) {
    if (parsed.clear) await clearCachedVaultKey({ identity, deps }).catch(() => {});
    return null;
  }
  let vaultKey;
  try {
    vaultKey = await importVaultKey(parsed.vaultKeyBytes);
  } catch {
    await clearCachedVaultKey({ identity, deps }).catch(() => {});
    return null;
  }
  return { vaultKey, vaultKeyBytes: parsed.vaultKeyBytes, expiresAt: parsed.expiresAt };
}

/**
 * Inspect-only: returns { present, expiresAt, expiresInMs } without
 * importing the key. Used by `mc auth status` and the vault-status verb
 * to surface "Vault: unlocked, 13m until lock".
 */
export async function inspectCachedVaultKey({
  identity = null,
  deps = {},
} = {}) {
  const getSecret = deps.getSecret || defaultGetSecret;
  const now = typeof deps.now === 'function' ? deps.now() : Date.now();
  let raw;
  try { raw = await getSecret(cacheAccountFor(identity)); }
  catch { return emptyInspect('unreadable'); }
  if (!raw) return emptyInspect('missing');
  const parsed = parseCacheRecord(raw, now);
  return {
    present: parsed.present,
    expiresAt: parsed.expiresAt,
    expiresInMs: parsed.expiresInMs,
    reason: parsed.reason,
  };
}

/**
 * Drop the cached vault-key. Idempotent — missing entries are not an
 * error.
 */
export async function clearCachedVaultKey({
  identity = null,
  deps = {},
} = {}) {
  const deleteSecret = deps.deleteSecret || defaultDeleteSecret;
  try {
    await deleteSecret(cacheAccountFor(identity));
  } catch { /* best effort */ }
  return true;
}

function emptyInspect(reason) {
  return { present: false, expiresAt: null, expiresInMs: 0, reason };
}

function parseCacheRecord(raw, now) {
  let parsed;
  try { parsed = JSON.parse(raw); }
  catch { return { present: false, expiresAt: null, expiresInMs: 0, reason: 'invalid-json', clear: true }; }

  const expiresAt = typeof parsed?.expiresAt === 'string' ? parsed.expiresAt : null;
  const expiresMs = Date.parse(expiresAt);
  if (!Number.isFinite(expiresMs)) {
    return { present: false, expiresAt, expiresInMs: 0, reason: 'invalid-expires-at', clear: true };
  }
  if (expiresMs <= now) {
    return { present: false, expiresAt, expiresInMs: 0, reason: 'expired', clear: true };
  }

  if (typeof parsed?.vaultKeyB64 !== 'string') {
    return { present: false, expiresAt, expiresInMs: expiresMs - now, reason: 'missing-vault-key', clear: true };
  }

  let vaultKeyBytes;
  try {
    vaultKeyBytes = base64ToBytes(parsed.vaultKeyB64);
  } catch {
    return { present: false, expiresAt, expiresInMs: expiresMs - now, reason: 'invalid-vault-key', clear: true };
  }
  if (vaultKeyBytes.length !== 32) {
    return { present: false, expiresAt, expiresInMs: expiresMs - now, reason: 'invalid-vault-key', clear: true };
  }

  return {
    present: true,
    expiresAt,
    expiresInMs: expiresMs - now,
    reason: 'ok',
    clear: false,
    vaultKeyBytes,
  };
}
