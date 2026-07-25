/**
 * Custody envelope crypto (docs/plans/mc-custody.md, S1).
 *
 * Locks the hierarchy's behavior AND its wire format: the fixed-vector test
 * pins the exact wrap ciphertext so a refactor cannot silently change the
 * format and strand stored wrapped keys.
 */
import test, { describe } from 'node:test';
import assert from 'node:assert/strict';

import { importVaultKey } from '../../../src/mc/vault/client-crypto.js';
import {
  CRK_AAD,
  CRK_RECOVERY_AAD,
  generateRecoveryCode,
  unwrapCustodyRootBytes,
  wrapCustodyRootBytes,
  ENVELOPE_SCHEMA_VERSION,
  decryptEnvelopeSecret,
  encryptEnvelopeSecret,
  generateRawKey,
  isEnvelopeSecret,
  mintCustodyRoot,
  unwrapCustodyRoot,
  unwrapRawKey,
  wrapRawKey,
  wrapRawKeyWithIv,
} from '../../../src/mc/vault/custody-crypto.js';

async function fixedKek(fill = 7) {
  return importVaultKey(new Uint8Array(32).fill(fill));
}

/** Server rows are snake_case; the envelope writer emits camelCase payload
 *  fields on create. Mirror what the server stores and returns. */
function asWireRow(envelope) {
  return {
    encrypted_label: envelope.encryptedLabel,
    label_iv: envelope.labelIv,
    encrypted_data: envelope.encryptedData,
    iv: envelope.iv,
    wrapped_dek: envelope.wrapped_dek,
    dek_iv: envelope.dek_iv,
    class: envelope.class,
    schema_version: envelope.schema_version,
  };
}

describe('custody envelope crypto', () => {
  test('CRK mint + unwrap round-trip under the KUK', async () => {
    const kuk = await fixedKek();
    const { crkBytes, wrapped_crk, crk_iv } = await mintCustodyRoot(kuk);
    assert.equal(crkBytes.length, 32);
    const crk = await unwrapCustodyRoot(kuk, wrapped_crk, crk_iv);
    // Prove the unwrapped CRK is usable and equivalent: encrypt with the
    // minted key, decrypt with the unwrapped one.
    const envelope = await encryptEnvelopeSecret(await importVaultKey(crkBytes), {
      label: 'x', data: { v: 1 },
    });
    const out = await decryptEnvelopeSecret(crk, asWireRow(envelope));
    assert.deepEqual(out, { label: 'x', data: { v: 1 } });
  });

  test('envelope secret round-trip with class binding', async () => {
    const crk = await fixedKek(9);
    const envelope = await encryptEnvelopeSecret(crk, {
      secretClass: 'tool-auth',
      label: 'claude-code',
      data: { anthropic: { apiKey: 'sk-test' } },
    });
    assert.equal(envelope.class, 'tool-auth');
    assert.equal(envelope.schema_version, ENVELOPE_SCHEMA_VERSION);
    assert.ok(isEnvelopeSecret(asWireRow(envelope)));

    const out = await decryptEnvelopeSecret(crk, asWireRow(envelope));
    assert.equal(out.label, 'claude-code');
    assert.deepEqual(out.data, { anthropic: { apiKey: 'sk-test' } });
  });

  test('a repurposed class fails authentication (AAD binding)', async () => {
    const crk = await fixedKek(9);
    const envelope = await encryptEnvelopeSecret(crk, {
      secretClass: 'secret', label: 'k', data: { v: 1 },
    });
    const tampered = { ...asWireRow(envelope), class: 'tool-auth' };
    await assert.rejects(() => decryptEnvelopeSecret(crk, tampered));
  });

  test('a wrong KEK and a tampered wrap both fail closed', async () => {
    const kuk = await fixedKek(7);
    const wrongKek = await fixedKek(8);
    const { wrapped_crk, crk_iv } = await mintCustodyRoot(kuk);
    await assert.rejects(() => unwrapCustodyRoot(wrongKek, wrapped_crk, crk_iv));
    const flipped = `${wrapped_crk.slice(0, -4)}AAAA`;
    await assert.rejects(() => unwrapCustodyRoot(kuk, flipped, crk_iv));
  });

  test('unknown secret class is refused on both paths', async () => {
    const crk = await fixedKek(9);
    await assert.rejects(
      () => encryptEnvelopeSecret(crk, { secretClass: 'admin', label: 'x', data: {} }),
      /unknown secret class/,
    );
    const envelope = await encryptEnvelopeSecret(crk, { label: 'x', data: {} });
    await assert.rejects(
      () => decryptEnvelopeSecret(crk, { ...asWireRow(envelope), class: 'admin' }),
      /unknown secret class/,
    );
  });

  test('raw keys must be exactly 32 bytes', async () => {
    const kek = await fixedKek();
    await assert.rejects(() => wrapRawKey(kek, new Uint8Array(16), CRK_AAD), /32 bytes/);
    assert.equal(generateRawKey().length, 32);
  });

  test('fixed vector: wrap format is pinned (refactors must not change it)', async () => {
    const kek = await fixedKek(7);
    const raw = new Uint8Array(32).fill(11);
    const iv = new Uint8Array(12).fill(3);
    const { wrapped, iv: ivB64 } = await wrapRawKeyWithIv(kek, raw, CRK_AAD, iv);
    assert.equal(wrapped, 'LvWoCFEjVUlxS0hX4Fz0B+Y36+S/np97JNWMuujuS7NBE8fdu2a5aZv3dKnsGM6K');
    assert.equal(ivB64, 'AwMDAwMDAwMDAwMD');
    const back = await unwrapRawKey(kek, wrapped, ivB64, CRK_AAD);
    assert.deepEqual([...back], [...raw]);
  });

  test('rotation and recovery re-wrap the SAME CRK — old envelopes stay readable', async () => {
    const oldKuk = await fixedKek(1);
    const newKuk = await fixedKek(2);
    const { crkBytes, wrapped_crk, crk_iv } = await mintCustodyRoot(oldKuk);
    const envelope = await encryptEnvelopeSecret(await importVaultKey(crkBytes), {
      label: 'gh', data: { v: 1 },
    });

    // Rotation: unwrap with the old KUK, wrap under the new one.
    const reopened = await unwrapCustodyRootBytes(oldKuk, wrapped_crk, crk_iv);
    const rotated = await wrapCustodyRootBytes(newKuk, reopened);
    const crkAfter = await unwrapCustodyRoot(newKuk, rotated.wrapped, rotated.iv);
    const out = await decryptEnvelopeSecret(crkAfter, asWireRow(envelope));
    assert.deepEqual(out, { label: 'gh', data: { v: 1 } });

    // Recovery wrap: distinct AAD — a recovery blob cannot pose as the
    // passphrase wrap, and vice versa.
    const ruk = await fixedKek(3);
    const recovery = await wrapCustodyRootBytes(ruk, reopened, CRK_RECOVERY_AAD);
    const viaRecovery = await unwrapCustodyRootBytes(ruk, recovery.wrapped, recovery.iv, CRK_RECOVERY_AAD);
    assert.deepEqual([...viaRecovery], [...reopened]);
    await assert.rejects(() => unwrapCustodyRootBytes(ruk, recovery.wrapped, recovery.iv, CRK_AAD));
  });

  test('recovery codes are typable, grouped, and high-entropy', () => {
    const a = generateRecoveryCode();
    const b = generateRecoveryCode();
    assert.match(a, /^([A-HJ-NP-TV-Z2-9]{4}-){7}[A-HJ-NP-TV-Z2-9]{4}$/);
    assert.notEqual(a, b);
  });

  test('legacy rows (no wrapped_dek) are not envelope secrets', () => {
    assert.equal(isEnvelopeSecret({ encrypted_data: 'x', iv: 'y' }), false);
    assert.equal(isEnvelopeSecret(null), false);
    assert.equal(isEnvelopeSecret({ wrapped_dek: '' }), false);
  });
});
