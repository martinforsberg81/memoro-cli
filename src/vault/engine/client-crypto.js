/**
 * Vault client crypto — Node port of public/js/crypto/vault-client-crypto.js
 * (Memoro web app).
 *
 * Zero-knowledge: all encryption/decryption happens here. The Memoro server
 * never sees plaintext.
 *
 * Key derivation:
 *   Master Password → PBKDF2(600k iterations) → 512 bits
 *     ├─ First 256 bits → Vault Key (encrypts/decrypts secrets)
 *     └─ Last 256 bits  → Pre-Auth Key → PBKDF2(1 iteration) → Auth Hash
 *
 * The Auth Hash is sent to the server to prove identity.
 * The Vault Key never leaves the process.
 *
 * IMPORTANT: This is a near-verbatim port. The browser source uses
 * Web Crypto via `globalThis.crypto`; Node 22's `globalThis.crypto` /
 * `crypto.subtle` is the same WHATWG-spec implementation, so output is
 * byte-identical to the browser for the same inputs. The port-verification
 * test in tests/mc/vault/crypto-port.test.js asserts this — change here
 * only if that test still passes.
 *
 * Differences from the browser source (mechanical, not cryptographic):
 *   - No `window.dispatchEvent('vault:locked')` (Node has no window).
 *     `storeVaultKey()` instead accepts an onLock callback.
 *   - Uses `Buffer.from`/`toString('base64')` in addition to `btoa`/`atob`
 *     (both available in Node 22; we keep the browser-shape helpers so
 *     bytes-in/bytes-out match exactly).
 *
 * NEVER add a second PBKDF2 iteration count for tests — slower tests are
 * fine; mismatched iteration counts in tests vs prod is unsafe.
 */

const ALGORITHM = 'AES-GCM';
const IV_LENGTH = 12; // 96 bits
const KEY_LENGTH = 32; // 256 bits
export const PBKDF2_ITERATIONS = 600_000;

// ---------------------------------------------------------------------------
// Encoding helpers — match the browser source byte-for-byte.
// ---------------------------------------------------------------------------

export function bytesToBase64(bytes) {
  // Matches the browser: btoa(String.fromCharCode(...bytes))
  // For large arrays Buffer is faster, but for our key + IV sizes (<= 96
  // bytes) the difference is irrelevant and we want the same code path.
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

export function base64ToBytes(base64) {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

// ---------------------------------------------------------------------------
// Key derivation
// ---------------------------------------------------------------------------

/**
 * Derive vault key + auth hash from master password and salt.
 * @param {string} masterPassword - User's master password
 * @param {string} saltBase64 - Base64-encoded salt from server
 * @param {number} [iterations=600000] - PBKDF2 iterations (server returns
 *   this in /status + /unlock responses; pass it through, don't hardcode)
 * @returns {Promise<{ vaultKey: CryptoKey, authHash: string, vaultKeyBytes: Uint8Array }>}
 */
export async function deriveVaultKeys(masterPassword, saltBase64, iterations = PBKDF2_ITERATIONS) {
  const salt = base64ToBytes(saltBase64);
  const encoder = new TextEncoder();

  const keyMaterial = await globalThis.crypto.subtle.importKey(
    'raw',
    encoder.encode(masterPassword),
    { name: 'PBKDF2' },
    false,
    ['deriveBits'],
  );

  const derivedBits = await globalThis.crypto.subtle.deriveBits(
    {
      name: 'PBKDF2',
      hash: 'SHA-256',
      salt,
      iterations,
    },
    keyMaterial,
    512,
  );

  const derivedBytes = new Uint8Array(derivedBits);
  const vaultKeyBytes = derivedBytes.slice(0, KEY_LENGTH);
  const preAuthKeyBytes = derivedBytes.slice(KEY_LENGTH);

  const vaultKey = await globalThis.crypto.subtle.importKey(
    'raw',
    vaultKeyBytes,
    { name: ALGORITHM },
    false,
    ['encrypt', 'decrypt'],
  );

  const preAuthMaterial = await globalThis.crypto.subtle.importKey(
    'raw',
    preAuthKeyBytes,
    { name: 'PBKDF2' },
    false,
    ['deriveBits'],
  );

  const authBits = await globalThis.crypto.subtle.deriveBits(
    {
      name: 'PBKDF2',
      hash: 'SHA-256',
      salt,
      iterations: 1,
    },
    preAuthMaterial,
    256,
  );

  const authHash = bytesToBase64(new Uint8Array(authBits));

  // vaultKeyBytes is exposed so the port-verification test can encrypt
  // with a fixed raw key and assert ciphertext equality. Production code
  // should use the CryptoKey handle.
  return { vaultKey, authHash, vaultKeyBytes };
}

/**
 * Import a raw 32-byte vault key for AES-GCM. Test helper + a building
 * block for the deterministic port-verification fixture.
 */
export async function importVaultKey(rawKeyBytes) {
  return globalThis.crypto.subtle.importKey(
    'raw',
    rawKeyBytes,
    { name: ALGORITHM },
    false,
    ['encrypt', 'decrypt'],
  );
}

// ---------------------------------------------------------------------------
// Encryption
// ---------------------------------------------------------------------------

/**
 * Encrypt plaintext with the vault key.
 * @param {CryptoKey} vaultKey
 * @param {string} plaintext
 * @returns {Promise<{ ciphertext: string, iv: string }>} both base64
 */
export async function encryptSecret(vaultKey, plaintext) {
  const iv = globalThis.crypto.getRandomValues(new Uint8Array(IV_LENGTH));
  return encryptSecretWithIv(vaultKey, plaintext, iv);
}

/**
 * Encrypt with a caller-supplied IV. Exposed for the port-verification
 * fixture — production code should use `encryptSecret` (random IV).
 */
export async function encryptSecretWithIv(vaultKey, plaintext, iv) {
  const encoder = new TextEncoder();
  const ciphertext = await globalThis.crypto.subtle.encrypt(
    { name: ALGORITHM, iv },
    vaultKey,
    encoder.encode(plaintext),
  );
  return {
    ciphertext: bytesToBase64(new Uint8Array(ciphertext)),
    iv: bytesToBase64(iv),
  };
}

/**
 * Decrypt ciphertext with the vault key.
 */
export async function decryptSecret(vaultKey, ciphertextBase64, ivBase64) {
  const ciphertext = base64ToBytes(ciphertextBase64);
  const iv = base64ToBytes(ivBase64);
  const plaintext = await globalThis.crypto.subtle.decrypt(
    { name: ALGORITHM, iv },
    vaultKey,
    ciphertext,
  );
  return new TextDecoder().decode(plaintext);
}

// ---------------------------------------------------------------------------
// Structured-payload helpers — same shape as the browser source.
// ---------------------------------------------------------------------------

export async function encryptSecretPayload(vaultKey, label, data) {
  const [labelResult, dataResult] = await Promise.all([
    encryptSecret(vaultKey, label),
    encryptSecret(vaultKey, JSON.stringify(data)),
  ]);
  return {
    encryptedLabel: labelResult.ciphertext,
    labelIv: labelResult.iv,
    encryptedData: dataResult.ciphertext,
    iv: dataResult.iv,
  };
}

export async function decryptSecretPayload(vaultKey, secret) {
  const [label, dataJson] = await Promise.all([
    decryptSecret(vaultKey, secret.encrypted_label, secret.label_iv),
    decryptSecret(vaultKey, secret.encrypted_data, secret.iv),
  ]);
  return {
    label,
    data: JSON.parse(dataJson),
  };
}

// ---------------------------------------------------------------------------
// In-process vault key cache (kept for symmetry with browser source).
// Phase 1 doesn't use this — every mc command is a fresh process so the
// cache is empty by definition. Phase 2 will move caching to the OS
// keychain. We keep this in the port so the shape stays familiar.
// ---------------------------------------------------------------------------

let _vaultKey = null;
let _lockTimer = null;

export function storeVaultKey(key, { timeoutMs = 15 * 60 * 1000, onLock = null } = {}) {
  clearVaultKey();
  _vaultKey = key;
  _lockTimer = setTimeout(() => {
    clearVaultKey();
    if (typeof onLock === 'function') {
      try { onLock(); } catch { /* swallow */ }
    }
  }, timeoutMs);
  // Don't keep the event loop alive just for the auto-lock timer.
  if (_lockTimer && typeof _lockTimer.unref === 'function') _lockTimer.unref();
}

export function getVaultKey() {
  return _vaultKey;
}

export function clearVaultKey() {
  _vaultKey = null;
  if (_lockTimer) {
    clearTimeout(_lockTimer);
    _lockTimer = null;
  }
}
