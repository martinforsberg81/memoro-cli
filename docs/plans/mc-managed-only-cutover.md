# MC managed-only cutover

**Status:** in-flight

## Outcome

Every coding-tool process started by `mc` uses vault-backed, session-isolated
credential custody. Native host-owned provider authentication is not a launch
mode, fallback, configuration choice, or compatibility escape hatch after the
cutover.

The cutover happens only after the managed path has the functionality and
recovery guarantees required for ordinary use. Until then, native launch
remains available solely as the installed compatibility path; it must not be
mistaken for the target architecture.

## Scope

- Make managed custody the only local launch topology for `mc new`, `mc open`,
  `mc resume`, bare `mc`, and `mc wrap`.
- Preserve the exact `coding_session_id`, provider-native conversation, and
  worktree across terminal loss, client timeout, broker restart, provider exit,
  custody persistence, cleanup interruption, and provider handoff.
- Support every coding tool that remains selectable through `mc tool-switch`
  with a pinned provider release, a proven OS credential boundary, and a
  vault-backed `tool-auth:<tool>` custody record.
- Keep the lifecycle core tool-agnostic. A central managed-provider contract
  routes one registered adapter per supported tool; core journal, broker,
  recovery, GitHub, and handoff code may not enumerate provider names.
- Expose the Memoro GitHub App through the existing typed, token-free
  session capability without placing GitHub credentials or installation
  authority in the coding-tool process.
- Keep ordinary development capabilities available while denying only
  provider credentials, Memoro credentials, vault custody, credential-domain
  authority, and their backing paths.
- Remove the `--managed-portable` opt-in and the native auth branch only after
  the complete managed contract is green locally and in live end-to-end checks.

## Non-goals

- Do not inject generic vault plaintext into a worktree, environment, argv,
  transcript, log, broker message, or model-readable file.
- Do not use provider-native credential files from the host as a fallback.
- Do not retain a hidden flag that bypasses managed custody.
- Do not enable a provider on an unverified platform or release.
- Do not cut over one command while another `mc` launch surface can still
  create a native provider process.

## Required invariants

1. The trusted custody owner selects one exact `tool-auth:<tool>` record.
2. Provider auth is available only to the pinned provider process in its
   private credential domain.
3. Model-directed commands cannot read provider auth, the Memoro Keychain,
   vault state, custody IPC, or another session's credential domain.
4. Broker and launch messages contain only strict metadata and allowlisted,
   value-free capability descriptors.
5. GitHub operations cross the session boundary as `github-op-v1`; no GitHub
   token or installation authority reaches the provider process.
6. Provider handoff commits one durable source cursor and one target
   generation; interruption never replays a user turn or starts an unbound
   provider conversation.
7. Lifecycle recovery is driven by the append-only managed generation journal,
   never inferred from a mutable registry field or host-process liveness alone.
8. Any missing proof fails closed without native fallback.
9. A provider is selectable only when one complete managed adapter supplies
   release verification, credential custody, launch/resume, provider artifact,
   archival, recovery, and cleanup. Planned or partial adapters are not launch
   targets.
10. OAuth refresh is owned by the trusted host side of the adapter. A stable
    provider-visible sentinel may cross the executor boundary, but access and
    refresh tokens, refresh IPC, and writable credential files may not.

## Central adapter boundary

The managed-provider registry is the only launch registry after cutover. Its
strict contract composes every provider-owned operation for one tool:

- release and platform verification;
- vault record selection and credential-domain preparation;
- interactive launch and native resume arguments;
- provider-native session artifact capture and validation;
- durable archive, crash recovery, and terminal cleanup;
- credential-boundary evidence and refresh ownership.

Core code may route by lifecycle state or custody mode, but never by provider
name. The temporary native compatibility artifact registry exists only until
the managed-only cutover and is not evidence that a provider has a complete
managed adapter.

For the pinned Claude release, the target refresh topology is a long-lived
trusted wrapper plus the pinned sandbox runtime. Claude receives one stable
sentinel through an anonymous token file descriptor; the wrapper refreshes the
real OAuth grant before expiry, durably persists a rotated refresh token, and
updates the existing sentinel mapping in host memory. No host credential file
or model-callable refresh channel is part of this topology.

## Ordered delivery

1. Finish and validate the managed generation journal, idempotent finalization,
   and automatic `mc open` reconciliation.
2. Install the typed GitHub shim and socket capability inside the managed
   executor boundary, with the socket and shim explicitly allowed but all
   credentials still denied.
3. Introduce the central managed-provider adapter contract and move the
   existing Codex implementation behind it without changing its security
   properties.
4. Turn the existing Claude C1 proof into a normal managed Claude adapter,
   then add other supported tools such as Gemini exclusively through the same
   contract.
5. Route provider handoff through the same managed transaction for every
   supported source/target pair.
6. Change all local launch intent defaults to managed, remove native branches
   and `--managed-portable`, and reject unsupported providers before custody.
7. Package and install only after the unit, integration, crash-matrix,
   credential-boundary, GitHub, provider-handoff, and live multi-generation
   suites pass.

## Current implementation state

- Named lifecycle launches (`mc new`, `mc open`, and `mc resume`) now select
  managed custody by default. The former `--managed-portable` spelling remains
  accepted as a compatibility no-op, but it is no longer required or shown in
  lifecycle usage. Bare `mc` and `mc wrap` remain on their explicitly tracked
  compatibility path until that separate launch surface is cut over.
- The central strict registry now contains complete Codex and Claude Code
  adapters. Gemini remains unregistered and therefore cannot be selected as a
  managed launch target.
- The lifecycle journal, credential-domain ownership, provider-artifact
  validation, archive/recovery, readiness, cleanup, and provider handoff route
  by the central adapter contract. Managed handoff binds both source proof and
  target custody to one authenticated transaction; no private transcript path
  crosses that boundary.
- Native provider conditionals remain only in the explicitly temporary native
  compatibility branch. Managed launches skip native hooks, cloud-provider
  login preparation, local credential discovery, and native retry/guard paths.
- Provider transcript publication and resume restoration use one
  provider-agnostic immutable archive core; adapters supply only their verified
  provider root and broker-owned native artifact.
- Managed Claude uses the pinned Claude/SRT artifacts, an isolated
  `CLAUDE_CONFIG_DIR`, a source-closed trusted runtime host, a C1 receipt bound
  to the exact source/artifact/OS substrate, and a stable sentinel delivered
  once through anonymous FD 3.
- Claude access and refresh tokens remain in trusted host custody. Refresh
  rotation is protected by the distributed vault lease and revision CAS, and
  SRT remapping happens only after the rotated grant is durably persisted.
- Broker protocol v12 requires both the managed journal/half-open transport
  contract and an exact process-bound runtime identity. The identity covers
  the mc runtime source tree, package metadata/lock, and Node runtime and is
  fixed when the daemon starts. An empty stale host is replaced automatically;
  a stale host with a live PTY remains protected from automatic replacement.
  An incompatible host that retains only broker-confirmed terminal rows removes
  those exact rows under controller authority, verifies an empty inventory, and
  only then replaces the host.
- Session presence is owned by the central broker lifecycle rather than a
  provider adapter or the optional GitHub capability. Managed launch messages
  carry only strict, non-secret presence metadata. The trusted broker reads the
  Memoro device identity from local custody for the HTTP operation; no Memoro
  token or API URL crosses the launch message, provider environment, worktree,
  or transcript.
- Managed open keeps the locally observed runtime generation separate from the
  provider archive/custody generation. A stale server row can be terminalized
  only from positive local exit proof for that exact generation (or a
  generation-less legacy row); a different server generation always fails
  closed.
- A fresh managed Codex `CODEX_HOME` records the exact workspace as
  `untrusted`. This suppresses Codex's interactive trust onboarding without
  enabling repo-local config or hooks, so broker-delivered startup grounding
  cannot accidentally answer the onboarding prompt.
- The generated, hash-bound Codex provider-artifact hook has a seven-second
  provider deadline and its local bridge waits up to five seconds for the
  artifact plus managed custody receipt to become durable. This avoids a false
  `SessionStart hook (failed)` result while keeping the bridge deadline below
  the provider deadline.
- Lifecycle option parsing rejects single-dash typos before creating a
  worktree. An intentional dash-prefixed positional value is accepted only
  after the standard `--` option terminator.
- Provider-switch recovery distinguishes an authenticated legacy context that
  predates `session_handoff_v1` from a malformed partial handoff contract.
  With no local switch journal and zero consumed history, the former permits
  reopening the same provider but continues to reject an actual provider
  switch. Once the server capability is present, the strict remote continuity
  audit remains mandatory.
- Unit, integration, crash-matrix, native-compatibility, and managed handoff
  coverage is green. A fresh hostile C1 run, live interactive two-generation
  Claude launch/resume, and live Codex-to-Claude-to-Codex handoff still gate
  managed-only cutover and installation.

## Verified evidence (2026-07-30)

- The historical `mc-v2-c1` session initially failed managed reconciliation
  because its pre-profile credential domain bound the mutable base
  `config.toml`, Codex had legitimately appended native project trust, and an
  interrupted resume had restored an unchanged archived transcript without
  writing a managed generation journal. Recovery now accepts only that exact
  legacy layout, exact hook, exact registered provider generation, positive
  local host-exit proof, and byte-identical private archive. It then persists
  custody, retires the exited host, and removes the domain through the normal
  close path.
- A cold per-session host could take longer than the former 1.5-second startup
  poll, and a cold signed Codex binary could occasionally exceed the former
  five-second version probe under installation load. A later live package-
  replacement test also observed a healthy host crossing the interim
  five-second host deadline. The bounded deadlines are now fifteen seconds for
  both host readiness and the version process; SHA-256, codesign identifier,
  Team ID, and exact version checks are unchanged.
- The globally installed `/opt/homebrew/bin/mc` version `0.7.6` now opens
  `mc-v2-c1` with plain `mc open mc-v2-c1`. Final live generation
  `91bd1e49-6beb-4184-ab28-cf21d8a2d082` resumed provider session
  `019fade7-639a-7a33-a5d8-7e49d575022a`, exited with code 0, persisted
  custody, cleaned its credential domain, and reached durable `ready`.
  Repeated opens retained the same coding and provider identities and did not
  create a duplicate conversation.
- The final full local suite exercised 2,127 tests: 2,118 passed, 9 were
  intentionally skipped, and 0 failed. The release smoke passed against the
  global `mc` on `PATH`, and `git diff --check` was clean.
- The failed `mc open mc-managed-test-2 --managed-portable --codex` was traced
  to an old but still-running per-session broker. Its manifest had been
  refreshed during later attempts, but read-only status proved that PID 7652
  had loaded the pre-fix hook implementation at `04:57:00Z`. Because both old
  and new processes advertised only protocol v11, the supervisor reused it and
  the exact hidden adapter reason was `managed-provider-hook-mismatch`.
- Broker launch diagnostics now prefer a bounded stable reason code and never
  expose arbitrary adapter error text. The central v12 runtime identity closes
  the stale-code reuse gap for every provider adapter rather than special
  casing Codex.
- The exact managed reopen replaced the verified-empty v11 host with PID 81815
  on v12, resumed native Codex session
  `019fb162-d1bc-7ba1-8706-96a07eafdf53`, displayed neither the folder-trust
  prompt nor a failed SessionStart hook, and exited with code 0. Generation
  `76232eda-2622-404c-89c8-4e3e13c371b9` reached durable `ready` with custody
  persisted and its credential domain cleaned.
- The managed Codex trust-startup regression was traced to the removal of the
  earlier `trust_level = "untrusted"` project entry during the continuity
  refactor. The provider-adapter comment still required that entry, confirming
  that its removal was an implementation regression rather than a policy
  change.
- The focused Codex credential-domain, provider-adapter, broker-launch, and PTY
  suites pass: 67 tests, 0 failures. The config contract asserts the exact
  workspace is `untrusted` and can never be rendered as `trusted`.
- A real user generation that displayed `SessionStart hook (failed)` was
  nevertheless fully captured, placed in managed custody, archived, cleaned,
  and advanced terminally to `ready`. File timestamps showed that the
  one-second hook bridge deadline expired between the durable provider artifact
  and the following managed receipt. A real Unix-socket regression test now
  holds that receipt for 1.25 seconds and confirms that the hook exits
  successfully.
- The exact malformed invocation `new open -managed-test-2` is now rejected
  without creating registry state; an intentional dash-prefixed task remains
  available after `--`.
- Production contains the server-side generation tombstone/adoption contract
  from commit `f27a13db54` (`Fix coding session exit presence`). The deployed
  `/api/version` build inspected on 2026-07-30 is descended from that commit, so
  no Worker patch is required in this older checkout.
- The focused handoff client, provider-switch, and managed-open suites pass:
  73 tests, 0 failures.
- A prior unrestricted full run passed 2,112 tests: 2,103 passed,
  9 intentionally skipped, 0 failed. After the latest lifecycle changes, the
  focused presence, broker launch/runtime/host, and managed resume suites pass
  152/152. Both provider-artifact RPC regressions pass 2/2 after their fixture
  was made local and credential-free.
- The current restricted full run exercised 2,118 tests. It initially reported
  2,095 passes, 10 skips, and 13 failures: six were Unix-socket `EPERM`, five
  were denied test writes to the host `~/.memoro/config.json`, and two were the
  provider-artifact fixture failures fixed above. The 15-test real sidecar
  socket suite separately passed 15/15 outside this socket-restricted sandbox.
- A real vault-backed managed Codex generation launched with ordinary
  broker-delivered startup grounding. Terminal output was observed and the
  exact Codex trust prompt and provider-hook failure were absent. All three
  token-free GitHub App reads succeeded, removal confirmed credential cleanup,
  and the generation journal ended terminally in `ready`.
- The stale active row for `sess_MB6wTTQK5-A-` was proven to belong to exited
  local generation `76232eda-2622-404c-89c8-4e3e13c371b9` and repaired once
  with an exact generated terminal event. Subsequent generation
  `b89289ce-b658-4022-81de-a442c0ad2b0c` published terminal presence
  automatically, disappeared from the server active list, and reached durable
  `ready`.
- The same session then reopened immediately as generation
  `d05abcfb-3604-46f1-a39a-6bb7915e0252`, preserving coding session id,
  provider-native conversation id, history, worktree, and GitHub App
  grounding. It displayed neither the workspace trust prompt nor a failed
  SessionStart hook. Controlled exit returned code 0, published terminal
  presence automatically, persisted custody, cleaned the credential domain,
  and reached durable `ready`.
- A first live prompt returned the exact response `managed-live-ok`. An
  additional prompt after the immediate reopen reached the Codex transcript
  but produced no provider response within 70 seconds and was intentionally
  interrupted. No mc, hook, broker, or GitHub App error was recorded for that
  turn; it is retained as provider-latency evidence rather than counted as a
  successful response check.
- Native compatibility follow-up reproduced two false-negative broker
  outcomes in installed `mc 0.7.6`. `native-note-v2` was accepted under exact
  generation `d04a455b-4084-4202-acfb-44c896284921` and remained live and
  attachable even though the initiating client reported an unknown launch.
  The earlier failed `native-note` generation was absent from its original,
  still-running broker even though the client reported that cleanup could not
  be confirmed.
- The central broker client now gives ordinary provider launches a bounded
  mutation timeout and reconciles lost responses with repeated, exact
  generation status reads. A transient `session-not-found` is no longer
  misclassified as proof that an accepted launch failed. Reconciliation never
  relaunches or terminalizes an unresolved generation.
- SQLite startup cleanup now uses the broker's bounded finalization window,
  reconciles a lost cleanup receipt before retrying, and supplies the expected
  runtime generation. The broker refuses generation-scoped removal when a
  replacement runtime owns the same coding-session id and binds asynchronous
  finalization to the original PTY object so a late continuation cannot delete
  its replacement.
- The focused follow-up validation passes 41/41 launch-client tests and all 48
  broker-runtime tests. The combined launch/runtime/host/lifecycle run passes
  195/197 inside the restricted sandbox; its only failures are Unix-socket
  `EPERM`. The exact daemon file passes 22/22 outside that socket restriction.
  This source fix has not yet replaced the separately installed global
  `mc 0.7.6`.

## Verified evidence (2026-07-29)

- `npm test`: 2,101 tests, 2,092 passed, 9 intentionally skipped, 0 failed.
- Both C1 source-closure checks pass for the exact current source tree.
- A real vault-backed managed Codex generation launched through a v11
  per-session broker. `connection.status`, `repository.metadata`, and
  `pull_request.list` all succeeded through the token-free GitHub App socket.
  Removal returned `credential_cleanup: confirmed`, and the exact generation
  journal ended terminally in `ready`.
- Production `tool-switch` readiness accepts Codex, rejects Claude without the
  exact current-build C1 certification, and rejects Gemini because it has no
  complete managed adapter.
- The separately installed compatibility client remains `mc 0.7.6`.
  Its real `tool-switch codex --dry-run` succeeds without writes, and its
  GitHub App status is `ready` for the current repository. Native compatibility
  is also covered by the full regression suite; this is not evidence that the
  installed client has been cut over to the new managed implementation.
- The current machine inventory contains nine live provider sessions. The
  machine-global C1 interlock therefore correctly blocks a fresh hostile Claude
  certification. No session is terminated merely to manufacture certification
  evidence.

The GitHub write contract (draft creation and guarded update) is covered by
unit/integration tests but has not been exercised live because that would
mutate external repository state. It is not yet live-certification evidence.

## Codex hook-policy follow-up (2026-07-30)

- Managed Codex no longer starts with
  `--dangerously-bypass-hook-trust`. The flag was process-wide and therefore
  broader than mc's credential-only responsibility.
- mc no longer installs a managed Codex `SessionStart` hook. The broker now
  observes the generation-private `CODEX_HOME/sessions` tree after provider
  output and again at provider exit, then passes the exact native id,
  transcript path, and workspace through the existing artifact validator.
- Fresh observation accepts exactly one matching transcript. Resume binds the
  observer to the requested provider-native id. Multiple matching fresh
  transcripts fail closed as ambiguous.
- The managed profile no longer forces Codex's hooks feature on. An existing
  user `hooks.json` is copied byte-for-byte into the isolated Codex home, so
  Codex applies its normal review/trust behavior. The observer binding uses the
  inert filename `mc-provider-artifact-observer.json`, which Codex does not
  treat as a hook source.
- The descriptor remains schema v1 for crash/recovery compatibility; its
  historical `provider_hook_*` field names now bind the inert observer source
  and metadata. A later schema revision may rename those fields without
  changing runtime behavior.
- Broker-delivered startup grounding and handoff turns now wait for the pinned
  Codex main-screen banner. A native `Hooks need review` screen pauses any
  pending delivery, so mc cannot type into the provider's trust dialog. The
  adapter compares the latest main-screen and hook-review markers rather than
  depending on Codex's rotating composer placeholder.
- The first full regression run after the change exercised 2,128 tests:
  2,118 passed, 9 were intentionally skipped, and one session-manager
  event-shape assertion failed because the first implementation widened a
  public event. The implementation was corrected to preserve that event
  contract; the affected broker, registry, adapter, credential-domain, and
  observer suites then passed 89/89.

## Codex vault-entrypoint follow-up (2026-07-30)

- The managed boundary now denies the global mc package root, the public
  `mc` symlink, and the exact realpath entrypoint. The hostile probe requires
  both `mc vault --help` and `node <global-mc-entry> vault --help` to fail.
- Codex 0.145 expands `:minimal` to Homebrew runtime paths in a way that keeps
  those entrypoints executable despite narrower path denies. The profile
  already grants `:root = "write"`, so the redundant `:minimal = "read"`
  entry was removed. Exact secret and mc denies then apply while ordinary
  development commands retain the same broad filesystem access.
- The session GitHub surface remains available through an exact, token-free
  source allowlist. The executor bin now contains both the narrow `gh` shim and
  a restricted `mc` shim that accepts only session-scoped `mc github`
  operations; vault and other mc administration remain unavailable.
- The checksum- and codesign-verified managed Codex 0.145 artifact passed the
  hostile boundary probe in two consecutive generations. Both vault paths,
  the credential canary, and the credential socket were inaccessible; public
  network access, workspace writes, teardown, and generation replacement all
  remained available.
- The focused managed launch, broker, observer, lifecycle, GitHub, and boundary
  regression passed 220/220. The full run exercised 2,129 tests; all code
  assertions passed after the outer sandbox's six Unix-socket cases (37/37)
  and five fixed-HOME update cases (9/9) were rerun in their required
  environments. Ten legacy tests remain intentionally skipped.
- The globally installed 0.7.6 package then passed a real managed
  `mc open token-saving-idea`. Codex's native hook-review dialog remained
  unchanged for more than twenty seconds. After explicitly continuing without
  trust for that invocation, mc delivered `# Session grounding` as the first
  composer turn and Codex answered in Swedish. No hook-bypass warning or vault
  boundary error appeared. Generation
  `97d54560-dc17-4eb1-8611-f4b59173193a` exited with code 0, archived provider
  session `019fb50b-56b7-7982-a172-654c32020bd2`, removed its credential
  domain, and reached durable `ready`.
- The final package replacement forced a cold session-host/runtime-identity
  rollover and succeeded on the first `mc open` within the fifteen-second
  bound. Resume generation `0361aa53-f49e-4c8b-900d-93139b731016` restored
  the same provider id and prior conversation, added no duplicate startup
  grounding, exited with code 0, removed its credential domain, and reached
  durable `ready`.
- The final isolated-HOME full run exercised 2,143 tests: 2,133 passed, 9 were
  intentionally skipped, and one managed-picker fixture failed because it no
  longer mocked the now-mandatory reconciliation decision. The fixture now
  supplies explicit `fresh` and `resume` decisions; its exact regression and
  the affected broker, launch, PTY, adapter, and timer group pass 53/53.

## Completion criteria

- No `mc` launch surface can produce a provider process backed by native host
  credentials.
- Codex and every other selectable tool pass a real two-generation
  vault-backed launch/resume test on each supported platform.
- Codex-to-Claude-to-Codex handoff preserves one Memoro session and delivers
  each handoff turn exactly once.
- GitHub status, PR reads, checks, draft creation, and guarded PR updates work
  from a managed coding session through `github-op-v1`.
- Credential canaries are absent from child environment, argv, broker
  messages, output, logs, transcripts, worktrees, and readable files.
- Killing the client or broker at every durable lifecycle phase either
  reconciles automatically or fails closed with one actionable state.
- The full repository suite and the exact security/live validation commands
  pass on the packaged artifact that will be installed.
