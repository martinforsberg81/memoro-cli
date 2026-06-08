# Hosted live-session workspace

**Status:** active · 2026-06-08 · serves G1 (see `MEMORO.md`)

Detailed plan for the hosted Memoro workspace where the browser is a real
viewport into local AI coding sessions. This is the buildable form of
`docs/plans/worktree-lifecycle.md` §8.

## Product line

This is **not** a cloud shell.

The hosted surface is a single-purpose `mc` orchestrator workspace:

```
list sessions -> attach one -> work in the live session -> detach -> list again
```

The user should feel like they are inside the real Claude/Codex/Gemini session,
not sending messages to a remote queue. The browser must show the live TUI,
accept raw terminal input, handle resize, preserve scrollback/screen state across
reconnects, and detach without killing the local session.

## Hard constraints

- The only cloud command surface is `mc`. No shell, no arbitrary binaries, no
  package installs, no cloud repo checkout.
- All code execution stays on the user's machine: repo files, git, credentials,
  vault materialisation, tool logins, and host-specific hooks remain local.
- Memoro pays for relay/control-plane traffic only. No Memoro-owned LLM credits
  are consumed by this feature.
- The browser is allowed to be a real terminal viewport while attached. "Only
  `mc` in cloud" means the cloud cannot execute arbitrary commands; it does not
  mean the browser cannot stream raw input to the local PTY that already runs the
  user's chosen AI coding tool.
- Detach is not exit. Closing the browser, refreshing the page, or leaving an
  attached session must never kill the local PTY.

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
- There is no writer lease, attach/detach lifecycle, browser resize handling, or
  cloud-side attach token.
- The newer `mc dispatch` / `mc read` lifecycle names are foundation-only and
  not yet wired to live cloud commands.

## Target architecture

```
Memoro browser UI
  xterm/chat hybrid workspace
        |
        | WebSocket: raw PTY bytes + JSON control
        v
PtyStream Durable Object
        |
        | paired WebSocket stream, no inbound connection to user machine
        v
local mc broker daemon
        |
        | node-pty master, writer lease, screen/ring buffer
        v
Claude / Codex / Gemini PTY in local worktree
```

Control plane:

```
Browser/app -> UserOrchestrator DO -> broker control WS
```

Data plane:

```
Browser attach WS <-> PtyStream DO <-> broker attach WS <-> local PTY
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

Workers + Durable Objects are enough for our v1 relay because the PTY lives on
the user's machine, not inside a Cloudflare container. Durable Objects are the
right primitive for pairing long-lived browser and broker WebSockets, and the
hibernation API keeps idle control sockets cheap. Sandbox/Containers stay useful
later only if we decide to host an actual cloud-side process, which is not the
core product here.

References:

- https://developers.cloudflare.com/sandbox/api/terminal/
- https://developers.cloudflare.com/sandbox/guides/browser-terminals/
- https://developers.cloudflare.com/durable-objects/best-practices/websockets/
- https://developers.cloudflare.com/workers/platform/pricing/

## Local broker model

Add a local daemon that owns PTYs independently from any foreground terminal:

```
src/mc/broker/
  daemon.js          # long-lived local supervisor
  client.js          # local Unix-socket client helpers
  protocol.js        # JSON control message validation
  pty-session.js     # extracted PTY owner
  ring-buffer.js     # bounded binary replay buffer
  writer-lease.js    # one writer, many viewers
  screen-state.js    # terminal snapshot/replay quality layer
  cloud.js           # broker control WS + attach stream client
```

Add hidden or low-level commands first:

```
mc broker start
mc broker status --json
mc broker stop
mc attach <name|id>          # local attach client; later mirrors browser attach
```

`mc new` and `mc resume` should eventually stop spawning the tool directly.
Instead they should:

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
  requestWriter(attachId, { force = false })
  write(attachId, data)                       // rejects unless writer
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
  writer_attach_id,
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
  "mc_version": "0.7.0",
  "capabilities": ["pty-stream-v1", "resize-v1", "writer-lease-v1", "screen-snapshot-v1"]
}
```

```json
{
  "type": "sessions",
  "sessions": [
    {
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
{ "type": "writer", "state": "granted" }
{ "type": "writer", "state": "denied", "reason": "local-writer-active" }
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
7. Binary frames flow both ways while writer lease is active.

## Writer lease

One session can have many viewers but only one writer.

Rules:

- Local terminal attach gets writer by default.
- Browser attach gets writer if no writer is active.
- If a local writer is active, browser attach starts read-only and can request
  control.
- Taking control must be explicit in the UI. When control moves, the previous
  writer receives a visible control message and input is ignored there until it
  reclaims control.
- A disconnected writer releases the lease after a short grace period.
- `Ctrl-C` is just PTY input from the current writer; it interrupts the tool but
  must not kill the broker.

For v1, do not support two simultaneous writers.

## Browser UI model

The UI should feel like a chat workspace with terminal fidelity:

- Session list is the cockpit: name, repo, branch, tool, machine, state,
  awaiting-user/open-question, last activity, attachability.
- Attach opens a full live session view with a compact header:
  `billing-fix · claude · martin-mbp · memoro · idle 3m`.
- The main pane is xterm.js rendering the live TUI.
- Input has two modes:
  - **Terminal mode:** focused xterm sends raw key events directly.
  - **Compose mode:** a chat-like multi-line prompt box sends the composed text
    plus submit keystroke into the PTY. This is a convenience layer, not a
    replacement for terminal attach.
- Detach returns to the list immediately and never exits the local session.

## Server endpoints

Minimum server/API surface:

```
GET  /api/mc/sessions
WS   /api/mc/broker/ws
POST /api/mc/sessions/:coding_session_id/attach
WS   /api/mc/pty/:attach_id/browser
WS   /api/mc/pty/:attach_id/broker
POST /api/mc/sessions/:coding_session_id/writer
POST /api/mc/sessions/:coding_session_id/detach
```

`GET /api/mc/sessions` can initially merge existing heartbeat data from
`/api/coding-sessions/active` with broker-advertised attachability. Long-term it
should be the single browser source of truth.

Durable Object split:

- `UserOrchestratorDO` keyed by user id: browser list clients, broker control
  sockets, machine/session registry, attach-token minting.
- `PtyStreamDO` keyed by attach id or session id: pairs one browser stream and
  one broker stream, relays frames, enforces byte caps/backpressure, records
  attach/detach audit metadata.

## Security model

- Browser auth uses the Memoro web session, then receives a short-lived attach
  token scoped to `{ user_id, coding_session_id, attach_id, side: browser }`.
- Broker auth uses the existing device token from the local keychain, then
  receives a short-lived attach token scoped to `{ user_id, machine_id,
  coding_session_id, attach_id, side: broker }`.
- Attach tokens expire quickly and cannot list sessions or start new streams.
- Server persists audit metadata only: attach/detach, user, machine, session,
  timestamps, writer-transfer events. It does not persist terminal bytes.
- Relay sees bytes in v1 unless/until browser-to-broker E2E encryption is added.
  That must be explicit in the product/security story.
- Local hooks still rule because actual execution happens inside the local PTY.
- The cloud surface cannot execute arbitrary commands. The only data-plane
  ability is to write bytes into an already-authorized local coding-session PTY.

## Cost controls

- Use Durable Object WebSocket hibernation for quiet control sockets. Avoid
  `setInterval` / alarms in DOs that need to hibernate.
- Do not use Cloudflare Sandbox/Containers for v1 unless there is a concrete
  need for a cloud process. The local broker is the execution plane.
- Coalesce PTY output in the broker over small windows, for example 5-16 ms.
- Cap per-attach buffered output. If a browser falls too far behind, detach it
  with a clear error rather than buffering unboundedly.
- Meter bytes per user/session for product visibility and denial-of-wallet
  protection.

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
- **Phase 2f shipped 2026-06-07:** local writer lease. The runtime tracks
  attaches per session, grants one writer and many read-only viewers, exposes
  attach/writer state in broker session status, releases the writer on detach,
  and `mc attach --read-only` gives an explicit local viewer mode.
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
- **Next:** run the real browser/manual E2E smoke: Memoro browser UI -> Memoro
  `/api/mc/*` control/PTY stream -> `mc broker connect` -> local broker-owned
  PTY. Then harden screen restore/reconnect quality before public release.

Scope:

- Add daemon process and Unix-domain control socket under `${MC_HOME}`.
- Add `mc broker start/status/stop`.
- Add `mc attach <name|id>` for local attach.
- Change `mc new` / `mc resume` to launch via broker, then attach locally.
- Store broker/session manifests under `${MC_HOME}/state/`.
- Add writer lease for local clients.

Acceptance:

- Start `mc new test`, detach/close the local client, then `mc attach test`
  resumes the same live TUI.
- `mc end test` remains the explicit destructive lifecycle.
- Local dispatch still writes into the same PTY.

### Phase 3: Broker cloud control plane

Goal: Memoro can see attachable local sessions and request an attach stream.

Scope:

- Add `src/mc/broker/cloud.js`.
- Broker opens `WS /api/mc/broker/ws`.
- Broker advertises sessions and updates.
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
- Remaining gate: a real browser/manual E2E smoke across both repos, not another
  protocol design pass.

### Phase 4: Browser live attach UI

Goal: real browser attach to one local session.

Scope:

- Session list in Memoro app.
- xterm.js live attach.
- Resize forwarding.
- Detach button.
- Terminal mode and compose mode.
- Writer lease UI for read-only vs control.

Acceptance:

- `list -> attach -> type -> see response -> detach -> list` works end to end.
- Page refresh reconnects to the same session and restores current screen.
- Detach does not kill the local session.

### Phase 5: Product hardening

Scope:

- Screen-state quality gate.
- Backpressure and slow-client detach.
- Writer takeover UX.
- Cross-machine polish.
- E2E encryption design and implementation.
- Audit/event viewer.

Acceptance:

- A normal user can work for an hour from browser without noticing the relay.
- Local and browser attach never fight for input silently.
- Security story is documentable without caveats beyond explicit v1 relay-trust.

## First implementation brief

Start with Phase 1 only.

Build brief:

```
You are implementing Phase 1 of docs/plans/hosted-live-session-workspace.md.
Work in this repo. Do not build the broker daemon, cloud protocol, or browser UI.

Goal:
- Extract the PTY ownership logic from src/bin-mc.js runWrap into a reusable,
  injectable PtySession module under src/mc/broker/.
- Preserve current behavior exactly: local stdin/stdout still attach directly,
  heartbeat still posts excerpts, dispatch_message still writes to the PTY,
  cleanup still kills the PTY when current runWrap exits.

In scope:
- src/mc/broker/pty-session.js
- src/mc/broker/ring-buffer.js
- focused unit tests under tests/mc/broker/
- minimal edits to src/bin-mc.js to use the new module

Not in scope:
- broker daemon
- cloud endpoints
- browser UI
- changing mc new/resume process model
- changing session ids, registry schema, or server API

Gates:
- npm test
- add tests for ring truncation, output broadcast, writer/write behavior where
  applicable, resize forwarding, and exit notification using a fake ptyFactory.
```

## Open decisions before Phase 2

- Should local terminal close detach by default, or should explicit `/exit` from
  the tool remain the only way to end a session? Lean: close detaches; tool exit
  ends.
- How visible should remote takeover be in the local terminal? Lean: visible
  banner plus input-paused state.
- What exact screen-state dependency should be used? Lean: a headless xterm.js
  state layer if it can serialize the current screen reliably.
- Should `mc attach` accept `coding_session_id` directly, or only registry name
  for local attach? Lean: both, matching current `mc sessions send/read`.
