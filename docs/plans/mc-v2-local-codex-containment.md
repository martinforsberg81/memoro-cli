# Local Codex managed credential containment

**Status:** implemented candidate for the local Codex S2 slice; the real
two-generation containment harness passes on macOS with Codex 0.145.0. This is
not the complete S2 local golden path.

## Compatibility contract

Bare `mc`, `mc wrap`, and ordinary `mc new/open/resume` remain on the existing
native, host-owned path. Existing Codex auth, worktrees, registries, and native
session IDs are not migrated or relabelled. Managed startup is explicit through
`--managed-portable`, supports Codex only, and never falls back to native.

`--managed-portable --no-launch` may create or select a worktree without
opening custody. Credential custody is opened only at the final launch
preflight, after the exact provider release and the hostile OS-boundary probe
have passed.

## Implemented topology

The managed launch owner performs these steps in order:

1. Resolve the native Codex executable behind the package launcher.
2. Require macOS arm64, Codex 0.145.0, `Identifier=codex`, OpenAI Team ID
   `2DC432GLL2`, and the pinned binary SHA-256. The pin was derived from
   OpenAI's official `rust-v0.145.0`
   `codex-package-aarch64-apple-darwin.tar.gz`, whose release-manifest SHA-256
   is also recorded in code. The official binary's embedded signature metadata
   is inspected, but macOS `codesign --verify` is not claimed: the official
   release asset itself fails that command, so the official checksum chain is
   the artifact trust anchor.
3. Create private per-session credential and executor generations beneath
   `MC_HOME`, with directories at `0700` and credential files at `0600`.
4. Render a private `CODEX_HOME` with a named permission profile. The profile
   grants only minimal system runtime reads and workspace writes, denies the
   rest of the filesystem, disables command network and Unix-socket access,
   inherits no shell environment, and disables browser, apps, hooks, remote
   plugins, image generation, multi-agent, shell snapshots, and package
   installation features.
5. Verify and compile a pinned native hostile probe before custody is opened.
   An unsandboxed negative control must first prove that the exact binary can
   see the canary and invoke the installed `mc vault` surface both through its
   bin entry and through `node <real-entry>`. The exact-schema sandbox report
   must then show that all credential, environment/parent, socket, network,
   vault, and Keychain attempts fail while workspace writes still work.
6. Only after that probe passes, decrypt the existing `tool-auth:codex`
   envelope in trusted custody and write Codex `auth.json` inside the denied
   credential domain.
7. Send the broker a strict metadata-only descriptor and allowlisted provider
   environment. The Memoro token, vault key/passphrase, Codex auth bytes, and
   sidecar authority are absent from the complete broker launch message.
8. The broker revalidates the exact manifest schema, ownership and modes,
   symlink-free paths, manifest digest, Codex binary digest, signature
   metadata, Team ID, and version. It replaces rather than extends the
   inherited environment and accepts only a fresh launch or
   `resume <safe-provider-id>`.
9. A per-session exclusive lease serializes credential generations. On
   provider exit, refresh the same custody record, positively verify removal
   of both domain trees, and only then release the lease. Persist or cleanup
   failure quarantines the generation and blocks replacement. Launch failure
   aborts and verifies cleanup without a native fallback.

The trusted Codex provider process can read its private auth file in order to
authenticate with the provider. Model-directed commands run under the separate
Codex permission profile and cannot read that file, the host Keychain, Memoro
state, the full installed `mc` dispatcher, peer sockets, or network.

## Fail-closed properties

- Managed launch cannot reuse an existing native broker PTY.
- A stale v2 broker is rejected through broker protocol v3.
- Unsupported tools, platforms, Codex versions, signature metadata, artifact
  digests, manifests, modes, paths, argv, or boundary results fail before
  provider launch.
- Boundary failure occurs before custody is opened and leaves no credential
  files.
- Managed resume never attaches to an existing local PTY. It accepts a
  provider ID only when the registry also carries the exact managed-adapter
  origin and generation; native or unmarked IDs become a fresh grounded launch
  on the same Memoro coding session without scanning host Codex state.
- The LLM-visible `mc` executable is a restricted shim. The real installed
  `mc` package is outside the model-readable filesystem.
- Public status and launch results contain readiness metadata, never auth
  bytes, encrypted roots, vault keys, or reusable bearer tokens.

## Validation record

The real harness runs two fresh generations and verifies replacement and
teardown between them. On macOS with `codex-cli 0.145.0`, both generations
reported:

- credential file readable: false;
- canary in environment, argv, or parent process: false;
- credential socket reachable: false;
- external network reachable: false;
- workspace write blocked: false;
- installed `mc vault` bin and `node <real-entry>` surfaces callable: false;
- Memoro Keychain credential readable: false;
- canary in stdout/stderr: false;
- credential domain, socket, and temporary generation removed: true.

Unit/integration coverage additionally pins release verification, descriptor
schema and permissions, binary substitution rejection, environment
replacement, complete broker-message blindness, boundary-before-custody
ordering, custody decrypt/refresh of the same record, managed conflict
rejection, lifecycle propagation, and native compatibility.

An exact production preflight also passed with the installed pinned Codex
release, the real native boundary probe, a synthetic test-only auth envelope,
provider-broker resolution, and verified abort cleanup. The final targeted
suite passed 177/177 tests. The broader repository suite passed 1,786 tests
with 9 skips and retained 2 pre-existing failures in the unchanged development
lifecycle tests.

## Deliberate limitations of this slice

- It is local macOS arm64 Codex containment only. Claude, macOS x64, Linux,
  Windows, and cloud recipients require their own pinned release and proven
  boundary/provider adapter.
- Managed command execution currently exposes only the minimal system
  toolchain. Homebrew/Node is deliberately not model-readable because it also
  contains the installed full `mc` package. A later typed toolchain adapter
  must restore broader development commands without reopening custody.
- Managed sidecars, GitHub capability bootstrap, repo dev-environment
  injection, Cloudflare guards, and remote attach are disabled. They require
  typed, credential-blind adapters before re-entry.
- Broker-crash recovery is fail-closed, not automatic: an orphaned lease or a
  failed custody refresh/cleanup leaves that managed session quarantined and
  blocks replacement. A later trusted supervisor must add verified recovery.
- The current custody API has no cross-device revision/CAS fence. The local
  lease prevents overlapping generations on this host, but portable concurrent
  refresh remains outside this increment and must be solved before the
  multi-device golden path is certified.
- This does not implement account-environment reconciliation, tool install,
  private checkout, cross-device registry projection, user-signed grants, or
  the cloud recipient. Those remain in later S2/S3 work.
- Running managed mode while the `memoro-cli` source itself is the writable
  workspace must fail the hostile vault-surface probe. Native development
  remains available.

The complete S2 gate remains the clean-second-device golden path and its full
adversarial suite in `mc-v2-cloud.md`.
