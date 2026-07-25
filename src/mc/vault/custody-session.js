/**
 * Custody-session helpers — resolve or adopt the Custody Root Key for an
 * unlocked vault, and build secret-create bodies in the right schema.
 *
 * One entry point for every flow (setup, unlock, lifecycle, set): given a
 * KUK and a status/unlock response, either unwrap the stored CRK or — when
 * the vault predates the envelope — mint one and store its wrap
 * (set-if-absent server-side; a 409 race resolves by re-reading).
 */

import * as VaultApi from './api.js';
import {
  encryptEnvelopeSecret,
  mintCustodyRoot,
  unwrapCustodyRoot,
} from './custody-crypto.js';
import { encryptSecretPayload } from './client-crypto.js';

/**
 * Resolve the CRK for an unlocked vault, adopting the envelope when absent.
 *
 * @param {object} arg
 * @param {object} arg.portal      - {apiUrl, token}
 * @param {CryptoKey} arg.vaultKey - the passphrase-derived KUK
 * @param {object} [arg.vaultInfo] - a status/unlock response body already in
 *   hand (avoids a refetch); must carry wrapped_crk/crk_iv when set
 * @param {object} [arg.deps]      - { api } test portal
 * @returns {Promise<{ ok: true, crk: CryptoKey, adopted: boolean } |
 *                   { ok: false, reason: string }>}
 */
export async function ensureCustodyRoot({ portal, vaultKey, vaultInfo = null, deps = {} } = {}) {
  const api = deps.api || VaultApi;
  let info = vaultInfo;
  if (!info?.wrapped_crk) {
    const status = await api.getStatus(portal).catch(() => null);
    if (!status?.ok) return { ok: false, reason: 'status-unavailable' };
    info = status.vault;
  }

  if (info?.wrapped_crk && info?.crk_iv) {
    try {
      const crk = await unwrapCustodyRoot(vaultKey, info.wrapped_crk, info.crk_iv);
      return { ok: true, crk, adopted: false };
    } catch {
      // Wrong key for this wrap (e.g. stale cache after a passphrase change).
      return { ok: false, reason: 'crk-unwrap-failed' };
    }
  }

  // No envelope yet — adopt: mint client-side, store the wrap (set-if-absent).
  const minted = await mintCustodyRoot(vaultKey);
  const stored = await api.setCustodyKey(portal, {
    wrappedCrk: minted.wrapped_crk,
    crkIv: minted.crk_iv,
  }).catch((err) => ({ ok: false, error: err?.message }));
  if (stored?.ok) return { ok: true, crk: minted.crk, adopted: true };

  // Lost a set-if-absent race (another device adopted first): re-read and
  // unwrap the winner's CRK instead of ours.
  const after = await api.getStatus(portal).catch(() => null);
  if (after?.vault?.wrapped_crk) {
    try {
      const crk = await unwrapCustodyRoot(vaultKey, after.vault.wrapped_crk, after.vault.crk_iv);
      return { ok: true, crk, adopted: false };
    } catch {
      return { ok: false, reason: 'crk-unwrap-failed' };
    }
  }
  return { ok: false, reason: 'custody-key-store-failed' };
}

/**
 * Build a secret-create/update body: envelope (schema 2) when a CRK is in
 * hand, legacy (schema 1) otherwise. Callers spread the result into the
 * existing createSecret/updateSecret body next to secretType.
 */
export async function encryptForWrite({ vaultKey, crk = null, label, data, secretClass = 'secret' }) {
  if (crk) {
    const envelope = await encryptEnvelopeSecret(crk, { secretClass, label, data });
    return {
      encryptedLabel: envelope.encryptedLabel,
      labelIv: envelope.labelIv,
      encryptedData: envelope.encryptedData,
      iv: envelope.iv,
      wrappedDek: envelope.wrapped_dek,
      dekIv: envelope.dek_iv,
      secretClass: envelope.class,
      schemaVersion: envelope.schema_version,
    };
  }
  const enc = await encryptSecretPayload(vaultKey, label, data);
  return {
    encryptedLabel: enc.encryptedLabel,
    labelIv: enc.labelIv,
    encryptedData: enc.encryptedData,
    iv: enc.iv,
  };
}
