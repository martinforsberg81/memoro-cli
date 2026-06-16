# Hosted live-session workspace

**Status:** active · 2026-06-12 · serves G1 (see `MEMORO.md`)

Detailed plan for the hosted Memoro workspace where the browser is a real
viewport into `mc`-owned AI coding sessions, whether the owning runtime is a
local user machine or a Memoro Cloud sandbox. This is the buildable form of
`docs/plans/worktree-lifecycle.md` §8.

## Product line

This is **not** a cloud shell.

The hosted surface is a single-purpose `mc` orchestrator workspace:

```
list sources/sessions -> start cloud mc or attach one -> work in the live session -> detach -> list again
```

The user should feel like they are inside the real Claude/Codex/Gemini session,
not sending messages to a remote queue. The browser must show the live TUI,
accept raw terminal input after attach, handle resize, preserve
scrollback/screen state across reconnects, and detach without killing the
owning session.

## Hard constraints

- The browser never gets a free terminal launcher. It can only start a typed
  `mc` session through a narrow API or attach to an already-authorized `mc`
  session source.
- A session source can be local or cloud:
  - local source: repo files, git, credentials, vault materialisation, tool
    logins, and host-specific hooks stay on the user's machine.
  - cloud source: execution happens inside a Memoro-owned Cloudflare Sandbox
    with a prepared repo/workspace and a constrained `mc` launch path.
- Cloud start accepts only structured fields (`name`, `task`, `tool`, `policy`,
  server-issued `repo_id`). The browser must not send a raw `repo_ref`, Git URL,
  workspace path, `cmd`, `shell`, `cwd`, `env`, arbitrary args, or package-install
  style escape hatch.
- A session may use secrets only through Memoro-controlled capabilities. Raw
  secret bytes must not be visible to the LLM/tool session through prompt text,
  env, argv, git remotes, files, transcripts, logs, or browser responses.
- The browser is allowed to be a real terminal viewport while attached. "Only
  `mc` in cloud" means Memoro does not expose arbitrary process launch; it does
  not mean the attached TUI cannot receive raw terminal input for the running
  coding tool.
- LLM/tool command execution is governed by session policy below the prompt
  layer. Cloud MVP starts with a sandboxed `workspace-write` profile, then grows
  stricter/larger profiles deliberately.
- Detach is not exit. Closing the browser, refreshing the page, or leaving an
  attached session must never kill the owning PTY.

## Existing cli seams

Current code already owns the important local mechanics:

- `package.json` depends on `node-pty`.
- `src/bin-mc.js` `runWrap()` spawns the selected tool in a PTY via adapter
  routing, pipes local stdin/stdout, tracks output activity, keeps a raw output
  buffer, posts heartbeats, and opens a WS command channel.
- `src/commands/ws-client.js` already maintains a reconnecting WebSocket to
  `/api/sessions/ws` and dispatches server commands to local handlers.
- `src/bin-mc.js` already implements remote `dispatch_message` by writing into
  the PTY, and `fetch_transcript` by delegating to the transcript handler.
- `src/mc/registry.js` stores local work-session metadata, including name,
  tool, worktree, state, and `coding_session_id`.
- `src/mc/commands/list.js` renders local registry state, while legacy
  `mc sessions list` reads active cloud heartbeats from
  `/api/coding-sessions/active`.

What is missing:

- The PTY owner is the foreground `mc` process. If that terminal disappears, the
  PTY disappears too. A remote workspace needs a detached owner.
- The current WS command channel is request/response. Live attach needs a
  streaming data plane with binary PTY frames plus JSON control frames.
- The output buffer is for excerpts, not high-fidelity screen restore.
- There is no attach/detach lifecycle, browser resize handling, or cloud-side
  attach token.
- The cloud/server registry is not yet source-aware enough for multiple local
  machines plus cloud-owned sessions to coexist without ambiguous attach
  routing.
- There is not yet a typed cloud-session launcher that starts `mc` inside a
  sandbox without exposing arbitrary shell/process launch.
- The newer `mc dispatch` / `mc read` lifecycle names are foundation-only and
  not yet wired to live cloud commands.

## Target architecture

```
Memoro browser UI
  xterm/chat hybrid workspace
        |
        | source-aware WebSocket: raw PTY bytes + JSON control
        v
PtyStream Durable Object
        |
        | paired WebSocket stream
        v
mc session source
  ├─ local mc broker daemon on a user machine
  └─ cloud mc sandbox broker inside Cloudflare Sandbox
        |
        | node-pty master, multi-attach relay, screen/ring buffer
        v
Claude / Codex / Gemini PTY in worktree/workspace
```

Control plane:

```
Browser/app -> UserOrchestrator DO -> source registry -> broker control WS
```

Data plane:

```
Browser attach WS <-> PtyStream DO <-> source attach WS <-> owned PTY
```

The control plane should be quiet and hibernation-friendly. The data plane is
active only while a browser or local client is attached.

## Cloudflare fit

Cloudflare's Sandbox terminal API is the reference shape, not necessarily the
runtime we need for v1. Their documented browser terminal protocol uses:

- WebSocket upgrade for terminal attach.
- Binary frames for UTF-8 keystrokes and terminal output.
- JSON text frames for resize, ready, exit, and error.
- Reconnect replay from a buffered output stream.
- xterm.js integration with automatic resize/reconnect helpers.

Workers + Durable Objects are enough for local-session relay because the PTY
lives on the user's machine. Durable Objects are still the right primitive for
pairing long-lived browser and broker WebSockets, and the hibernation API keeps
idle control sockets cheap.

Cloud `mc` sessions add a controlled Cloudflare Sandbox runtime as another
session source. The sandbox does not expose its terminal directly to the
browser. It boots `mc`, starts/uses the same broker bridge, and advertises the
resulting session to the same source registry as local machines.

References:

- https://developers.cloudflare.com/sandbox/api/terminal/
- https://developers.cloudflare.com/sandbox/guides/browser-terminals/
- https://developers.cloudflare.com/durable-objects/best-practices/websockets/
- https://developers.cloudflare.com/workers/platform/pricing/

## Session source model

`broker` must not mean "the user's current laptop". It means "a runtime that
owns one or more `mc` sessions for this user". A user can have many sources live
at once:

```
source: local:macbook       kind=local  name="MacBook Pro"
source: local:studio        kind=local  name="Studio Mac"
source: cloud:cld_abc123    kind=cloud  name="Memoro Cloud"
```

Every advertised session is scoped to a source:

```json
{
  "source_id": "cloud:cld_abc123",
  "source_kind": "cloud",
  "source_name": "Memoro Cloud",
  "machine_id": "memoro-cloud-cld_abc123",
  "cloud_session_id": "cld_abc123",
  "coding_session_id": "sess_x",
  "name": "cloud-coordinator",
  "repo": "memoro",
  "branch": "sess/cloud-coordinator",
  "tool": "codex",
  "state": "idle",
  "attachable": true
}
```

Attach must be source-aware. `coding_session_id` alone is not enough once the
same user has multiple machines and cloud sessions connected. The preferred
route shape is:

```
POST /api/mc/sources/:source_id/sessions/:coding_session_id/attach
```

The existing unscoped attach route may remain as a compatibility shim only when
the session id resolves unambiguously to one live source.

For cloud sessions, the source is created by Memoro before the broker appears:

1. Browser calls the cloud start API.
2. `McCloudSession` DO allocates/boots a sandbox.
3. Sandbox logs in with a short-lived runtime token.
4. Sandbox runs controlled `mc new ...`.
5. The sandbox-local `mc broker connect` advertises source
   `cloud:<cloud_session_id>`.
6. The booting row is reconciled with the broker-advertised live session.

## Local broker model

Add a local daemon that owns PTYs independently from any foreground terminal:

```
src/mc/broker/
  daemon.js          # long-lived local supervisor
  client.js          # local Unix-socket client helpers
  protocol.js        # JSON control message validation
  pty-session.js     # extracted PTY owner
  ring-buffer.js     # bounded binary replay buffer
  screen-state.js    # terminal snapshot/replay quality layer
  cloud.js           # broker control WS + attach stream client
```

Add hidden or low-level commands first:

```
mc broker start
mc broker status --json
mc broker stop
mc broker connect          # cloud bridge; auto-starts the local broker
mc attach <name|id>          # local attach client; later mirrors browser attach
```

`mc broker start/status/stop` are administrative. Normal session commands
should not require the user to start the broker by hand: `mc new`, `mc resume`,
`mc attach`, and `mc broker connect` ensure it is running before continuing.

`mc new` and `mc resume` should stop spawning the tool directly. Instead they
should:

1. Create/resolve the worktree and registry entry as today.
2. Ensure the broker daemon is running.
3. Ask the broker to launch or resume the session.
4. Attach the local terminal as a client of the broker.

That is the key process-model change: the broker owns the PTY, and local/browser
terminals are attach clients.

## `PtySession` contract

The extracted PTY owner should be testable without real `node-pty`:

```js
class PtySession {
  constructor({
    id,
    name,
    cwd,
    tool,
    launchSpec,
    cols = 80,
    rows = 24,
    ptyFactory,
    clock,
    ringBytes = 2 * 1024 * 1024,
  })

  start()
  attach({ attachId, cols, rows, mode })      // returns snapshot + event stream
  detach(attachId)
  write(attachId, data)                       // forwards PTY input from any attach
  resize(attachId, { cols, rows })
  kill({ signal = 'SIGTERM' })
  snapshot()                                  // screen + replay cursor + status
  status()                                    // list row fields
}
```

Data held per session:

```js
{
  coding_session_id,
  name,
  label,
  machine_id,
  device_name,
  repo,
  branch,
  cwd,
  worktree_path,
  tool,
  launched_at,
  last_output_at,
  last_input_at,
  session_state,       // live | idle | dead
  attachable: true,
  attached: [{ attach_id, side, mode, writer, connected_at }],
  writer_attach_id: null, // legacy field; no exclusive writer lease in v1
  ring_cursor,
  pty_pid,
  exit: null | { code, signal, at },
}
```

## Screen restore

Do not ship this with excerpt-only replay.

A high-quality attach needs both:

- A bounded raw binary ring buffer for scrollback/reconnect replay.
- A terminal-state snapshot so a fresh browser can render the current TUI screen
  without relying on a lucky redraw.

Implementation options:

1. Keep a headless terminal emulator in the broker and serialize the current
   screen into an initial browser frame, then replay raw bytes after the
   snapshot cursor.
2. Use raw replay only for the internal proof, but gate public release on screen
   restore quality.

The second option is acceptable only for a throwaway spike. The product-quality
path needs a screen-state module.

## Wire protocol v1

Use separate WebSockets for broker control and each attach stream. Avoid
multiplexing raw PTY bytes and control for multiple sessions on one socket until
there is a proven need.

### Broker control WS

Endpoint:

```
WS /api/mc/broker/ws?token=<device-token>
```

Broker -> cloud:

```json
{
  "type": "hello",
  "protocol": 1,
  "machine_id": "martins-mbp",
  "device_name": "Martins MacBook Pro",
  "source_kind": "local",
  "source_id": "local:martins-mbp",
  "cloud_session_id": null,
  "mc_version": "0.7.0",
  "capabilities": ["pty-stream-v1", "resize-v1", "screen-snapshot-v1"]
}
```

```json
{
  "type": "sessions",
  "sessions": [
    {
      "source_id": "local:martins-mbp",
      "source_kind": "local",
      "coding_session_id": "sess_x",
      "name": "billing-fix",
      "repo": "memoro",
      "branch": "sess/billing-fix",
      "tool": "claude",
      "state": "idle",
      "attachable": true,
      "writer": null,
      "last_activity": "2026-06-07T10:20:00Z"
    }
  ]
}
```

Cloud -> broker:

```json
{
  "type": "attach_request",
  "attach_id": "att_x",
  "source_id": "local:martins-mbp",
  "coding_session_id": "sess_x",
  "broker_ws_url": "wss://meetmemoro.app/api/mc/pty/att_x/broker",
  "token": "short-lived-broker-side-token",
  "cols": 120,
  "rows": 34,
  "mode": "readwrite"
}
```

Broker -> cloud:

```json
{
  "type": "attach_accepted",
  "attach_id": "att_x",
  "source_id": "local:martins-mbp",
  "coding_session_id": "sess_x"
}
```

### Attach stream WS

Endpoints:

```
WS /api/mc/pty/:attach_id/browser?token=<short-lived-browser-token>
WS /api/mc/pty/:attach_id/broker?token=<short-lived-broker-token>
```

Text JSON frames:

```json
{ "type": "ready", "session": { "coding_session_id": "sess_x", "name": "billing-fix" } }
{ "type": "resize", "cols": 120, "rows": 34 }
{ "type": "detach" }
{ "type": "exit", "code": 0, "signal": null }
{ "type": "error", "message": "session not found" }
```

Binary frames:

- Browser -> broker: raw UTF-8 terminal input bytes.
- Broker -> browser: raw PTY output bytes, including ANSI escape sequences.

Initial attach order:

1. Browser connects to `.../browser`.
2. Cloud authorizes and records browser socket.
3. Cloud sends `attach_request` on broker control WS.
4. Broker connects to `.../broker`.
5. Broker sends screen snapshot/replay bytes.
6. Broker sends `{ "type": "ready" }`.
7. Binary frames flow both ways while attached.

## Attach input policy

One session can have many attached clients. In v1, every attached client can
write PTY input.

Rationale:

- The common case is one human moving between local terminal and browser, not two
  people typing at once.
- Text is usually buffered locally for only a few seconds before the user sends a
  prompt.
- The downside of accidental interleaving is a strange LLM instruction, not
  direct code mutation.
- Avoiding a read-only/control-transfer UX keeps the hosted workspace simple.

`Ctrl-C` is just PTY input from whichever client sends it; it interrupts the tool
but must not kill the broker.

## Browser UI model

The UI should feel like a chat workspace with terminal fidelity:

- Session list is the cockpit: source, name, repo, branch, tool, machine, state,
  awaiting-user/open-question, last activity, attachability.
- The list groups by source so a user can see local machines and Memoro Cloud
  side by side.
- A cloud start action is a typed `mc` action, not a command field.
- Attach opens a full live session view with a compact header:
  `billing-fix · claude · MacBook Pro · memoro · idle 3m`.
- The main pane is xterm.js rendering the live TUI.
- Input has two modes:
  - **Terminal mode:** focused xterm sends raw key events directly.
  - **Compose mode:** a chat-like multi-line prompt box sends the composed text
    plus submit keystroke into the PTY. This is a convenience layer, not a
    replacement for terminal attach.
- Detach returns to the list immediately and never exits the owning session.

## Server endpoints

Minimum server/API surface:

```
GET  /api/mc/sessions
GET  /api/mc/sources
WS   /api/mc/broker/ws
POST /api/mc/sources/:source_id/sessions/:coding_session_id/attach
POST /api/mc/sessions/:coding_session_id/attach        # compatibility only
WS   /api/mc/pty/:attach_id/browser
WS   /api/mc/pty/:attach_id/broker
POST /api/mc/sessions/:coding_session_id/writer
POST /api/mc/sessions/:coding_session_id/detach
POST /api/mc/cloud-sessions
GET  /api/mc/repos
GET  /api/mc/cloud-sessions/:cloud_session_id
POST /api/mc/cloud-sessions/:cloud_session_id/stop
```

`GET /api/mc/sessions` can initially merge existing heartbeat data from
`/api/coding-sessions/active` with broker-advertised attachability. Long-term it
should be the single browser source of truth. The public shape must include
source metadata for every attachable row.

`POST /api/mc/cloud-sessions` accepts only structured `mc` launch fields:

```json
{
  "name": "cloud-coordinator",
  "task": "Analyse the Cloudflare hosted mc MVP",
  "tool": "codex",
  "policy": "workspace-write",
  "repo_id": "repo_abc123"
}
```

The `repo_id` must come from `GET /api/mc/repos`. That route is a server-known
repo catalog assembled from broker/session metadata and, later, explicit repo
grants. It may return public repo refs for display and clone bootstrap, but the
browser create path never accepts raw repo strings.

It must reject all free-command fields:

```json
{
  "cmd": "bash",
  "shell": "/bin/zsh",
  "cwd": "/tmp",
  "env": { "X": "Y" },
  "args": ["--anything"]
}
```

Durable Object split:

- `UserOrchestratorDO` keyed by user id: browser list clients, broker/source
  control sockets, source/session registry, attach-token minting, unscoped
  attach compatibility checks.
- `PtyStreamDO` keyed by attach id or session id: pairs one browser stream and
  one broker stream, relays frames, enforces byte caps/backpressure, records
  attach/detach audit metadata.
- `McCloudSessionDO` keyed by user id + cloud session id: owns cloud `mc`
  lifecycle, sandbox allocation, repo/workspace bootstrap, runtime-token
  materialisation, controlled `mc new` launch, and status reconciliation with
  the source registry.

## Security model

- Browser auth uses the Memoro web session, then receives a short-lived attach
  token scoped to `{ user_id, source_id, coding_session_id, attach_id, side:
  browser }`.
- Local broker auth uses the existing device token from the local keychain, then
  receives a short-lived attach token scoped to `{ user_id, source_id,
  machine_id, coding_session_id, attach_id, side: broker }`.
- Cloud broker auth uses a short-lived runtime token minted by Memoro for the
  `McCloudSessionDO`. It should have a narrow scope such as `mc.cloud` covering
  lens read, session/broker write, and nothing user-visible beyond that cloud
  runtime.
- Attach tokens expire quickly and cannot list sessions or start new streams.
- Server persists audit metadata only: attach/detach, user, source, machine,
  cloud session, coding session, timestamps, writer-transfer events. It does not
  persist terminal bytes.
- Relay sees bytes in v1 unless/until browser-to-broker E2E encryption is added.
  That must be explicit in the product/security story.
- Local hooks still rule for local sources because actual execution happens
  inside the local PTY.
- Cloud sources enforce policy through sandbox restrictions, adapter flags, PATH
  guards, and allowed runtime configuration. Prompt text is not the security
  boundary.
- The cloud surface cannot execute arbitrary commands. The only process-launch
  ability is the typed cloud-session create path that starts `mc`; the data
  plane can only write bytes into an already-authorized `mc` coding-session PTY.

## Cost controls

- Use Durable Object WebSocket hibernation for quiet control sockets. Avoid
  `setInterval` / alarms in DOs that need to hibernate.
- Local relay does not need Cloudflare Sandbox/Containers.
- Cloud `mc` sessions do use Sandbox/Containers, but only behind the typed
  cloud-session API and with per-user/session limits.
- Coalesce PTY output in the broker over small windows, for example 5-16 ms.
- Cap per-attach buffered output. If a browser falls too far behind, detach it
  with a clear error rather than buffering unboundedly.
- Meter bytes per user/session for product visibility and denial-of-wallet
  protection.
- Meter cloud runtime minutes, concurrent cloud sessions, and sandbox boot
  failures separately from relay bytes.

## Build phases

### Phase 1: Extract local PTY ownership, no behavior change

Goal: make `runWrap()` depend on a reusable `PtySession` without changing the
current local UX.

Scope:

- Add `src/mc/broker/pty-session.js`, `ring-buffer.js`, and unit tests.
- Move PTY spawn/write/resize/output-buffer logic out of `src/bin-mc.js`.
- Keep `mc`, `mc new`, and `mc resume` behavior identical.
- Preserve existing heartbeat and `dispatch_message` behavior.

Acceptance:

- Existing tests pass.
- New tests cover ring buffer truncation, write appends CR for dispatch, resize,
  exit events, and excerpt generation through the extracted path.

### Phase 2: Local broker + local attach/detach

Goal: a local `mc` terminal becomes an attach client; closing it does not kill
the PTY.

Status:

- **Phase 2a shipped 2026-06-07:** local broker supervisor foundation. `mc broker
  start/status/stop` is wired through the dispatcher, backed by a Unix-socket
  JSON control plane (`ping`/`status`/`stop`), PID/socket/log paths under
  `${MC_HOME}`, and focused tests with an injected server so the suite does not
  require OS socket privileges.
- **Phase 2b shipped 2026-06-07:** in-memory broker session manager foundation.
  `BrokerSessionManager` owns multiple `PtySession`s behind a tested
  launch/list/status/write/dispatch/resize/stop contract, still without changing
  user-visible `mc` launch behavior.
- **Phase 2c shipped 2026-06-07:** broker runtime session protocol.
  `launch_session`, `list_sessions`/`sessions`, `session_status`,
  `write_session`, `dispatch_session`, `resize_session`, `stop_session`, and
  `remove_session` now route through a runtime that resolves tool launch specs
  locally, keeping the socket protocol JSON-clean.
- **Phase 2d shipped 2026-06-07:** local attach stream. The broker socket now
  supports a line-framed `attach_session` handshake followed by raw terminal
  bytes, and `mc attach <session_id>` acts as a local raw-mode attach client with
  resize forwarded over the control plane.
- **Phase 2e shipped 2026-06-07:** broker-owned launch became the `mc new` /
  `mc resume` live path. The current wrap-mode sidecars were split into a
  broker sidecar layer (metadata, local dispatch socket, WS dispatch, heartbeat)
  plus launch prep (grounding, Memoro token lookup, coding-session id minting,
  intro rendering, vault materialisation still in the lifecycle command), and
  the lifecycle commands now launch through the broker then attach locally.
- **Phase 2f shipped 2026-06-07; revised 2026-06-08:** local multi-attach relay.
  The runtime tracks attaches per session and forwards input from every attached
  client to the same PTY. The earlier writer-lease/read-only model was removed as
  product friction for the one-human hosted workspace.
- **Phase 2g shipped 2026-06-08:** broker auto-start became part of the normal
  command surface. `mc new`/`mc resume` already launched through the broker;
  `mc attach` and `mc broker connect` now also ensure the local broker is running
  before continuing, leaving `mc broker start/status/stop` as admin tools.
- **Phase 3a shipped 2026-06-07:** CLI-side cloud bridge. `mc broker connect`
  connects to `/api/mc/broker/ws`, advertises local broker sessions, handles
  `refresh_sessions` / `list_sessions`, and answers server `attach_request`
  messages by bridging a short-lived cloud stream to the local
  `attach_session` PTY stream.
- **Phase 3a hardening shipped 2026-06-08:** the cloud attach bridge now forces
  WebSocket binary frames to `ArrayBuffer` before relaying browser terminal input
  to the local broker. The contract is covered by tests so browser xterm input
  cannot silently degrade into Blob string payloads in Node WebSocket runtimes.
- **Phase 3a connect UX shipped 2026-06-08:** `mc broker connect` now waits for
  the control WebSocket to actually open before reporting success. In long-running
  mode it writes the connected status immediately and then stays attached to the
  cloud control plane, instead of printing only after an effectively infinite
  wait.
- **Phase 3a identity polish shipped 2026-06-08:** broker `hello` now includes
  `device_name` and `mc_version`, so Memoro can show and diagnose the connected
  local machine instead of only a raw machine id.
- **Phase 3a E2E smoke shipped 2026-06-08:** `tests/mc/broker/cloud-e2e.test.js`
  now drives the local broker server, `BrokerRuntime`, `CloudBrokerClient`, and
  a fake cloud WebSocket relay in one test. It verifies session advertisement,
  attach acceptance, initial PTY replay, binary browser input, resize forwarding,
  PTY output relay, and detach-without-kill.
- **Server route smoke shipped 2026-06-08:** the Memoro repo now has a route-level
  `/api/mc` smoke that authenticates with a scoped API token, lists broker
  sessions through `handleMcRoutes`, requests attach through the user
  orchestrator, verifies attach-token storage, and exposes `mc_version` in the
  public broker session shape.
- **Next:** add cloud-session create, so Memoro can start a sandbox-owned `mc`
  session without requiring any local broker online.

Scope:

- Add daemon process and Unix-domain control socket under `${MC_HOME}`.
- Add `mc broker start/status/stop` as admin tools.
- Add `mc attach <name|id>` for local attach.
- Change `mc new` / `mc resume` to launch via broker, then attach locally.
- Auto-start the broker from normal attach/connect entrypoints.
- Store broker/session manifests under `${MC_HOME}/state/`.
- Add multi-attach local clients.

Acceptance:

- Start `mc new test`, detach/close the local client, then `mc attach test`
  resumes the same live TUI.
- `mc end test` remains the explicit destructive lifecycle.
- Local dispatch still writes into the same PTY.

### Phase 3: Broker cloud control plane

Goal: Memoro can see attachable sessions from connected sources and request an
attach stream to the source that owns the selected session.

Scope:

- Add `src/mc/broker/cloud.js`.
- Broker opens `WS /api/mc/broker/ws`.
- Broker advertises sessions and updates with source identity.
- Server mints attach ids/tokens and sends `attach_request`.
- Broker can connect the broker side of a stream and send snapshot/replay.

Acceptance:

- Browser/server test harness can request attach and receive broker-side
  connection without any browser UI.
- No PTY bytes are persisted server-side.
- Broker reconnects with backoff and re-advertises sessions.

Status:

- CLI side shipped 2026-06-07: `src/mc/broker/cloud.js` plus
  `mc broker connect` implement the local connector and attach bridge.
- CLI attach-frame hardening shipped 2026-06-08: broker control and attach
  WebSockets request `arraybuffer` binary frames, and the attach bridge test now
  covers ArrayBuffer input relayed to the local PTY stream.
- CLI connect observability shipped 2026-06-08: the cloud client emits open and
  sessions events, and `mc broker connect` reports only after the control socket
  is open while keeping the foreground process alive.
- CLI broker identity shipped 2026-06-08: `hello` includes machine id, display
  device name, mc version, and capabilities.
- CLI E2E smoke shipped 2026-06-08: a single broker cloud smoke covers session
  inventory, attach, replay, input, resize, output, and detach semantics through
  the broker-owned PTY path.
- Server route smoke shipped in the Memoro repo 2026-06-08: `/api/mc/sessions`
  and `/api/mc/sessions/:id/attach` are covered through real auth + orchestrator
  stubs, and public sessions include `mc_version`.
- Phase 4 source-aware attach routing shipped 2026-06-14 across the current
  memoro-cli + Memoro branches. Remaining gate before cloud start is a real
  browser/manual E2E smoke.

### Phase 4: Source-aware browser attach

Goal: browser attach works correctly when one user has multiple live sources:
local laptop, local desktop, and later Memoro Cloud.

Scope:

- Add/standardize source identity in broker `hello` and session advertisements:
  `source_id`, `source_kind`, `source_name`, optional `cloud_session_id`.
- Update Memoro `UserOrchestratorDO` to store brokers by `source_id`, not only
  by machine id or first matching session id.
- Add source-scoped attach route:
  `POST /api/mc/sources/:source_id/sessions/:coding_session_id/attach`.
- Keep the old unscoped attach route only as an ambiguity-checked compatibility
  path.
- Update `GET /api/mc/sessions` and browser UI rows to show source metadata.
- Group the Coding app list by source and attach to the selected source.
- Preserve existing local broker and PTY stream behavior.

Acceptance:

- Two fake brokers for one user can advertise sessions with the same or similar
  names without attach ambiguity.
- Browser attach to source A never sends `attach_request` to source B.
- Local-only manual smoke still works:
  `mc broker connect -> browser list -> attach -> type -> detach`.
- UI shows source name/kind clearly and exposes no free command field.

Status:

- Shipped 2026-06-14 in current branches:
  - `mc broker connect` / `CloudBrokerClient` accept explicit/env source
    identity and advertise it in the control WS query plus `hello` and sessions
    payloads.
  - Memoro `UserOrchestratorDO`, `/api/mc` routes, active-session/heartbeat
    shapes, and attach tokens carry source metadata.
  - `POST /api/mc/sources/:source_id/sessions/:coding_session_id/attach` is
    the preferred attach route; legacy unscoped attach succeeds only when the
    coding session id is unambiguous.
  - Coding app rows are grouped by source, attach by source+session, preserve
    source in reconnect URLs, and do not expose any free command field.

### Phase 5: Cloud `mc` session create MVP

Goal: a signed-in Memoro user can start a cloud-owned `mc` session without any
local broker being online.

Status:

- **Phase 5a in PR:** Memoro PR #6915 adds `POST /api/mc/cloud-sessions`,
  `McCloudSessionDO`, strict reject-list validation, booting cloud rows in
  `/api/mc/sessions`, and Coding app pending status.
- **Phase 5a in PR:** memoro-cli PR #81 adds the internal typed
  `mc cloud-session start` runtime entrypoint, headless broker launch, cloud
  source advertisement, and explicit workspace policy rendering.
- **Phase 5b in PR:** Memoro PR #6915 now has a separate
  `MC_CLOUD_RUNTIME` Sandbox image/binding, a pure command/env builder for
  typed `mc cloud-session start`, runtime process metadata, unlisted
  sessions.write runtime tokens that are never sent to the browser, and
  stop-time process kill + token revoke. memoro-cli PR #81 now lets cloud
  broker auth use `MEMORO_TOKEN` from the sandbox env before falling back to
  local keychain.
- **Phase 5c security/product correction:** the browser create flow uses
  `repo_id` selected from a server repo catalog, not free `repo_ref`/Git URL
  text. Broker sessions advertise a credential-scrubbed public `repo_ref` for
  catalog use. The LLM child env is scrubbed of `MEMORO_TOKEN`; remaining
  hardening is to move runtime auth and private repo access fully behind
  out-of-session capabilities.

Scope:

- Add `POST /api/mc/cloud-sessions` and `McCloudSessionDO`.
- Validate a narrow create payload: `name`, `task`, `tool`, `policy`, and
  `repo_id` from the server catalog. Reject `repo_ref`, raw Git URLs, `cmd`,
  `shell`, `cwd`, `env`, and arbitrary args.
- Add a Cloudflare Sandbox image for `mc`: Node, git, pinned memoro-cli, chosen
  LLM tool, and no runtime package-install requirement.
- Bootstrap a git repo/workspace because `mc cloud-session start` still needs a
  repo/workspace cwd before public dogfood.
- Mint a runtime capability for the sandbox. The current MVP still uses an
  unlisted one-day `sessions.write` token for the launcher; the LLM child env is
  scrubbed, and the next security gate is replacing that launcher env with a
  true out-of-session control-plane capability and a narrower `mc.cloud` scope.
- Let the sandbox-local broker advertise as `source_kind=cloud` with
  `source_id=cloud:<cloud_session_id>`.
- Reconcile the booting cloud-session row with the broker-advertised live
  session.

Acceptance:

- Browser can start a cloud `mc` session while no local user broker is
  connected.
- The cloud session appears in `GET /api/mc/sessions` under source "Memoro
  Cloud".
- Browser attach streams to the cloud-owned PTY through the same `PtyStreamDO`
  path as local sessions.
- Invalid create payloads containing shell/command/env fields are rejected in
  route tests.
- Cloud runtime token is never sent to the browser.
- Raw secret values are never sent to the LLM child env, command argv, public DTO,
  or stored session record. Private repo clone/fetch remains blocked until the
  clone/fetch action runs in a trusted sidecar/control plane outside the session.

### Phase 6: Cloud start UI and product hardening

Scope:

- Add the browser "Start mc session" flow: name, task/focus, tool, policy, and
  repo select-list loaded from `GET /api/mc/repos`. No command field and no raw
  repo text field.
- Auto-attach when a newly started cloud session becomes attachable, or keep a
  clear booting/live state if auto-attach is deferred.
- Screen-state quality gate.
- Backpressure and slow-client detach.
- Cross-machine/source polish.
- E2E encryption design and implementation.
- Audit/event viewer.
- Cloud runtime metering, max concurrent sessions, stop/reap behavior, and
  failure visibility.

Acceptance:

- A normal user can move between local and cloud `mc` sessions from the browser
  without thinking about brokers.
- Local and browser attach never fight for input silently.
- Security story is documentable without caveats beyond explicit v1 relay-trust
  and explicit cloud sandbox policy.

## Next implementation brief

Continue Phase 5 live proof, not a broader shell.

Next build brief:

```
You are implementing the next Phase 5 live-proof slice of
docs/plans/hosted-live-session-workspace.md: cloud mc sandbox bootstrap after
the server/runtime seam.

Goal:
- A cloud-session create request provisions a sandbox-owned `mc` runtime and
  turns the booting row into an attachable broker-advertised cloud session.
- The cloud surface is a typed mc-launch surface, not a shell or command box.

In scope:
- memoro server/deploy:
  - pin the `Dockerfile.mc-sandbox` build args to the PR/published
    `memoro-cli` version and first supported coding tool.
  - prove the `MC_CLOUD_RUNTIME` binding can build/provision in local/staging
    Wrangler.
  - bootstrap the repo/workspace selected by `repo_id` before the typed launcher
    runs.
  - move runtime auth and private repo git access behind an out-of-session
    capability/sidecar; then tighten the token from one-day `sessions.write` to
    a narrower runtime-only scope when the server auth surface supports it.
  - reconcile the pending row with the broker-advertised `{source_id,
    coding_session_id}` once the sandbox-local broker connects.
- browser UI:
  - add a typed cloud start action/form.
  - show booting/running/error states in the existing source-aware list.
  - auto-attach only after the broker-advertised session is attachable.

Not in scope:
- General terminal.
- Arbitrary command execution API.
- Full provider-token/vault UX beyond the minimal runtime token path.
- Private repo clone/fetch/push using secrets inside the session env/files.

Gates:
- Staging/manual smoke: start cloud session, see `MC_CLOUD_RUNTIME` process,
  broker connects as `source_kind=cloud`, attach, type, detach.
- Route/DO tests for booting-to-broker reconciliation.
- Coding app tests for typed start UI and no free command field.
- Regression tests keep proving no raw repo refs from browser, no credentialed
  Git URLs in runtime commands, no visible session env token, and only typed
  launch fields become the runtime command.
```

## Open decisions before Phase 5

- Cloud repo bootstrap: server catalog `repo_id` is the product path. Public
  clone refs can bootstrap dogfood; private repo access needs a trusted
  capability/sidecar that consumes secrets without exposing values to the
  session.
- Cloud provider auth: user-vault materialisation, Memoro-managed provider
  key, or tool-specific OAuth. Lean: one supported adapter first, with explicit
  product/security choice before public use.
- Runtime token scope: add a narrow `mc.cloud`/`coding.session` scope rather
  than using `full`.
- Sandbox terminal persistence: do not depend on Cloudflare's browser-terminal
  SDK for product attach until verified. The preferred MVP path remains
  sandbox-local `mc broker connect` plus existing `PtyStreamDO`.
