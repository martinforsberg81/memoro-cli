/**
 * Custody envelope crypto — the key hierarchy from docs/plans/mc-custody.md.
 *
 *   Master Password ─PBKDF2─► KUK (the existing "vault key", client-only)
 *                                │ wraps (AES-GCM + AAD)
 *                                ▼
 *                          CRK (random 256-bit Custody Root Key)
 *                                │ wraps (AES-GCM + AAD binds the class)
 *                                ▼
 *                          DEK_i (per-secret Data Encryption Key)
 *                                │ encrypts (existing payload crypto, unchanged)
 *                                ▼
 *                          ciphertext_i
 *
 * Why an envelope instead of the legacy "KUK encrypts secrets directly":
 * passphrase rotation re-wraps ONE key instead of re-encrypting every secret,
 * a recovery code is just a second wrap of the same CRK (S4), and V2's scoped
 * cloud unlock re-wraps individual DEKs without ever exposing the CRK.
 *
 * The payload cipher (encryptSecretPayload/decryptSecretPayload) is reused
 * BYTE-IDENTICALLY — only the key that drives it changes (DEK instead of the
 * passphrase-derived key). That keeps the browser-port equivalence intact.
 *
 * AAD discipline: every wrap carries AES-GCM additionalData so a stored blob
 * cannot be repurposed — the CRK wrap is domain-bound, and each DEK wrap is
 * bound to the secret's class (`tool-auth` | `secret`). Unwrapping with the
 * wrong AAD fails authentication, by construction.
 *
 * Zero-knowledge invariant unchanged: everything in this file runs client-side;
 * the server only ever stores wrapped keys and ciphertext.
 */

import {
  bytesToBase64,
  base64ToBytes,
  importVaultKey,
  encryptSecretPayload,
  decryptSecret,
  decryptSecretPayload,
} from './client-crypto.js';

const ALGORITHM = 'AES-GCM';
const IV_LENGTH = 12;
const KEY_LENGTH = 32;

export const CRK_AAD = 'mc-custody:crk:v1';
export const CRK_RECOVERY_AAD = 'mc-custody:crk-recovery:v1';
export const DEK_AAD_PREFIX = 'mc-custody:dek:v1:';
export const ENVELOPE_SCHEMA_VERSION = 2;
export const SECRET_CLASSES = Object.freeze(['secret', 'tool-auth']);

// ---------------------------------------------------------------------------
// Raw-key wrap / unwrap (AES-GCM with AAD)
// ---------------------------------------------------------------------------

export function generateRawKey() {
  return globalThis.crypto.getRandomValues(new Uint8Array(KEY_LENGTH));
}

/**
 * Wrap raw key bytes under a KEK. Random IV; `wrapRawKeyWithIv` exists for
 * deterministic fixtures only.
 * @returns {Promise<{ wrapped: string, iv: string }>} both base64
 */
export async function wrapRawKey(kek, rawKeyBytes, aad) {
  const iv = globalThis.crypto.getRandomValues(new Uint8Array(IV_LENGTH));
  return wrapRawKeyWithIv(kek, rawKeyBytes, aad, iv);
}

export async function wrapRawKeyWithIv(kek, rawKeyBytes, aad, iv) {
  assertKeyBytes(rawKeyBytes);
  const wrapped = await globalThis.crypto.subtle.encrypt(
    { name: ALGORITHM, iv, additionalData: new TextEncoder().encode(aad) },
    kek,
    rawKeyBytes,
  );
  return { wrapped: bytesToBase64(new Uint8Array(wrapped)), iv: bytesToBase64(iv) };
}

/**
 * Unwrap raw key bytes. Throws on tampering, a wrong KEK, or an AAD mismatch —
 * GCM authentication covers all three; callers must not distinguish.
 */
export async function unwrapRawKey(kek, wrappedBase64, ivBase64, aad) {
  const raw = await globalThis.crypto.subtle.decrypt(
    {
      name: ALGORITHM,
      iv: base64ToBytes(ivBase64),
      additionalData: new TextEncoder().encode(aad),
    },
    kek,
    base64ToBytes(wrappedBase64),
  );
  const bytes = new Uint8Array(raw);
  assertKeyBytes(bytes);
  return bytes;
}

// ---------------------------------------------------------------------------
// Custody Root Key
// ---------------------------------------------------------------------------

/**
 * Mint a fresh CRK and wrap it under the KUK (setup / adopt-into-envelope).
 * @param {CryptoKey} kuk - the passphrase-derived vault key
 * @returns {Promise<{ crk: CryptoKey, crkBytes: Uint8Array, wrapped_crk: string, crk_iv: string }>}
 */
export async function mintCustodyRoot(kuk) {
  const crkBytes = generateRawKey();
  const { wrapped, iv } = await wrapRawKey(kuk, crkBytes, CRK_AAD);
  const crk = await importVaultKey(crkBytes);
  return { crk, crkBytes, wrapped_crk: wrapped, crk_iv: iv };
}

/**
 * Unwrap the stored CRK with the KUK (unlock).
 */
export async function unwrapCustodyRoot(kuk, wrappedCrkBase64, crkIvBase64) {
  const crkBytes = await unwrapRawKey(kuk, wrappedCrkBase64, crkIvBase64, CRK_AAD);
  try {
    return await importVaultKey(crkBytes);
  } finally {
    crkBytes.fill(0);
  }
}

/**
 * Unwrap the CRK to raw bytes — needed by rotation/recovery, which re-wrap
 * the same CRK under a different KEK. Callers must drop the bytes promptly.
 */
export async function unwrapCustodyRootBytes(kek, wrappedBase64, ivBase64, aad = CRK_AAD) {
  return unwrapRawKey(kek, wrappedBase64, ivBase64, aad);
}

/**
 * Wrap existing CRK bytes under a KEK (rotation → CRK_AAD under the new
 * passphrase key; recovery → CRK_RECOVERY_AAD under the code-derived key).
 */
export async function wrapCustodyRootBytes(kek, crkBytes, aad = CRK_AAD) {
  return wrapRawKey(kek, crkBytes, aad);
}

const RECOVERY_ALPHABET = 'ABCDEFGHJKMNPQRSTVWXYZ23456789'; // no 0/O/1/I/L/U

/**
 * Generate a human-typable recovery code: 8 groups of 4 from a 30-char
 * alphabet (~157 bits). Shown once at creation; treated exactly like a
 * second master password by the KDF split.
 */
export function generateRecoveryCode() {
  const bytes = globalThis.crypto.getRandomValues(new Uint8Array(32));
  let out = '';
  for (let i = 0; i < 32; i++) {
    out += RECOVERY_ALPHABET[bytes[i] % RECOVERY_ALPHABET.length];
    if (i % 4 === 3 && i < 31) out += '-';
  }
  return out;
}

// ---------------------------------------------------------------------------
// Per-secret envelope
// ---------------------------------------------------------------------------

function dekAad(secretClass) {
  return DEK_AAD_PREFIX + secretClass;
}

export function assertSecretClass(secretClass) {
  if (!SECRET_CLASSES.includes(secretClass)) {
    throw new Error(`custody: unknown secret class "${secretClass}"`);
  }
}

/**
 * Encrypt a secret under a fresh DEK, wrapped under the CRK. Produces the
 * full wire shape for create/update calls.
 */
export async function encryptEnvelopeSecret(crk, { secretClass = 'secret', label, data }) {
  assertSecretClass(secretClass);
  const dekBytes = generateRawKey();
  try {
    const dek = await importVaultKey(dekBytes);
    const payload = await encryptSecretPayload(dek, label, data);
    const { wrapped, iv } = await wrapRawKey(crk, dekBytes, dekAad(secretClass));
    return {
      ...payload,
      wrapped_dek: wrapped,
      dek_iv: iv,
      class: secretClass,
      schema_version: ENVELOPE_SCHEMA_VERSION,
    };
  } finally {
    dekBytes.fill(0);
  }
}

/**
 * Decrypt a stored envelope secret row (snake_case wire shape).
 */
export async function decryptEnvelopeSecret(crk, row) {
  const secretClass = row.class || 'secret';
  assertSecretClass(secretClass);
  const dekBytes = await unwrapRawKey(crk, row.wrapped_dek, row.dek_iv, dekAad(secretClass));
  try {
    const dek = await importVaultKey(dekBytes);
    return await decryptSecretPayload(dek, row);
  } finally {
    dekBytes.fill(0);
  }
}

/**
 * Decrypt only an envelope's label. Selectors that need one named record can
 * use this first without materialising unrelated secret payloads in memory.
 */
export async function decryptEnvelopeLabel(crk, row) {
  const secretClass = row.class || 'secret';
  assertSecretClass(secretClass);
  const dekBytes = await unwrapRawKey(crk, row.wrapped_dek, row.dek_iv, dekAad(secretClass));
  try {
    const dek = await importVaultKey(dekBytes);
    return await decryptSecret(dek, row.encrypted_label, row.label_iv);
  } finally {
    dekBytes.fill(0);
  }
}

/**
 * Envelope rows carry a wrapped DEK; legacy (v1) rows do not. The reader
 * dispatches on this, which is what makes migration lazy and per-row.
 */
export function isEnvelopeSecret(row) {
  return typeof row?.wrapped_dek === 'string' && row.wrapped_dek.length > 0;
}

function assertKeyBytes(bytes) {
  if (!(bytes instanceof Uint8Array) || bytes.length !== KEY_LENGTH) {
    throw new Error('custody: raw key must be 32 bytes');
  }
}
