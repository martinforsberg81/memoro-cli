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

The current runtime endpoints carry generation and digest in
`X-MC-Runtime-Generation` and `X-MC-Authorization-Digest`. The broker carries
them as query parameters during its WebSocket upgrade. Binding validation must
not be replaced by a broad `sessions.write`, `full`, path-prefix, or generic
`/api/mc` authorization.

## Enabled, credential-blind transport only

| Capability | Exact scope, method, and path | On-wire contract | Implemented size limit | Required binding |
|---|---|---|---|---|
| Runtime status | `mc.cloud` · `POST` `/api/mc/cloud-sessions/:cloud_session_id/runtime-status` | JSON body. The runtime producer emits `contract_version: "mc-cloud-runtime-v1"`; the server does **not** require or version-check that field, so there is no enforced request schema version. Response schema has no version. | Request: `MAX_RUNTIME_STATUS_BODY_BYTES = 8192` bytes. Response: no explicit maximum. | All bindings above; session id is the path parameter, generation/digest are the required headers. |
| Snapshot upload | `mc.cloud` · `PUT` `/api/mc/cloud-sessions/:cloud_session_id/coding-bin-snapshots/:snapshot_id/payload` | Opaque `application/zstd` payload, with `Content-Length`, `X-MC-Snapshot-File-Count`, `X-MC-Snapshot-Base-Ref`, and `X-MC-Snapshot-Head-Ref`; optional `X-MC-Snapshot-Skipped-Count`. No versioned payload schema is enforced. | Request: non-empty and at most `MAX_CODING_BIN_SNAPSHOT_PAYLOAD_BYTES = 64 * 1024 * 1024` bytes (64 MiB); at most `MAX_CODING_BIN_SNAPSHOT_FILES = 5000` files. Response: no explicit maximum. | All bindings above; session and snapshot ids are path parameters, generation/digest are the required headers. |
| Snapshot download | `mc.cloud` · `GET` `/api/mc/cloud-sessions/:cloud_session_id/coding-bin-snapshots/:snapshot_id/payload` | Stored `application/zstd` snapshot payload. No versioned response schema is enforced. | The object could only have been uploaded under the 64 MiB PUT limit, but GET has no independent response-size guard. | All bindings above; session and snapshot ids are path parameters, generation/digest are the required headers. |
| Broker bootstrap | `mc.cloud.broker` · `GET` `/api/mc/broker/ws` (WebSocket upgrade) | Current upgrade accepts the bearer through `?token=` and requires `source_id`, `cloud_session_id`, `runtime_generation`, and `authorization_digest` as query parameters. There is no versioned WebSocket message schema. | No implemented maximum for either WebSocket request or response messages. | All bindings above; the query values must match the binding. `coding_session_id` is binding-only and forwarded internally as `bound_coding_session_id`. |

`mc.cloud` and `mc.cloud.broker` are exact internal workload scopes. They are
not interchangeable with `sessions.write`, `full`, browser, admin, vault,
`/api/sessions`, `/api/lens`, or general `/api/mc` access.

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

- **Broker revocation is non-atomic.** The edge worker reads the active
  generation/digest from the CloudSession Durable Object before it opens a
  socket in the separate broker Durable Object. Revocation can occur in that
  interval, and existing broker sockets are not tagged and re-checked with the
  runtime generation/digest. This is a TOCTOU/socket gap.
- **The broker bearer is currently placed in a URL query.** `?token=` can reach
  request, access, and error telemetry. It is forbidden for credential-bearing
  runtime. A future broker bootstrap must use TLS-authenticated header-based
  authentication with a single-use opaque ticket and atomic consume (or an
  equivalent transport that never puts reusable authority in a URL). The ticket
  must bind runtime generation and authorization digest, and it may not expand
  the route surface without a new allowlist row.
- **The broker wire contract is unbounded and unversioned.** There is no
  implemented WebSocket message-size limit or version-checked message schema.
- **Several response contracts are unbounded or unversioned.** Runtime-status
  and snapshot responses have no independently enforced response-size cap; the
  status and snapshot payload schemas are not receiver-versioned.
- **Recipient and grant paths do not exist.** They must remain no-route until
  release, platform, and recipient control is present.

Until those gaps are closed, only the credential-blind status, snapshot, and
broker-bootstrap mechanics described above may be tested. They must not carry
provider credentials, custody material, decryptable grants, or any reusable
secret.
