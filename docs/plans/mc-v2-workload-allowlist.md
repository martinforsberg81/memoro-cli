# mc V2 S0 — workload transport allowlist

**Status:** normative, fail-closed baseline · 2026-07-26 · **not approved for
credential-bearing runtime**

This is the complete public workload transport allowlist for the currently
implemented cloud runtime. A method, path, schema version, or size limit that
is not explicitly listed here is denied. It does not create an authority to
materialise, register, deliver, relay, or inspect credentials.

The list is deliberately narrower than the V2 target. It is governed by the
trust boundary in [mc-contract.md](mc-contract.md), the credential boundary in
[mc-v2-credential-boundary.md](mc-v2-credential-boundary.md), and the
release/platform gate in [mc-v2-release-trust.md](mc-v2-release-trust.md).

## Mandatory binding on every enabled row

Every workload token must be server-issued, short-lived, and carry one binding
whose values all agree with the request and the active CloudSession record:

| Binding | Required value and check |
|---|---|
| Account | The authenticated API-token user id. It is never accepted from a workload body or query string, and must equal the CloudSession owner. |
| Source | `source_id`; for a cloud runtime this is the bound source, normally `cloud:<cloud_session_id>`. |
| Cloud session | `cloud_session_id`, equal to the path/query session id. |
| Coding session | `coding_session_id`, present in the token binding and equal to the CloudSession record. |
| Runtime generation | `runtime_generation`, matching the binding and the currently active CloudSession generation. |
| Authorization digest | `authorization_digest`, matching the binding and the currently active CloudSession digest. |
| Audience | API-token `audience`, exactly equal to `cloud_session_id`. |

The current runtime status and snapshot endpoints carry generation and digest
in `X-MC-Runtime-Generation` and `X-MC-Authorization-Digest`. Cloud broker
bootstrap does not put either value in a URL: the authenticated ticket-mint
request supplies them as those headers and the server binds the resulting
single-use ticket to the active CloudSession record. Binding validation must
not be replaced by a broad `sessions.write`, `full`, path-prefix, or generic
`/api/mc` authorization.

## Enabled, credential-blind transport only

| Capability | Exact scope, method, and path | On-wire contract | Implemented size limit | Required binding |
|---|---|---|---|---|
| Runtime status | `mc.cloud` · `POST` `/api/mc/cloud-sessions/:cloud_session_id/runtime-status` | JSON body. The runtime producer emits `contract_version: "mc-cloud-runtime-v1"`; the server does **not** require or version-check that field, so there is no enforced request schema version. Response schema has no version. | Request: `MAX_RUNTIME_STATUS_BODY_BYTES = 8192` bytes. Response: no explicit maximum. | All bindings above; session id is the path parameter, generation/digest are the required headers. |
| Snapshot upload | `mc.cloud` · `PUT` `/api/mc/cloud-sessions/:cloud_session_id/coding-bin-snapshots/:snapshot_id/payload` | Opaque `application/zstd` payload, with `Content-Length`, `X-MC-Snapshot-File-Count`, `X-MC-Snapshot-Base-Ref`, and `X-MC-Snapshot-Head-Ref`; optional `X-MC-Snapshot-Skipped-Count`. No versioned payload schema is enforced. | Request: non-empty and at most `MAX_CODING_BIN_SNAPSHOT_PAYLOAD_BYTES = 64 * 1024 * 1024` bytes (64 MiB); at most `MAX_CODING_BIN_SNAPSHOT_FILES = 5000` files. Response: no explicit maximum. | All bindings above; session and snapshot ids are path parameters, generation/digest are the required headers. |
| Snapshot download | `mc.cloud` · `GET` `/api/mc/cloud-sessions/:cloud_session_id/coding-bin-snapshots/:snapshot_id/payload` | Stored `application/zstd` snapshot payload. No versioned response schema is enforced. | The object could only have been uploaded under the 64 MiB PUT limit, but GET has no independent response-size guard. | All bindings above; session and snapshot ids are path parameters, generation/digest are the required headers. |
| Broker ticket mint | `mc.cloud.broker` · `POST` `/api/mc/cloud-sessions/:cloud_session_id/broker-ticket` | Authorization bearer in the request header; JSON body exactly `protocol_version: "mc-broker-bootstrap-v1"`, `machine_id`, `source_id`, `source_kind`, `source_name`, `cloud_session_id`, and `coding_session_id`. `X-MC-Runtime-Generation` and `X-MC-Authorization-Digest` are required headers. The server checks them against the active session and mints an opaque, single-use route ticket. | JSON body: at most 1024 bytes. Response: no independently enforced maximum. | All bindings above; session id in path/body, generation/digest in headers, and coding session in body/token binding. |
| Broker control upgrade | `mc.cloud.broker` · `GET` `/api/mc/broker/ws` (WebSocket upgrade) | Queryless and bearerless. `Sec-WebSocket-Protocol` contains exactly `mc-broker-v1` and `mc-bootstrap-v1.<ticket>`; the ticket is base64url without padding and at most 512 characters. The server decrypts its opaque routing envelope and atomically consumes its stored hash before accepting. Control frames use `mc-broker-control-v1`; malformed frames, absent/unknown types, or a version mismatch fail closed. | Ticket: 512 characters. Inbound and outbound control frames: 64 KiB each. | The consumed ticket supplies the server-side binding; no client-controlled session, generation, digest, or reusable bearer appears in the URL. |

`mc.cloud` and `mc.cloud.broker` are exact internal workload scopes. They are
not interchangeable with `sessions.write`, `full`, browser, admin, vault,
`/api/sessions`, `/api/lens`, or general `/api/mc` access.

The local broker keeps its established, separate upgrade contract, including
its query-token and source-identity handling. It is not a cloud workload route,
does not use `mc.cloud.broker`, and must not be conflated with the cloud ticket
transport above.

## Explicitly disabled: no route, no fallback

| Capability | State |
|---|---|
| Recipient registration | **Disabled.** No public workload route exists. It stays disabled until the release/platform verifier and recipient-containment evidence required by [mc-v2-release-trust.md](mc-v2-release-trust.md) are accepted. |
| Custody grant delivery or unwrap | **Disabled.** No public workload route exists. It stays disabled until recipient registration, grant verification, and the custody proof obligations are implemented and accepted. |
| Any other workload transport | **Disabled.** There is no generic context, token, secret, proxy, or capability-read route. A new route needs an explicit contract revision, allowlist row, exact schema and bidirectional size limits, and binding tests. |

## Blocking gaps and non-approval

This document is a denial baseline, not a credential-runtime launch approval.
Credential-bearing managed runtime is blocked until at least all of the
following are closed and independently verified:

- **Cloud broker bootstrap is bounded and one-time, but is not credential
  authority.** Its opaque AES-GCM routing ticket, atomic consume, queryless
  upgrade, version check, and 64 KiB frame limit close the earlier cloud
  URL-bearer, replay, and unbounded/versionless-control gaps. This does not
  certify a recipient, grant, credential domain, or release identity.
- **Several response contracts are unbounded or unversioned.** Runtime-status
  and snapshot responses have no independently enforced response-size cap; the
  status and snapshot payload schemas are not receiver-versioned.
- **Recipient and grant paths do not exist.** They must remain no-route until
  release, platform, and recipient control is present.
- **The runtime still has S0 integration gaps.** Provider startup precedes
  recipient registration, no recipient/grant routes exist, the attach token is
  still carried in a control payload and URL, and Cloudflare same-sandbox
  execution is not a credential boundary. Production release inputs, artifact
  verification, and external platform attestation are also absent.

Until those gaps are closed, only the credential-blind status, snapshot, and
broker-bootstrap mechanics described above may be tested. They must not carry
provider credentials, custody material, decryptable grants, or any reusable
secret.
