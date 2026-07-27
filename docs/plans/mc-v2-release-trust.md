# mc V2 S0 — release and platform trust contract

**Status:** partial fail-closed verifier and startup gates · 2026-07-26. The
pure verifier and pre-token CLI/server gates exist, but trusted production
inputs, installed-byte verification, platform attestation and rotation remain
unavailable; credential-bearing startup therefore still fails closed.

The current supervisor still starts the provider before the broker recipient
registration. Reordering that sequence to recipient-before-provider is a
separate required S0 integration step; this scaffold does not claim to close it.

This is the fail-closed trust contract for a cloud recipient key, custody grant,
and model launch. It complements
[mc-v2-credential-boundary.md](mc-v2-credential-boundary.md): an OS boundary is
insufficient if the image, broker, or trusted adapter can be substituted.

The pure release-verifier contract and pre-token gates are implemented in the
CLI and server startup paths. They fail closed when genuine trusted platform
inputs are unavailable, and do not make a runtime self-report trustworthy.
The production trust bundle and its pinned delivery, signed release manifest
delivery, installed-artifact-byte verification, platform-attestation
integration, and signer rotation/revocation path are not live. S0 is therefore
not passed; credential-bearing managed cloud startup must remain fail closed.

## 1. Required security properties

Before recipient registration, the launcher must establish all of the following:

- every executable artifact matches a signed immutable identity;
- the release, signer, channel, epoch, and expiry are acceptable under a
  separately pinned trust bundle;
- revocation and emergency policy are current; and
- the control plane or platform, never the runtime, supplies the sandbox and
  image identity.

A runtime-reported version, image name, environment variable, file, log, or
workload token is never evidence of release/platform identity.

## 2. Standard encoding and signatures

This contract uses no bespoke cryptographic framing:

- payload source documents are parsed as I-JSON and canonicalized with JSON
  Canonicalization Scheme, RFC 8785;
- signatures use JWS General JSON Serialization, RFC 7515, with EdDSA as
  specified by RFC 8037 and Ed25519 keys from RFC 8032; and
- normal RFC 7515 payload encoding is used: the JWS payload member and signing
  input contain BASE64URL(UTF-8 JCS bytes). RFC 7797 unencoded payloads are not
  used.

Every protected header uses alg EdDSA, a known pinned kid, and a document-specific
typ. The verifier rejects algorithm fallback, none, symmetric algorithms, remote
key URLs, and untrusted embedded JWKs. General serialization is used for all
documents so normal rotation and recovery can require multiple signatures
without a wire-format change.

## 3. Canonical release manifest

Before canonicalization the parser rejects malformed UTF-8, duplicate object
names at every depth, non-I-JSON values, and numbers or strings that cannot be
represented by RFC 8785. It then requires schema mc-release-manifest/v1, a
release ID, positive
monotonic release_epoch, allowlisted channel (stable, candidate, or emergency),
RFC3339 UTC issued_at and expires_at, artifacts, and platform_policy. Unknown
security-relevant fields are rejected. New credential-bearing startup fails if
trustworthy time is unavailable or the manifest is expired.

Each enabled artifact descriptor is mandatory. The JWS signature binds the full
descriptor; no descriptor may be fetched, replaced, or interpreted outside that
signed payload.

| Artifact | Mandatory immutable identity |
|---|---|
| Sandbox image | OCI repository, sha256 image digest, platform/architecture, and release-signature binding. Tags are descriptive only. |
| memoro-cli | Exact source commit, package version, archive/content SHA-256, repository identity, and release-signature binding. |
| Codex | Exact package version, npm dist.integrity (SRI SHA-512), dist.shasum, package name, and release-signature binding. Ranges, latest, and unverified global installs are forbidden. |
| Claude Code | Exact package version, npm dist.integrity (SRI SHA-512), dist.shasum, package name, and release-signature binding. Ranges, latest, and unverified global installs are forbidden. |
| Trusted adapter | Stable adapter ID, exact version, content SHA-256, signer/key ID, and release-signature binding. An absent adapter is disabled. |

The installer verifies downloaded bytes against the signed descriptor before use,
then verifies the installed package/binary version and digest. When an upstream
artifact signature exists, verify it under a separately pinned upstream root as
an additional check; it never replaces the Memoro release signature. Missing
descriptors, ambiguous resolution, unsigned adapters, unsupported architecture,
or any byte/version mismatch are fatal.

## 4. Independently pinned trust bundle

The verifier image contains a separately pinned mc-release-trust-bundle/v1,
identified by an immutable digest in its own release configuration. It is not
downloaded from the same unverified endpoint as a release manifest. The bundle
contains:

- active Ed25519 release public keys and kid values;
- minimum accepted release epoch per channel and minimum trust-bundle epoch;
- allowed document types, algorithms, artifact identities, and maximum validity;
- signer status (active, retiring, revoked), overlap windows, and recovery
  quorum policy; and
- the current signed revocation/kill-switch record identity and minimum
  revocation epoch.

The bootstrap configuration pins that bundle digest and the offline recovery
public-key fingerprints independently of normal release-manifest delivery. No
manifest is permitted to replace the bundle or its bootstrap roots.

A host persists the highest accepted release, bundle, and revocation epochs per
channel and never lowers them. A clean host bootstraps the first bundle only from
its image or a separately authenticated channel whose digest is pinned by that
image. Otherwise it does not register a recipient.

### Rotation, emergency revocation, and rollback

A normal higher-epoch bundle rotation needs signatures from both an active
current signer and the incoming signer, proving possession before activation.
Retiring keys are valid only during their declared overlap window.

Emergency signer replacement, artifact revocation, and a credential-grant kill
switch use a higher-epoch signed revocation record. They require the configured
offline recovery quorum: at least two distinct recovery Ed25519 keys in the JWS
General serialization. No single online release signer can silently replace the
root. Before recipient registration and grant consumption, the verifier checks
that record. An active kill switch blocks new starts and grants, fences pending
delivery, and asks the external control plane to destroy the runtime.

Rollback is never acceptance of an older epoch. Recovery publishes a new,
higher-epoch manifest naming a previously known-good immutable artifact set. If
a bad release is running, platform/control-plane teardown plus the signed kill
switch fence it; a runtime cannot attest to its own cleanup.

## 5. Platform-derived sandbox identity

Through a documented platform/control-plane API, the trusted launcher obtains
the sandbox instance ID, immutable image digest, runtime generation, workload
identity, and creation timestamp. It compares those facts to the accepted
manifest and pending session before the protected broker consumes its single-use
registration challenge.

The broker starts before any model-directed process and registers only its
public recipient key. Registration binds the external instance and image facts,
cloud session, coding session, runtime generation, account, release-manifest
digest, and broker public-key digest. The workload identity and registration
channel are outside the LLM domain. A self-reported digest or any sandbox file
cannot satisfy this check.

If the platform cannot supply enforceable, externally derived image and instance
identity, that host is unsupported for custody grants.

## 6. Mandatory verification order

For every new local credential domain or cloud runtime:

1. Load the separately pinned trust bundle and persisted epoch watermarks.
2. Fetch candidate trust, revocation, and release records as opaque bytes.
   Verify JCS/JWS schema, protected headers, signatures, signer status, epoch,
   channel, and expiry using only the accepted bundle.
3. Atomically apply an accepted higher-epoch rotation/revocation record. Reject
   any revoked signer/artifact/channel or active kill switch.
4. Verify every required artifact's provenance, exact bytes, installed version,
   and digest before execution. Verify the sandbox image/release pair before
   broker start.
5. Obtain platform/control-plane-derived sandbox facts and reject a mismatch
   with manifest, session, or runtime generation.
6. Start the protected broker, consume the challenge once, and lock recipient
   registration to those verified facts.
7. Only then accept the canonical user-authorized JWE grant commitment and
   deliver it to the broker.
8. Start the model-directed executor only after release verification, broker,
   isolation topology, and typed capabilities are ready.

Sleep, replacement, and wake repeat this sequence with a new generation,
platform identity, recipient key, and user authorization.

## 7. Stable fail-closed errors

Public readiness, audit, and browser surfaces expose only sanitised metadata and
these stable codes:

| Code | Meaning |
|---|---|
| release_trust_bundle_invalid | Bundle cannot be decoded, is below watermark, or violates policy. |
| release_signature_invalid | JWS, JCS, signer, or protected-header validation failed. |
| release_manifest_invalid | Schema, channel, expiry, or artifact descriptor is invalid. |
| release_epoch_rejected | Manifest, bundle, or revocation epoch is stale or rolled back. |
| release_artifact_mismatch | Downloaded, installed, or image identity differs from the manifest. |
| release_signer_revoked | Signer/artifact is revoked or a rotation window has closed. |
| release_kill_switch_active | Signed emergency policy blocks startup or grant delivery. |
| platform_identity_unavailable | Platform/control plane cannot provide external identity evidence. |
| platform_identity_mismatch | Instance, image, generation, workload, or session differs from request. |
| recipient_registration_blocked | A preceding trust check blocks challenge consumption/key registration. |

## 8. S0 gate

This is an implementation contract, not evidence of deployed controls. The
implemented gates are necessary but insufficient: S0 remains in-flight until
the genuine trust-bundle delivery, signed release inputs, installed-artifact
checks, platform identity integration, rotation/revocation, recipient/grant
routes and ordering, and adversarial tests on production-equivalent hosts are
complete. The current supervisor still starts the provider before recipient
registration, and Cloudflare same-sandbox execution does not supply the
required credential boundary. Until that work is complete, no credential-
bearing managed cloud session may register a recipient, receive a custody grant,
or launch a model-directed executor.
