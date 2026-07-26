const CODES = Object.freeze({
  BUNDLE: 'release_trust_bundle_invalid',
  SIGNATURE: 'release_signature_invalid',
  MANIFEST: 'release_manifest_invalid',
  EPOCH: 'release_epoch_rejected',
  ARTIFACT: 'release_artifact_mismatch',
  REVOKED: 'release_signer_revoked',
  KILL: 'release_kill_switch_active',
  PLATFORM_UNAVAILABLE: 'platform_identity_unavailable',
  PLATFORM_MISMATCH: 'platform_identity_mismatch',
});

const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true });
const ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const SHA256_RE = /^[a-f0-9]{64}$/;
const DIGEST_RE = /^sha256:[a-f0-9]{64}$/;
const COMMIT_RE = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;
const CHANNELS = new Set(['stable', 'candidate', 'emergency']);

export const RELEASE_TRUST_CODES = CODES;

// Scope: validation of a bootstrap-pinned bundle. Selecting and atomically
// activating a dual-signed successor bundle belongs to the control-plane
// rotation integration, not this pure verifier core.
// This deliberately returns only fixed, non-secret metadata. Callers must
// persist returned epochs atomically before issuing a workload credential.
export async function verifyReleaseTrust(input = {}) {
  try {
    const now = Number.isSafeInteger(input.now_ms) ? input.now_ms : NaN;
    if (!Number.isFinite(now)) fail(CODES.MANIFEST);

    let bundle;
    try {
      const bundleRaw = asUtf8(input.trust_bundle_jws);
      if (!isSha256(input.pinned_trust_bundle_sha256)
        || !constantTimeEqual(await sha256Hex(bundleRaw), input.pinned_trust_bundle_sha256)) fail(CODES.BUNDLE);
      const bootstrapKeys = keySet(input.bootstrap_keys, CODES.BUNDLE, false);
      bundle = await verifyDocument(bundleRaw, bootstrapKeys, 'mc-release-trust-bundle/v1+jws', 1, CODES.BUNDLE);
    } catch {
      fail(CODES.BUNDLE);
    }
    const bundleSha256 = await sha256Hex(bundle.canonical);
    validateBundle(bundle.payload, bundleSha256, now, input.state);

    const revocation = await verifyDocument(
      asUtf8(input.revocation_jws),
      keySet(bundle.payload.recovery_signers, CODES.BUNDLE, false),
      'mc-release-revocation/v1+jws',
      bundle.payload.revocation.recovery_quorum,
      CODES.SIGNATURE,
    );
    const revocationSha256 = await sha256Hex(revocation.canonical);
    validateRevocation(revocation.payload, revocationSha256, bundle.payload, now, input.state);
    if (revocation.payload.kill_switch.active) fail(CODES.KILL);

    const release = await verifyDocument(
      asUtf8(input.release_manifest_jws),
      eligibleKeys(bundle.payload.release_signers, revocation.payload, now),
      'mc-release-manifest/v1+jws',
      1,
      CODES.SIGNATURE,
    );
    const manifestSha256 = await sha256Hex(release.canonical);
    validateRelease(release.payload, manifestSha256, bundle.payload, revocation.payload, now, input.state);
    const platform = await verifyPlatform(
      input.platform_attestation_jws,
      bundle.payload,
      revocation.payload,
      input.expected_platform,
      release.payload,
      manifestSha256,
      now,
    );

    return {
      ok: true,
      release_id: release.payload.release_id,
      release_epoch: release.payload.release_epoch,
      channel: release.payload.channel,
      manifest_sha256: manifestSha256,
      trust_bundle_id: bundle.payload.bundle_id,
      trust_bundle_epoch: bundle.payload.bundle_epoch,
      revocation_epoch: revocation.payload.revocation_epoch,
      platform_attestation_id: platform.attestation_id,
      artifact_descriptor: release.payload.artifacts,
      next_state: {
        bundle_epoch: bundle.payload.bundle_epoch,
        bundle_id: bundle.payload.bundle_id,
        bundle_sha256: bundleSha256,
        revocation_epoch: revocation.payload.revocation_epoch,
        revocation_record_id: revocation.payload.record_id,
        revocation_sha256: revocationSha256,
        release_epochs: nextChannelWatermarks(input.state?.release_epochs, release.payload.channel, release.payload.release_epoch),
        release_ids: nextChannelWatermarks(input.state?.release_ids, release.payload.channel, release.payload.release_id),
        manifest_sha256s: nextChannelWatermarks(input.state?.manifest_sha256s, release.payload.channel, manifestSha256),
        manifest_sha256: release.payload.channel === 'stable' || !isSha256(input.state?.manifest_sha256)
          ? manifestSha256
          : input.state.manifest_sha256,
      },
    };
  } catch (err) {
    return { ok: false, code: knownCode(err?.code) };
  }
}

async function verifyPlatform(raw, bundle, revocation, expected, release, manifestSha256, now) {
  validateExpectedPlatform(expected);
  let document;
  try {
    document = await verifyDocument(
      asUtf8(raw),
      eligibleKeys(bundle.platform_signers, revocation, now),
      'mc-platform-attestation/v1+jws',
      1,
      CODES.PLATFORM_UNAVAILABLE,
    );
  } catch (err) {
    if (err?.code === CODES.REVOKED) throw err;
    fail(CODES.PLATFORM_UNAVAILABLE);
  }
  const value = document.payload;
  try {
    requireExactKeys(value, [
      'schema', 'attestation_id', 'issuer', 'issued_at', 'expires_at', 'nonce',
      'provider', 'sandbox_instance_id', 'sandbox_class', 'process_id',
      'image_repository', 'image_digest', 'os', 'architecture', 'workload_identity', 'account_id',
      'cloud_session_id', 'coding_session_id', 'runtime_generation',
      'authorization_digest', 'release_manifest_sha256', 'trust_bundle_id', 'trust_bundle_epoch',
    ]);
    if (value.schema !== 'mc-platform-attestation/v1'
      || !id(value.attestation_id) || !id(value.issuer) || !id(value.provider)
      || !id(value.sandbox_instance_id) || !id(value.sandbox_class) || !id(value.process_id)
      || !id(value.workload_identity) || !id(value.account_id) || !id(value.cloud_session_id) || !id(value.coding_session_id)
      || !id(value.runtime_generation) || !SHA256_RE.test(value.authorization_digest)
      || !SHA256_RE.test(value.release_manifest_sha256) || !SHA256_RE.test(value.nonce)
      || !DIGEST_RE.test(value.image_digest) || !text(value.image_repository, 256)
      || !text(value.os, 32) || !text(value.architecture, 32)
      || value.trust_bundle_epoch !== bundle.bundle_epoch || value.trust_bundle_id !== bundle.bundle_id) {
      fail(CODES.PLATFORM_UNAVAILABLE);
    }
    validWindow(value, now, 300, CODES.PLATFORM_UNAVAILABLE);
  } catch (err) {
    if (err?.code) throw err;
    fail(CODES.PLATFORM_UNAVAILABLE);
  }
  const binding = {
    ...expected,
    provider: release.platform_policy.provider,
    sandbox_class: release.platform_policy.sandbox_class,
    image_repository: release.artifacts.sandbox_image.repository,
    image_digest: release.artifacts.sandbox_image.digest,
    os: release.artifacts.sandbox_image.os,
    architecture: release.artifacts.sandbox_image.architecture,
    release_manifest_sha256: manifestSha256,
    trust_bundle_id: bundle.bundle_id,
    trust_bundle_epoch: bundle.bundle_epoch,
  };
  if (!release.platform_policy.architectures.includes(`${value.os}/${value.architecture}`)) fail(CODES.PLATFORM_MISMATCH);
  for (const [key, expectedValue] of Object.entries(binding)) {
    if (value[key] !== expectedValue) fail(CODES.PLATFORM_MISMATCH);
  }
  return value;
}

function validateExpectedPlatform(value) {
  try {
    requireExactKeys(value, [
      'account_id', 'cloud_session_id', 'coding_session_id', 'runtime_generation',
      'authorization_digest', 'nonce',
    ]);
    if (!id(value.account_id) || !id(value.cloud_session_id) || !id(value.coding_session_id)
      || !id(value.runtime_generation) || !SHA256_RE.test(value.authorization_digest)
      || value.nonce !== value.authorization_digest) fail(CODES.PLATFORM_UNAVAILABLE);
  } catch (err) {
    if (err?.code) throw err;
    fail(CODES.PLATFORM_UNAVAILABLE);
  }
}

function validateBundle(value, bundleSha256, now, state) {
  try {
    requireExactKeys(value, [
      'schema', 'bundle_id', 'bundle_epoch', 'issued_at', 'expires_at',
      'release_signers', 'platform_signers', 'recovery_signers', 'channels', 'artifact_policy', 'revocation',
    ]);
    if (value.schema !== 'mc-release-trust-bundle/v1' || !id(value.bundle_id)
      || !positive(value.bundle_epoch) || !plainObject(value.channels) || !plainObject(value.artifact_policy)
      || !plainObject(value.revocation)) fail(CODES.BUNDLE);
    validWindow(value, now, 31_536_000, CODES.BUNDLE);
    keySet(value.release_signers, CODES.BUNDLE, true);
    keySet(value.platform_signers, CODES.BUNDLE, true);
    keySet(value.recovery_signers, CODES.BUNDLE, false);
    requireExactKeys(value.revocation, ['minimum_epoch', 'recovery_quorum']);
    if (!positive(value.revocation.minimum_epoch)
      || !Number.isSafeInteger(value.revocation.recovery_quorum)
      || value.revocation.recovery_quorum < 2
      || value.revocation.recovery_quorum > value.recovery_signers.length) fail(CODES.BUNDLE);
    for (const [channel, policy] of Object.entries(value.channels)) {
      if (!CHANNELS.has(channel) || !plainObject(policy)) fail(CODES.BUNDLE);
      requireExactKeys(policy, ['minimum_release_epoch', 'maximum_validity_seconds']);
      if (!positive(policy.minimum_release_epoch) || !positive(policy.maximum_validity_seconds)) fail(CODES.BUNDLE);
    }
    if (!value.channels.stable) fail(CODES.BUNDLE);
    requireExactKeys(value.artifact_policy, [
      'sandbox_image_repositories', 'memoro_cli_repositories',
      'codex_package_names', 'claude_package_names',
    ]);
    for (const allowed of Object.values(value.artifact_policy)) {
      if (!Array.isArray(allowed) || !allowed.length || !allowed.every((item) => text(item, 256))) fail(CODES.BUNDLE);
    }
    if (Number.isSafeInteger(state?.bundle_epoch) && value.bundle_epoch < state.bundle_epoch) fail(CODES.EPOCH);
    if (value.bundle_epoch === state?.bundle_epoch
      && (!id(state?.bundle_id) || !isSha256(state?.bundle_sha256)
        || state.bundle_id !== value.bundle_id || state.bundle_sha256 !== bundleSha256)) fail(CODES.EPOCH);
  } catch (err) {
    if (err?.code === CODES.EPOCH) throw err;
    fail(CODES.BUNDLE);
  }
}

function validateRevocation(value, revocationSha256, bundle, now, state) {
  try {
    requireExactKeys(value, [
      'schema', 'record_id', 'revocation_epoch', 'issued_at', 'expires_at',
      'kill_switch', 'revoked_kids', 'revoked_release_ids', 'revoked_artifact_digests',
    ]);
    if (value.schema !== 'mc-release-revocation/v1' || !id(value.record_id)
      || !positive(value.revocation_epoch) || !plainObject(value.kill_switch)
      || typeof value.kill_switch.active !== 'boolean'
      || !stringList(value.revoked_kids, id) || !stringList(value.revoked_release_ids, id)
      || !stringList(value.revoked_artifact_digests, artifactFingerprint)) fail(CODES.BUNDLE);
    requireExactKeys(value.kill_switch, ['active']);
    validWindow(value, now, 86_400, CODES.BUNDLE);
    if (value.revocation_epoch < bundle.revocation.minimum_epoch) fail(CODES.EPOCH);
    if (Number.isSafeInteger(state?.revocation_epoch) && value.revocation_epoch < state.revocation_epoch) fail(CODES.EPOCH);
    if (value.revocation_epoch === state?.revocation_epoch
      && (!id(state?.revocation_record_id) || !isSha256(state?.revocation_sha256)
        || state.revocation_record_id !== value.record_id || state.revocation_sha256 !== revocationSha256)) fail(CODES.EPOCH);
  } catch (err) {
    if (err?.code === CODES.EPOCH) throw err;
    fail(CODES.BUNDLE);
  }
}

function validateRelease(value, manifestSha256, bundle, revocation, now, state) {
  try {
    requireExactKeys(value, [
      'schema', 'release_id', 'release_epoch', 'channel', 'issued_at', 'expires_at',
      'trust_bundle_epoch', 'revocation_epoch', 'artifacts', 'platform_policy',
    ]);
    if (value.schema !== 'mc-release-manifest/v1' || !id(value.release_id)
      || !positive(value.release_epoch) || !CHANNELS.has(value.channel)
      || value.trust_bundle_epoch !== bundle.bundle_epoch
      || value.revocation_epoch !== revocation.revocation_epoch
      || !plainObject(value.artifacts) || !plainObject(value.platform_policy)) fail(CODES.MANIFEST);
    const policy = bundle.channels[value.channel];
    if (!policy || value.release_epoch < policy.minimum_release_epoch) fail(CODES.EPOCH);
    validWindow(value, now, policy.maximum_validity_seconds, CODES.MANIFEST);
    validateArtifacts(value.artifacts);
    if (!bundle.artifact_policy.sandbox_image_repositories.includes(value.artifacts.sandbox_image.repository)
      || !bundle.artifact_policy.memoro_cli_repositories.includes(value.artifacts.memoro_cli.repository)
      || (value.artifacts.codex.enabled && !bundle.artifact_policy.codex_package_names.includes(value.artifacts.codex.package_name))
      || (value.artifacts.claude.enabled && !bundle.artifact_policy.claude_package_names.includes(value.artifacts.claude.package_name))) {
      fail(CODES.MANIFEST);
    }
    requireExactKeys(value.platform_policy, ['provider', 'sandbox_class', 'architectures', 'required_claims']);
    if (!id(value.platform_policy.provider) || !id(value.platform_policy.sandbox_class)
      || !stringList(value.platform_policy.architectures, (v) => text(v, 32))
      || !stringList(value.platform_policy.required_claims, id)) fail(CODES.MANIFEST);
    if (revocation.revoked_release_ids.includes(value.release_id)
      || artifactFingerprints(value.artifacts).some((fingerprint) => revocation.revoked_artifact_digests.includes(fingerprint))) fail(CODES.REVOKED);
    const previousEpoch = state?.release_epochs?.[value.channel];
    if (Number.isSafeInteger(previousEpoch) && value.release_epoch < previousEpoch) fail(CODES.EPOCH);
    if (value.release_epoch === previousEpoch
      && (!id(state?.release_ids?.[value.channel]) || !isSha256(state?.manifest_sha256s?.[value.channel])
        || state.release_ids[value.channel] !== value.release_id
        || state.manifest_sha256s[value.channel] !== manifestSha256)) fail(CODES.EPOCH);
  } catch (err) {
    if (err?.code === CODES.EPOCH || err?.code === CODES.REVOKED) throw err;
    fail(CODES.MANIFEST);
  }
}

function validateArtifacts(value) {
  requireExactKeys(value, ['sandbox_image', 'memoro_cli', 'codex', 'claude', 'trusted_adapter']);
  const image = value.sandbox_image;
  requireExactKeys(image, ['repository', 'digest', 'os', 'architecture']);
  if (!text(image.repository, 256) || !DIGEST_RE.test(image.digest) || !text(image.os, 32) || !text(image.architecture, 32)) fail(CODES.MANIFEST);
  const cli = value.memoro_cli;
  requireExactKeys(cli, ['repository', 'source_commit', 'package_name', 'package_version', 'source_archive_sha256', 'installed_tree_sha256']);
  if (!text(cli.repository, 256) || !COMMIT_RE.test(cli.source_commit) || cli.package_name !== 'memoro-cli'
    || !text(cli.package_version, 64) || !SHA256_RE.test(cli.source_archive_sha256) || !SHA256_RE.test(cli.installed_tree_sha256)) fail(CODES.MANIFEST);
  packageArtifact(value.codex, '@openai/codex');
  packageArtifact(value.claude, '@anthropic-ai/claude-code');
  const adapter = value.trusted_adapter;
  if (!plainObject(adapter) || typeof adapter.enabled !== 'boolean') fail(CODES.MANIFEST);
  if (!adapter.enabled) {
    requireExactKeys(adapter, ['enabled']);
  } else {
    requireExactKeys(adapter, ['enabled', 'id', 'version', 'content_sha256', 'signer_kid']);
    if (!id(adapter.id) || !text(adapter.version, 64) || !SHA256_RE.test(adapter.content_sha256) || !id(adapter.signer_kid)) fail(CODES.MANIFEST);
  }
}

function packageArtifact(value, name) {
  if (!plainObject(value) || typeof value.enabled !== 'boolean') fail(CODES.MANIFEST);
  if (!value.enabled) {
    requireExactKeys(value, ['enabled']);
    return;
  }
  requireExactKeys(value, ['enabled', 'package_name', 'version', 'npm_integrity', 'dist_shasum', 'installed_tree_sha256']);
  if (value.package_name !== name || !text(value.version, 64)
    || !/^sha512-[A-Za-z0-9+/]+={0,2}$/.test(value.npm_integrity)
    || !/^[a-f0-9]{40}$/.test(value.dist_shasum) || !SHA256_RE.test(value.installed_tree_sha256)) fail(CODES.MANIFEST);
}

function artifactFingerprints(artifacts) {
  const out = [
    artifacts.sandbox_image.digest,
    artifacts.memoro_cli.source_commit,
    artifacts.memoro_cli.source_archive_sha256,
    artifacts.memoro_cli.installed_tree_sha256,
  ];
  for (const artifact of [artifacts.codex, artifacts.claude]) {
    if (!artifact.enabled) continue;
    out.push(artifact.npm_integrity, artifact.dist_shasum, artifact.installed_tree_sha256);
  }
  if (artifacts.trusted_adapter.enabled) out.push(artifacts.trusted_adapter.content_sha256);
  return out;
}
function artifactFingerprint(value) {
  return DIGEST_RE.test(value) || SHA256_RE.test(value) || /^[a-f0-9]{40}$/.test(value)
    || /^sha512-[A-Za-z0-9+/]+={0,2}$/.test(value);
}

async function verifyDocument(raw, keys, typ, threshold, code) {
  let outer;
  try {
    outer = parseStrictJson(raw);
    requireExactKeys(outer, ['payload', 'signatures']);
    if (typeof outer.payload !== 'string' || !Array.isArray(outer.signatures)
      || outer.signatures.length < 1 || outer.signatures.length > 16) fail(code);
  } catch {
    fail(code);
  }
  const payloadBytes = decodeB64url(outer.payload);
  let payload;
  let canonical;
  try {
    payload = parseStrictJson(payloadBytes);
    canonical = encoder.encode(canonicalJcs(payload));
    if (!bytesEqual(payloadBytes, canonical)) fail(code);
  } catch {
    fail(code);
  }
  const verified = new Set();
  for (const signature of outer.signatures) {
    try {
      requireExactKeys(signature, ['protected', 'signature']);
      if (typeof signature.protected !== 'string' || typeof signature.signature !== 'string') continue;
      const headerBytes = decodeB64url(signature.protected);
      const header = parseStrictJson(headerBytes);
      requireExactKeys(header, ['alg', 'kid', 'typ']);
      if (!bytesEqual(headerBytes, encoder.encode(canonicalJcs(header)))) continue;
      if (header.alg !== 'EdDSA' || header.typ !== typ || !id(header.kid)) continue;
      const key = keys.get(header.kid);
      if (!key || verified.has(header.kid)) continue;
      const publicKey = await crypto.subtle.importKey('jwk', key.jwk, { name: 'Ed25519' }, false, ['verify']);
      const signatureBytes = decodeB64url(signature.signature);
      const input = encoder.encode(`${signature.protected}.${outer.payload}`);
      if (await crypto.subtle.verify({ name: 'Ed25519' }, publicKey, signatureBytes, input)) verified.add(header.kid);
    } catch {
      // A bad sibling signature cannot invalidate a valid threshold quorum.
    }
  }
  if (verified.size < threshold) fail(code);
  return { payload, canonical, verified };
}

function eligibleKeys(keys, revocation, now) {
  const selected = Array.isArray(keys) ? keys.filter((key) => (
    (key.status === 'active' || key.status === 'retiring')
      && !revocation.revoked_kids.includes(key.kid)
      && (!key.not_before || Date.parse(key.not_before) <= now)
      && (!key.not_after || Date.parse(key.not_after) > now)
  )) : [];
  if (!selected.length) fail(CODES.REVOKED);
  return keySet(selected, CODES.BUNDLE, false);
}

function keySet(keys, code, allowStatuses) {
  if (!Array.isArray(keys) || keys.length < 1 || keys.length > 16) fail(code);
  const out = new Map();
  for (const key of keys) {
    if (!plainObject(key)) fail(code);
    const allowed = ['kid', 'kty', 'crv', 'x', 'status', 'not_before', 'not_after'];
    requireExactKeys(key, allowed.filter((name) => key[name] !== undefined));
    if (!id(key.kid) || key.kty !== 'OKP' || key.crv !== 'Ed25519'
      || !/^[A-Za-z0-9_-]{43}$/.test(key.x) || out.has(key.kid)) fail(code);
    if (key.status !== undefined && !['active', 'retiring', 'revoked'].includes(key.status)) fail(code);
    if (allowStatuses && key.status === undefined) fail(code);
    if (key.not_before !== undefined && !rfc3339(key.not_before)) fail(code);
    if (key.not_after !== undefined && !rfc3339(key.not_after)) fail(code);
    out.set(key.kid, { jwk: { kty: 'OKP', crv: 'Ed25519', x: key.x }, ...key });
  }
  return out;
}

function validWindow(value, now, maximumSeconds, code) {
  if (!rfc3339(value.issued_at) || !rfc3339(value.expires_at)) fail(code);
  const issued = Date.parse(value.issued_at);
  const expires = Date.parse(value.expires_at);
  if (!Number.isFinite(issued) || !Number.isFinite(expires) || issued > now || expires <= now
    || expires - issued > maximumSeconds * 1000) fail(code);
}

function parseStrictJson(input) {
  const source = typeof input === 'string' ? input : decoder.decode(input);
  let at = 0;
  const skip = () => { while (/\s/.test(source[at] || '')) at += 1; };
  const value = () => {
    skip();
    const char = source[at];
    if (char === '{') return object();
    if (char === '[') return array();
    if (char === '"') return string();
    if (source.startsWith('true', at)) { at += 4; return true; }
    if (source.startsWith('false', at)) { at += 5; return false; }
    if (source.startsWith('null', at)) { at += 4; return null; }
    return number();
  };
  const object = () => {
    const out = Object.create(null); const seen = new Set(); at += 1; skip();
    if (source[at] === '}') { at += 1; return out; }
    for (;;) {
      if (source[at] !== '"') throw new Error('json');
      const key = string();
      if (seen.has(key)) throw new Error('duplicate');
      seen.add(key); skip();
      if (source[at++] !== ':') throw new Error('json');
      out[key] = value(); skip();
      if (source[at] === '}') { at += 1; return out; }
      if (source[at++] !== ',') throw new Error('json');
      skip();
    }
  };
  const array = () => {
    const out = []; at += 1; skip();
    if (source[at] === ']') { at += 1; return out; }
    for (;;) {
      out.push(value()); skip();
      if (source[at] === ']') { at += 1; return out; }
      if (source[at++] !== ',') throw new Error('json');
    }
  };
  const string = () => {
    let out = ''; at += 1;
    while (at < source.length) {
      const char = source[at++];
      if (char === '"') return out;
      if (char < ' ') throw new Error('control');
      if (char !== '\\') {
        const code = char.charCodeAt(0);
        if (code >= 0xD800 && code <= 0xDBFF) {
          const low = source.charCodeAt(at);
          if (low < 0xDC00 || low > 0xDFFF) throw new Error('surrogate');
          out += char + source[at++]; continue;
        }
        if (code >= 0xDC00 && code <= 0xDFFF) throw new Error('surrogate');
        out += char; continue;
      }
      const escaped = source[at++];
      if ('"\\/'.includes(escaped)) { out += escaped; continue; }
      if (escaped === 'b') { out += '\b'; continue; }
      if (escaped === 'f') { out += '\f'; continue; }
      if (escaped === 'n') { out += '\n'; continue; }
      if (escaped === 'r') { out += '\r'; continue; }
      if (escaped === 't') { out += '\t'; continue; }
      if (escaped !== 'u' || !/^[0-9a-fA-F]{4}$/.test(source.slice(at, at + 4))) throw new Error('escape');
      let code = Number.parseInt(source.slice(at, at + 4), 16); at += 4;
      if (code >= 0xDC00 && code <= 0xDFFF) throw new Error('surrogate');
      if (code >= 0xD800 && code <= 0xDBFF) {
        if (source.slice(at, at + 2) !== '\\u' || !/^[0-9a-fA-F]{4}$/.test(source.slice(at + 2, at + 6))) throw new Error('surrogate');
        const low = Number.parseInt(source.slice(at + 2, at + 6), 16);
        if (low < 0xDC00 || low > 0xDFFF) throw new Error('surrogate');
        at += 6; code = 0x10000 + ((code - 0xD800) << 10) + low - 0xDC00;
      }
      out += String.fromCodePoint(code);
    }
    throw new Error('string');
  };
  const number = () => {
    const match = source.slice(at).match(/^-?(?:0|[1-9][0-9]*)/);
    if (!match || /[.eE]/.test(source[at + match[0].length] || '')) throw new Error('number');
    at += match[0].length;
    const result = Number(match[0]);
    if (!Number.isSafeInteger(result) || Object.is(result, -0)) throw new Error('number');
    return result;
  };
  const result = value(); skip();
  if (at !== source.length) throw new Error('trailing');
  return result;
}

function canonicalJcs(value) {
  if (value === null || typeof value === 'boolean') return String(value);
  if (typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number' && Number.isSafeInteger(value)) return String(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJcs).join(',')}]`;
  if (plainObject(value)) return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJcs(value[key])}`).join(',')}}`;
  throw new Error('jcs');
}

function asUtf8(value) {
  if (typeof value === 'string') return encoder.encode(value);
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  fail(CODES.SIGNATURE);
}

function decodeB64url(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]*$/.test(value) || value.length % 4 === 1) throw new Error('b64');
  const binary = atob(value.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - value.length % 4) % 4));
  const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
  if (encodeB64url(bytes) !== value) throw new Error('b64');
  return bytes;
}

function encodeB64url(bytes) {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

async function sha256Hex(bytes) {
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

function requireExactKeys(value, names) {
  if (!plainObject(value)) throw new Error('object');
  const actual = Object.keys(value).sort();
  const expected = [...names].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) throw new Error('keys');
}
function plainObject(value) { return !!value && typeof value === 'object' && !Array.isArray(value); }
function id(value) { return typeof value === 'string' && ID_RE.test(value); }
function text(value, max) {
  if (typeof value !== 'string' || value.length < 1 || value.length > max || /[\u0000-\u001F]/.test(value)) return false;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xD800 && code <= 0xDBFF) {
      const low = value.charCodeAt(index + 1);
      if (low < 0xDC00 || low > 0xDFFF) return false;
      index += 1;
    } else if (code >= 0xDC00 && code <= 0xDFFF) {
      return false;
    }
  }
  return true;
}
function positive(value) { return Number.isSafeInteger(value) && value > 0; }
function isSha256(value) { return typeof value === 'string' && SHA256_RE.test(value); }
function rfc3339(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(value)) return false;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString().replace('.000Z', 'Z') === value;
}
function stringList(value, predicate) { return Array.isArray(value) && value.length <= 256 && value.every((item) => typeof item === 'string' && predicate(item)); }
function bytesEqual(a, b) { return a.length === b.length && a.every((byte, index) => byte === b[index]); }
function constantTimeEqual(a, b) { return typeof a === 'string' && typeof b === 'string' && a.length === b.length && [...a].reduce((out, char, index) => out | (char.charCodeAt(0) ^ b.charCodeAt(index)), 0) === 0; }
function fail(code) { const err = new Error(); err.code = code; throw err; }
function knownCode(code) { return Object.values(CODES).includes(code) ? code : CODES.SIGNATURE; }
function nextChannelWatermarks(previous, channel, value) {
  const next = plainObject(previous) ? { ...previous } : {};
  next[channel] = value;
  return next;
}
