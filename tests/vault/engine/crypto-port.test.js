/**
 * Port-verification test for src/mc/vault/client-crypto.js.
 *
 * This is the highest-priority test in the vault phase. The promise of
 * the port: encrypting the same plaintext with the same key + IV in
 * Node 22 (via `globalThis.crypto.subtle`) produces byte-identical
 * ciphertext to the browser implementation
 * (public/js/crypto/vault-client-crypto.js in the Memoro repo).
 *
 * If this test ever fails, EVERY downstream vault command is unsafe —
 * decryption will fail or, worse, succeed against the wrong bytes.
 *
 * Strategy:
 *
 *   1. **Hardcoded golden values** — captured once by running the
 *      browser source's `deriveVaultKeys` + `crypto.subtle.encrypt`
 *      with fixed inputs (see fixtures below). These guard against
 *      future Node updates silently changing PBKDF2/AES-GCM output.
 *
 *   2. **Round-trip** — derive keys, encrypt + decrypt a payload, and
 *      assert the plaintext survives a full round-trip. Catches encoding
 *      bugs (UTF-8, base64) and the auth-hash derivation specifically.
 *
 *   3. **Iteration count IS NOT lowered for speed.** The 600k constant
 *      runs once in this file (~ a second on a modern laptop) — well
 *      worth it to keep the prod codepath under test. The fast paths
 *      use iterations=1 only for cross-checking the structure, never
 *      to assert anything used in prod.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  deriveVaultKeys,
  encryptSecret,
  encryptSecretWithIv,
  decryptSecret,
  encryptSecretPayload,
  decryptSecretPayload,
  importVaultKey,
  bytesToBase64,
  base64ToBytes,
  PBKDF2_ITERATIONS,
} from '../../../src/vault/engine/client-crypto.js';

// ────────────────────────────────────────────────────────────────────────
// Golden values — captured from the browser source on 2026-05-31.
// Inputs are fixed so any regression is byte-visible.
// ────────────────────────────────────────────────────────────────────────

// Salt: 32 bytes, 0x00..0x1f, base64-encoded.
const FIXED_SALT_B64 = 'AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=';
const FIXED_PASSWORD = 'correct horse battery staple';

// authHash at the production 600 000 iterations.
const GOLDEN_AUTH_HASH_600K = '8+w/ikU3Jc/V7i160uqyAU02Xf1qEYtysLRFoZBlTIg=';
// authHash at iterations=1 — cheap structural cross-check.
const GOLDEN_AUTH_HASH_1 = 'O1I12Oypbp0BLaNh0LLRr3qteyMt2OqQA2KMP7xmOJ4=';

// AES-GCM fixture: rawKey = (i*7+3) & 0xff for i in 0..31, iv = 0..11,
// plaintext = "hello vault". Produced by the browser source's
// `crypto.subtle.encrypt`.
const GOLDEN_AES_CIPHERTEXT_B64 = 'pIQeqgK5wY0e99a5nxZd9WNxxDRKg9GGiKr3';

function fixedRawKey() {
  const k = new Uint8Array(32);
  for (let i = 0; i < 32; i++) k[i] = (i * 7 + 3) & 0xff;
  return k;
}

function fixedIv() {
  const iv = new Uint8Array(12);
  for (let i = 0; i < 12; i++) iv[i] = i;
  return iv;
}

// ────────────────────────────────────────────────────────────────────────
// Tests
// ────────────────────────────────────────────────────────────────────────

describe('vault client-crypto port — byte-identical with browser', () => {
  it('PBKDF2_ITERATIONS is 600_000 (must match server salt-issuing default)', () => {
    assert.equal(PBKDF2_ITERATIONS, 600_000);
  });

  it('deriveVaultKeys at 600k iterations matches the browser-source authHash', async () => {
    const { authHash } = await deriveVaultKeys(FIXED_PASSWORD, FIXED_SALT_B64);
    assert.equal(authHash, GOLDEN_AUTH_HASH_600K,
      'PBKDF2 output drifted from the browser source. Do NOT update the golden value without auditing both implementations.');
  });

  it('deriveVaultKeys at iterations=1 matches the browser-source authHash', async () => {
    const { authHash } = await deriveVaultKeys(FIXED_PASSWORD, FIXED_SALT_B64, 1);
    assert.equal(authHash, GOLDEN_AUTH_HASH_1);
  });

  it('AES-GCM encrypt with fixed key + IV matches the browser-source ciphertext', async () => {
    const key = await importVaultKey(fixedRawKey());
    const { ciphertext } = await encryptSecretWithIv(key, 'hello vault', fixedIv());
    assert.equal(ciphertext, GOLDEN_AES_CIPHERTEXT_B64,
      'AES-GCM output drifted from the browser source. The Node port and the browser MUST agree byte-for-byte.');
  });

  it('decrypt round-trips: a random encrypt → decrypt returns the same plaintext (UTF-8 safe)', async () => {
    // 1 iteration keeps the test fast. Round-trip semantics are
    // independent of iteration count; the byte-equality tests above
    // pin the 600k path.
    const { vaultKey } = await deriveVaultKeys(FIXED_PASSWORD, FIXED_SALT_B64, 1);
    const samples = [
      'plain ASCII',
      'tokens like sk-abc123_def-456==',
      'unicode — Sverige 🇸🇪 — émoji and 漢字',
      '', // empty string
      'x'.repeat(4096), // larger blob
    ];
    for (const plaintext of samples) {
      const { ciphertext, iv } = await encryptSecret(vaultKey, plaintext);
      const back = await decryptSecret(vaultKey, ciphertext, iv);
      assert.equal(back, plaintext, `round-trip failed for: ${JSON.stringify(plaintext.slice(0, 40))}`);
    }
  });

  it('encryptSecretPayload / decryptSecretPayload preserves label + JSON data shape', async () => {
    const { vaultKey } = await deriveVaultKeys(FIXED_PASSWORD, FIXED_SALT_B64, 1);
    const label = 'anthropic-api / personal';
    const data = { kind: 'api_token', provider: 'anthropic', token: 'sk-test-xyz', scopes: ['read', 'write'] };
    const enc = await encryptSecretPayload(vaultKey, label, data);
    // Server's wire shape uses snake_case fields; the payload decryptor
    // expects that mapping.
    const wire = {
      encrypted_label: enc.encryptedLabel,
      label_iv: enc.labelIv,
      encrypted_data: enc.encryptedData,
      iv: enc.iv,
    };
    const back = await decryptSecretPayload(vaultKey, wire);
    assert.equal(back.label, label);
    assert.deepEqual(back.data, data);
  });

  it('base64 helpers round-trip exactly (matches btoa/atob semantics)', () => {
    const samples = [
      new Uint8Array([0]),
      new Uint8Array([255, 254, 253]),
      new Uint8Array(64).map((_, i) => i * 3 + 1),
    ];
    for (const bytes of samples) {
      const b64 = bytesToBase64(bytes);
      const back = base64ToBytes(b64);
      assert.deepEqual(Array.from(back), Array.from(bytes));
    }
  });

  it('different IVs produce different ciphertexts (defence: random IV path works)', async () => {
    const { vaultKey } = await deriveVaultKeys(FIXED_PASSWORD, FIXED_SALT_B64, 1);
    const a = await encryptSecret(vaultKey, 'same plaintext');
    const b = await encryptSecret(vaultKey, 'same plaintext');
    assert.notEqual(a.ciphertext, b.ciphertext);
    assert.notEqual(a.iv, b.iv);
  });
});
