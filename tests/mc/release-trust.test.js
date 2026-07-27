import assert from 'node:assert/strict';
import test from 'node:test';

import { verifyReleaseTrust } from '../../src/mc/release-trust.js';

const encoder = new TextEncoder();
const NOW = Date.parse('2026-07-26T12:00:00Z');
const HEX = (char) => char.repeat(64);

test('accepts a pinned, canonical Ed25519 release and exact platform binding', async () => {
  const fixture = await createFixture();
  const result = await verifyReleaseTrust(fixture.input);
  const { artifact_descriptor: artifactDescriptor, ...releaseResult } = result;
  assert.deepEqual(releaseResult, {
    ok: true,
    release_id: 'rel_42',
    release_epoch: 42,
    channel: 'stable',
    manifest_sha256: result.manifest_sha256,
    trust_bundle_id: 'bundle_1',
    trust_bundle_epoch: 7,
    revocation_epoch: 9,
    platform_attestation_id: 'att_1',
    next_state: {
      bundle_epoch: 7,
      bundle_id: 'bundle_1',
      bundle_sha256: result.next_state.bundle_sha256,
      revocation_epoch: 9,
      revocation_record_id: 'revocation_9',
      revocation_sha256: result.next_state.revocation_sha256,
      release_epochs: { stable: 42 },
      release_ids: { stable: 'rel_42' },
      manifest_sha256s: { stable: result.manifest_sha256 },
      manifest_sha256: result.manifest_sha256,
    },
  });
  assert.equal(JSON.stringify(artifactDescriptor), canonical(fixture.release.artifacts));
  assert.match(result.manifest_sha256, /^[a-f0-9]{64}$/);
});

test('rejects noncanonical, duplicate and malformed UTF-8 signed payloads without diagnostics', async () => {
  const fixture = await createFixture();
  fixture.input.release_manifest_jws = await signText(
    JSON.stringify(fixture.release),
    [{ ...fixture.releaseSigner, typ: 'mc-release-manifest/v1+jws' }],
  );
  assert.deepEqual(await verifyReleaseTrust(fixture.input), { ok: false, code: 'release_signature_invalid' });

  fixture.input.release_manifest_jws = await signText(
    '{"release_id":"rel_42","release_id":"rel_43"}',
    [{ ...fixture.releaseSigner, typ: 'mc-release-manifest/v1+jws' }],
  );
  assert.deepEqual(await verifyReleaseTrust(fixture.input), { ok: false, code: 'release_signature_invalid' });

  fixture.input.release_manifest_jws = await signBytes(
    Uint8Array.from([0xff]),
    [{ ...fixture.releaseSigner, typ: 'mc-release-manifest/v1+jws' }],
  );
  assert.deepEqual(await verifyReleaseTrust(fixture.input), { ok: false, code: 'release_signature_invalid' });

  fixture.input.release_manifest_jws = await signText(
    '{"value":"\\uD800"}',
    [{ ...fixture.releaseSigner, typ: 'mc-release-manifest/v1+jws' }],
  );
  assert.deepEqual(await verifyReleaseTrust(fixture.input), { ok: false, code: 'release_signature_invalid' });
});

test('requires exact protected EdDSA headers and a 2-of-N recovery revocation quorum', async () => {
  const fixture = await createFixture();
  fixture.input.release_manifest_jws = await sign(fixture.release, [{
    ...fixture.releaseSigner,
    typ: 'mc-release-manifest/v1+jws',
    header: { alg: 'none', kid: fixture.releaseSigner.kid, typ: 'mc-release-manifest/v1+jws' },
  }]);
  assert.deepEqual(await verifyReleaseTrust(fixture.input), { ok: false, code: 'release_signature_invalid' });

  fixture.input.release_manifest_jws = fixture.releaseJws;
  fixture.input.revocation_jws = await sign(fixture.revocation, [{
    ...fixture.recoverySigners[0],
    typ: 'mc-release-revocation/v1+jws',
  }]);
  assert.deepEqual(await verifyReleaseTrust(fixture.input), { ok: false, code: 'release_signature_invalid' });
});

test('fails closed for kill switch, stale epoch, and exact platform mismatch', async () => {
  const fixture = await createFixture();
  const killed = { ...fixture.revocation, kill_switch: { active: true } };
  fixture.input.revocation_jws = await sign(killed, fixture.recoverySigners.map((key) => ({
    ...key, typ: 'mc-release-revocation/v1+jws',
  })));
  assert.deepEqual(await verifyReleaseTrust(fixture.input), { ok: false, code: 'release_kill_switch_active' });

  fixture.input.revocation_jws = fixture.revocationJws;
  fixture.input.state = { release_epochs: { stable: 43 } };
  assert.deepEqual(await verifyReleaseTrust(fixture.input), { ok: false, code: 'release_epoch_rejected' });

  fixture.input.state = {};
  fixture.input.expected_platform = { ...fixture.input.expected_platform, account_id: 'usr_other' };
  assert.deepEqual(await verifyReleaseTrust(fixture.input), { ok: false, code: 'platform_identity_mismatch' });
});

test('never returns attacker-controlled signed text or parse diagnostics', async () => {
  const fixture = await createFixture();
  const canary = 'Bearer mem_release_canary_0123456789';
  fixture.input.release_manifest_jws = await signText(
    `{"note":"${canary}"}`,
    [{ ...fixture.releaseSigner, typ: 'mc-release-manifest/v1+jws' }],
  );
  const result = await verifyReleaseTrust(fixture.input);
  assert.deepEqual(result, { ok: false, code: 'release_manifest_invalid' });
  assert.doesNotMatch(JSON.stringify(result), /release_canary|Bearer|mem_/);
});

test('enforces artifact policy and every revoked artifact fingerprint', async () => {
  const fixture = await createFixture();
  fixture.bundle.artifact_policy.codex_package_names = ['wrong/package'];
  await replaceBundle(fixture);
  assert.deepEqual(await verifyReleaseTrust(fixture.input), { ok: false, code: 'release_manifest_invalid' });

  fixture.bundle.artifact_policy.codex_package_names = ['@openai/codex'];
  await replaceBundle(fixture);
  fixture.revocation.revoked_artifact_digests = [HEX('c')];
  fixture.input.revocation_jws = await sign(fixture.revocation, fixture.recoverySigners.map((key) => ({
    ...key, typ: 'mc-release-revocation/v1+jws',
  })));
  assert.deepEqual(await verifyReleaseTrust(fixture.input), { ok: false, code: 'release_signer_revoked' });
});

test('accepts an in-window retiring signer, but rejects a closed overlap', async () => {
  const fixture = await createFixture();
  fixture.bundle.release_signers[0] = {
    ...fixture.bundle.release_signers[0],
    status: 'retiring',
    not_before: '2026-07-26T11:00:00Z',
    not_after: '2026-07-26T13:00:00Z',
  };
  await replaceBundle(fixture);
  assert.equal((await verifyReleaseTrust(fixture.input)).ok, true);

  fixture.bundle.release_signers[0].not_after = '2026-07-26T11:59:59Z';
  await replaceBundle(fixture);
  assert.deepEqual(await verifyReleaseTrust(fixture.input), { ok: false, code: 'release_signer_revoked' });
});

test('binds the signed release image and platform policy, filters revoked platform signers, and rejects equal-epoch equivocation', async () => {
  const fixture = await createFixture();
  const mismatchedImage = { ...fixture.release, artifacts: { ...fixture.release.artifacts, sandbox_image: { ...fixture.release.artifacts.sandbox_image, digest: `sha256:${HEX('f')}` } } };
  fixture.input.release_manifest_jws = await sign(mismatchedImage, [{ ...fixture.releaseSigner, typ: 'mc-release-manifest/v1+jws' }]);
  assert.deepEqual(await verifyReleaseTrust(fixture.input), { ok: false, code: 'platform_identity_mismatch' });

  fixture.input.release_manifest_jws = fixture.releaseJws;
  fixture.revocation.revoked_kids = [fixture.platformSigner.kid];
  fixture.input.revocation_jws = await sign(fixture.revocation, fixture.recoverySigners.map((key) => ({ ...key, typ: 'mc-release-revocation/v1+jws' })));
  assert.deepEqual(await verifyReleaseTrust(fixture.input), { ok: false, code: 'release_signer_revoked' });

  fixture.revocation.revoked_kids = [];
  fixture.input.revocation_jws = fixture.revocationJws;
  const accepted = await verifyReleaseTrust(fixture.input);
  const alternate = { ...fixture.release, release_id: 'rel_other' };
  fixture.input.release_manifest_jws = await sign(alternate, [{ ...fixture.releaseSigner, typ: 'mc-release-manifest/v1+jws' }]);
  fixture.input.state = accepted.next_state;
  assert.deepEqual(await verifyReleaseTrust(fixture.input), { ok: false, code: 'release_epoch_rejected' });
});

test('preserves legacy stable watermark across candidate verification and rejects equal-epoch state without identities', async () => {
  const fixture = await createFixture();
  const stable = await verifyReleaseTrust(fixture.input);
  const candidate = { ...fixture.release, release_id: 'rel_candidate', release_epoch: 1, channel: 'candidate' };
  await replaceReleaseAndAttestation(fixture, candidate);
  fixture.input.state = stable.next_state;
  const verifiedCandidate = await verifyReleaseTrust(fixture.input);
  assert.equal(verifiedCandidate.ok, true);
  assert.equal(verifiedCandidate.next_state.manifest_sha256, stable.manifest_sha256);
  assert.deepEqual(verifiedCandidate.next_state.release_epochs, { stable: 42, candidate: 1 });
  assert.deepEqual(verifiedCandidate.next_state.release_ids, { stable: 'rel_42', candidate: 'rel_candidate' });

  const identityState = stable.next_state;
  fixture.input = { ...fixture.input, release_manifest_jws: fixture.releaseJws, state: {
    bundle_epoch: identityState.bundle_epoch,
    revocation_epoch: identityState.revocation_epoch,
    release_epochs: identityState.release_epochs,
  } };
  await replaceReleaseAndAttestation(fixture, fixture.release);
  assert.deepEqual(await verifyReleaseTrust(fixture.input), { ok: false, code: 'release_epoch_rejected' });
});

test('rejects impossible RFC3339 UTC calendar dates', async () => {
  const fixture = await createFixture();
  fixture.bundle.issued_at = '2026-02-30T11:00:00Z';
  await replaceBundle(fixture);
  assert.deepEqual(await verifyReleaseTrust(fixture.input), { ok: false, code: 'release_trust_bundle_invalid' });
});

test('requires a canonical protected header, accepts astral Unicode, and maps missing bundle to BUNDLE', async () => {
  const fixture = await createFixture();
  fixture.input.release_manifest_jws = await sign(fixture.release, [{
    ...fixture.releaseSigner,
    typ: 'mc-release-manifest/v1+jws',
    header: { typ: 'mc-release-manifest/v1+jws', kid: fixture.releaseSigner.kid, alg: 'EdDSA' },
  }]);
  assert.deepEqual(await verifyReleaseTrust(fixture.input), { ok: false, code: 'release_signature_invalid' });

  fixture.input.release_manifest_jws = fixture.releaseJws;
  fixture.bundle.artifact_policy.sandbox_image_repositories.push('safe🚀');
  await replaceBundle(fixture);
  assert.equal((await verifyReleaseTrust(fixture.input)).ok, true);

  fixture.input.trust_bundle_jws = undefined;
  assert.deepEqual(await verifyReleaseTrust(fixture.input), { ok: false, code: 'release_trust_bundle_invalid' });
});

async function createFixture() {
  const bootstrap = await signingKey('bootstrap_1');
  const releaseSigner = await signingKey('release_1');
  const platformSigner = await signingKey('platform_1');
  const recoverySigners = await Promise.all(['recovery_1', 'recovery_2', 'recovery_3'].map(signingKey));
  const bundle = {
    schema: 'mc-release-trust-bundle/v1',
    bundle_id: 'bundle_1',
    bundle_epoch: 7,
    issued_at: '2026-07-26T11:00:00Z',
    expires_at: '2026-07-27T11:00:00Z',
    release_signers: [publicTrustKey(releaseSigner, 'active')],
    platform_signers: [publicTrustKey(platformSigner, 'active')],
    recovery_signers: recoverySigners.map((key) => publicTrustKey(key)),
    channels: {
      stable: { minimum_release_epoch: 1, maximum_validity_seconds: 86400 },
      candidate: { minimum_release_epoch: 1, maximum_validity_seconds: 86400 },
      emergency: { minimum_release_epoch: 1, maximum_validity_seconds: 86400 },
    },
    artifact_policy: {
      sandbox_image_repositories: ['registry.example/mc'],
      memoro_cli_repositories: ['github.example/memoro-cli'],
      codex_package_names: ['@openai/codex'],
      claude_package_names: ['@anthropic-ai/claude-code'],
    },
    revocation: { minimum_epoch: 1, recovery_quorum: 2 },
  };
  const revocation = {
    schema: 'mc-release-revocation/v1',
    record_id: 'revocation_9',
    revocation_epoch: 9,
    issued_at: '2026-07-26T11:00:00Z',
    expires_at: '2026-07-26T13:00:00Z',
    kill_switch: { active: false },
    revoked_kids: [],
    revoked_release_ids: [],
    revoked_artifact_digests: [],
  };
  const release = {
    schema: 'mc-release-manifest/v1',
    release_id: 'rel_42',
    release_epoch: 42,
    channel: 'stable',
    issued_at: '2026-07-26T11:00:00Z',
    expires_at: '2026-07-26T13:00:00Z',
    trust_bundle_epoch: 7,
    revocation_epoch: 9,
    artifacts: {
      sandbox_image: { repository: 'registry.example/mc', digest: `sha256:${HEX('a')}`, os: 'linux', architecture: 'amd64' },
      memoro_cli: { repository: 'github.example/memoro-cli', source_commit: 'a'.repeat(40), package_name: 'memoro-cli', package_version: '0.7.6', source_archive_sha256: HEX('b'), installed_tree_sha256: HEX('c') },
      codex: { enabled: true, package_name: '@openai/codex', version: '0.145.0', npm_integrity: 'sha512-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=', dist_shasum: 'd'.repeat(40), installed_tree_sha256: HEX('e') },
      claude: { enabled: false },
      trusted_adapter: { enabled: false },
    },
    platform_policy: { provider: 'cloudflare-containers-v1', sandbox_class: 'McCloudRuntimeSandbox', architectures: ['linux/amd64'], required_claims: ['image_digest'] },
  };
  const bundleJws = await sign(bundle, [{ ...bootstrap, typ: 'mc-release-trust-bundle/v1+jws' }]);
  const revocationJws = await sign(revocation, recoverySigners.map((key) => ({ ...key, typ: 'mc-release-revocation/v1+jws' })));
  const releaseJws = await sign(release, [{ ...releaseSigner, typ: 'mc-release-manifest/v1+jws' }]);
  const manifestSha = await sha256(canonical(release));
  const expected_platform = {
    account_id: 'usr_123456',
    cloud_session_id: 'cld_123456',
    coding_session_id: 'cs_123456',
    runtime_generation: 'rtg_123456',
    authorization_digest: HEX('f'),
    nonce: HEX('f'),
  };
  const platform_identity = {
    provider: 'cloudflare-containers-v1',
    sandbox_instance_id: 'instance_1',
    sandbox_class: 'McCloudRuntimeSandbox',
    process_id: 'process_1',
    image_repository: 'registry.example/mc',
    image_digest: `sha256:${HEX('a')}`,
    os: 'linux',
    architecture: 'amd64',
    workload_identity: 'workload_1',
    ...expected_platform,
  };
  const attestation = {
    schema: 'mc-platform-attestation/v1',
    attestation_id: 'att_1',
    issuer: 'platform_1',
    issued_at: '2026-07-26T11:59:00Z',
    expires_at: '2026-07-26T12:01:00Z',
    nonce: HEX('f'),
    ...platform_identity,
    release_manifest_sha256: manifestSha,
    trust_bundle_id: 'bundle_1',
    trust_bundle_epoch: 7,
  };
  return {
    bundle, bootstrap, release, revocation, releaseSigner, platformSigner, recoverySigners, releaseJws, revocationJws, attestation,
    input: {
      now_ms: NOW,
      trust_bundle_jws: bundleJws,
      pinned_trust_bundle_sha256: await sha256(bundleJws),
      bootstrap_keys: [publicTrustKey(bootstrap)],
      revocation_jws: revocationJws,
      release_manifest_jws: releaseJws,
      platform_attestation_jws: await sign(attestation, [{ ...platformSigner, typ: 'mc-platform-attestation/v1+jws' }]),
      expected_platform,
      state: {},
    },
  };
}

async function replaceBundle(fixture) {
  fixture.input.trust_bundle_jws = await sign(fixture.bundle, [{ ...fixture.bootstrap, typ: 'mc-release-trust-bundle/v1+jws' }]);
  fixture.input.pinned_trust_bundle_sha256 = await sha256(fixture.input.trust_bundle_jws);
}

async function replaceReleaseAndAttestation(fixture, release) {
  fixture.input.release_manifest_jws = await sign(release, [{ ...fixture.releaseSigner, typ: 'mc-release-manifest/v1+jws' }]);
  fixture.attestation = {
    ...fixture.attestation,
    release_manifest_sha256: await sha256(canonical(release)),
  };
  fixture.input.platform_attestation_jws = await sign(fixture.attestation, [{ ...fixture.platformSigner, typ: 'mc-platform-attestation/v1+jws' }]);
}

async function signingKey(kid) {
  const pair = await crypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify']);
  const jwk = await crypto.subtle.exportKey('jwk', pair.publicKey);
  return { kid, privateKey: pair.privateKey, x: jwk.x };
}
function publicTrustKey(key, status) {
  return status === undefined
    ? { kid: key.kid, kty: 'OKP', crv: 'Ed25519', x: key.x }
    : { kid: key.kid, kty: 'OKP', crv: 'Ed25519', x: key.x, status };
}
async function sign(value, signers) { return signBytes(encoder.encode(canonical(value)), signers); }
async function signText(value, signers) { return signBytes(encoder.encode(value), signers); }
async function signBytes(bytes, signers) {
  const payload = b64(bytes);
  return JSON.stringify({
    payload,
    signatures: await Promise.all(signers.map(async (signer) => {
      const protectedHeader = signer.header || { alg: 'EdDSA', kid: signer.kid, typ: signer.typ };
      const protectedB64 = b64(encoder.encode(JSON.stringify(protectedHeader)));
      const signature = await crypto.subtle.sign({ name: 'Ed25519' }, signer.privateKey, encoder.encode(`${protectedB64}.${payload}`));
      return { protected: protectedB64, signature: b64(new Uint8Array(signature)) };
    })),
  });
}
function canonical(value) {
  if (value === null || typeof value === 'boolean') return String(value);
  if (typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number') return String(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
}
function b64(bytes) {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}
async function sha256(value) {
  const bytes = typeof value === 'string' ? encoder.encode(value) : value;
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}
