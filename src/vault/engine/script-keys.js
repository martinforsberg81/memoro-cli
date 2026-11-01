/** Envelope-only script-key custody. No plaintext CLI or environment fallback. */
import { readCachedVaultKey } from './key-cache.js';
import { resolveTrustedVaultPortal } from './trusted-portal.js';
import { decryptEnvelopeLabel, decryptEnvelopeSecret, isEnvelopeSecret, unwrapCustodyRoot } from './custody-crypto.js';
import * as VaultApi from './api.js';

export async function openScriptKeyVault({ deps = {} } = {}) {
  let cache;
  try {
    cache = await (deps.readCachedVaultKey || readCachedVaultKey)();
    if (!cache?.vaultKey) return { ok: false, reason: 'vault locked; run mc vault unlock' };
    const portal = deps.portal || await resolveTrustedVaultPortal();
    if (!portal) return { ok: false, reason: 'vault login missing' };
    const api = deps.api || VaultApi;
    if (cache.authHash) {
      const unlocked = await api.unlockVault(portal, { authHash: cache.authHash, deviceId: cache.deviceId || null });
      if (!unlocked?.ok) return { ok: false, reason: 'vault locked; run mc vault unlock' };
    }
    const status = await api.getStatus(portal);
    if (!status?.ok || !status.vault?.unlocked) return { ok: false, reason: 'vault locked; run mc vault unlock' };
    if (!status.vault.wrapped_crk || !status.vault.crk_iv) return { ok: false, reason: 'vault envelope missing; run mc vault unlock' };
    const crk = await unwrapCustodyRoot(cache.vaultKey, status.vault.wrapped_crk, status.vault.crk_iv);
    const listed = await api.listSecrets(portal);
    if (!listed?.ok || !Array.isArray(listed.secrets)) return { ok: false, reason: 'vault unavailable' };
    const rows = new Map();
    for (const row of listed.secrets) {
      if (!isEnvelopeSecret(row) || (row.class || 'secret') !== 'secret') continue;
      const label = await decryptEnvelopeLabel(crk, row);
      const matches = rows.get(label) || [];
      matches.push(row); rows.set(label, matches);
    }
    return {
      ok: true,
      held(label) { return rows.get(label)?.length === 1; },
      async release(keys) {
        const values = Object.create(null);
        for (const [name, label] of Object.entries(keys)) {
          const matching = rows.get(label) || [];
          if (matching.length !== 1) return { ok: false, reason: `${matching.length ? 'ambiguous' : 'missing'} key: ${name}` };
        }
        for (const [name, label] of Object.entries(keys)) {
          const opened = await decryptEnvelopeSecret(crk, rows.get(label)[0]);
          const value = opened?.data?.token;
          if (opened?.data?.kind !== 'api_token' || typeof value !== 'string' || !value
            || value.includes('\0') || Buffer.byteLength(value) > 65536) return { ok: false, reason: `unreadable key: ${name}` };
          values[name] = value;
        }
        return { ok: true, values };
      },
    };
  } catch {
    // Never interpolate API/crypto errors: they can contain decrypted material.
    return { ok: false, reason: 'vault unavailable or locked' };
  } finally { cache?.vaultKeyBytes?.fill?.(0); }
}
