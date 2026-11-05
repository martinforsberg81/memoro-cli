# mc session message transport — diagnosis

Goal `mc/session-message-transport`, phase 1 of
`SESSION-MESSAGES.md` (programme `mc`). Measured 2026-11-05 on memoro-cli
`c1f3d8330cda20b3d2331bb3c4be939290e59f1f`. This is a report, not the feature:
nothing in mc's runner, CLI or page changes here.

## Result

| Provider | Mode | Result | Mechanism |
| --- | --- | --- | --- |
| Codex | normal | **supported** for a future mc-owned `codex app-server` launch | `turn/steer` with `expectedTurnId` and `clientUserMessageId` on the bound thread |
| Codex | urgent | **supported**, same mechanism | as normal; precedence is mc's own pending-queue order, Codex has no separate priority |
| Codex | either, on today's `codex exec` launch | **unsupported** | stdin closed, no control endpoint; no evidence any app-server can attach to an `exec` process |
| Claude | normal | **supported** on mc's existing stream-json launch, with one flag added | a stream-json `user` line with a `uuid`, observed through `--replay-user-messages` and `command_lifecycle` |
| Claude | urgent | **supported**, same mechanism, with a measured wait | input is taken at the next model-input boundary inside the active turn; a foreground Bash command finishes first |
| Claude | either, on today's launch without the flag/uuid | **unsupported as a receipt path** | `streamSession.send` writes stdin but has no delivery observation |

Both supported paths were demonstrated live, twice per provider, serially, each
run under 300 s: the build command ran to its own exit (status 3, output
intact), both messages were delivered inside the same instance and
conversation, and each was acknowledged and answered by a receiver-authored
envelope before the build session ended. Four gaps remain open and are listed
under [Known gaps](#known-gaps); two of them (turn-end/result drain and the
credits route) are **inconclusive**, not supported.

Positive transport evidence does not deliver the feature. Phase 2
(`mc/live-session-messages`) stays in plan until plan has taken this decision
in.

## Versions and environment

| Item | Value |
| --- | --- |
| memoro-cli | `c1f3d8330cda20b3d2331bb3c4be939290e59f1f` (goal branch, unchanged source) |
| Codex | `codex-cli 0.166.0` (`/opt/homebrew/bin/codex`) |
| Claude | `2.1.318 (Claude Code)` (`~/.local/bin/claude`) |
| Node | v24.10.0 |
| OS | macOS 26.4 (Darwin 25.4.0), arm64 |
| Codex account route | `account/updated` → `authMode: chatgpt`, `planType: prolite` (subscription; no API key in the child) |
| Claude account route | `system/init` → `apiKeySource: none` (subscription; `ANTHROPIC_*` unset in the child) |
| Models | Codex `gpt-6.1-sol` (machine default), Claude `claude-opus-5-5` (machine default) |

Provider keys were not inspected. The probe children ran with every `MC_*`
variable removed except `MC_HEADLESS=1` for Claude, and with
`ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`, `CLAUDE_API_KEY` and
`OPENAI_API_KEY` removed — the same list `runGoal` unsets.

## The mc launch boundary today

Read from source at the revision above.

- **Codex.** `headlessArgs` (`src/mc/run-plan.js:427-428`) builds
  `codex exec --json --sandbox danger-full-access … <prompt>`; the prompt is
  the last positional. `watchFor` (`src/mc/run.js:790-791`) returns `{}` for
  Codex, so `streamSession` (`src/mc/run.js:252-260`) spawns it with stdin
  `'ignore'`: no check-in, no stall watcher, no input channel. `codex exec
  --help` names no listen, socket or control option. `codex app-server
  daemon|proxy` connect to a daemon-hosted app-server, not to an `exec`
  process. **No evidence that anything can attach to a running `codex exec`.**
  Every Codex session the runner has launched so far is unsupported for
  messaging, and stays so.
- **Claude.** `headlessArgs` (`src/mc/run-plan.js:431-438`) gives
  `claude -p … --input-format stream-json --output-format stream-json
  --verbose`. `streamSession` pipes stdin; its `send` (`run.js:314-317`)
  writes `userMessageLine` (`run-plan.js:442-444`: `{type:'user',message}`,
  no `uuid`) and refuses after the first `result` line, where
  `onResultLine` (`run.js:348-362`) ends stdin and arms `resultGraceMs`.
  Writing is not delivery: nothing observes the line entering the model.
- **Ownership.** `runGoal` (`run.js:1555-1700`) owns route, billing
  (`billingFor` → `gatewayLaunch`, `src/mc/billing-route.js:43-47`), role
  instructions (`instructionsFor` → `profileArgs`: Codex
  `-c instructions=…`, Claude `--append-system-prompt`), the lane slot, the
  `current-<repo>[-lane].json` record (runner `pid`, `started`, no session
  instance or conversation id) and cleanup in a `finally`. The child's stdio
  pipes are held only by that runner process; that is the one execution owner
  a message must reach.
- **Accounting.** Codex usage and session id are read from `exec --json`
  lines by `readCodexEvents` (`run-plan.js:660-675`: `usage.input_tokens`,
  `thread_id`). App-server notifications have another shape
  (`thread/tokenUsage/updated`, camelCase), so an app-server launch needs its
  own reader before it can keep `runs.tsv` truthful.

## Provider protocols as installed

### Codex app-server (0.166.0)

`codex app-server --help`: `[experimental]`, `--listen stdio://` (default),
`unix://`, `ws://`. `codex app-server generate-json-schema --experimental
--out <dir>` gives the protocol used below (`v2/`):

- `thread/start` — `cwd`, `sandbox` (`danger-full-access`), `approvalPolicy`
  (`never`), `config`, `baseInstructions`, `developerInstructions`,
  `ephemeral`, `model`. Response carries `thread.id`, `model`, `sandbox`,
  `approvalPolicy`.
- `turn/start` — `threadId`, `input[]`, `clientUserMessageId`.
- `turn/steer` — required `threadId`, `input[]`, `expectedTurnId` ("The
  request fails when it does not match the currently active turn");
  optional `clientUserMessageId`. Response `{ turnId }`.
- `thread/queue/add` — `threadId`, `input`, `clientUserMessageId`: input for
  after the turn. Not used: it waits for turn end, which in a one-turn mc
  session is goal end (contract item 1).
- Notifications: `turn/started`, `turn/completed`, `item/started`,
  `item/completed`, `item/agentMessage/delta`, `thread/tokenUsage/updated`,
  `hook/started`, `hook/completed`, `account/updated`, … `ThreadItem`
  `userMessage` has `clientId`; `agentMessage` has `id`, `text`;
  `commandExecution` has `command`, `processId`, `status`, `exitCode`,
  `durationMs`, `aggregatedOutput`.

### Claude stream-json (2.1.318)

`claude --help`: `--input-format stream-json` ("realtime streaming input"),
`--replay-user-messages` ("Re-emit user messages from stdin back on stdout
for acknowledgment"). Observed but not in `--help`: a `command_lifecycle`
event `{command_uuid, state: queued|started|completed}` keyed by the input
line's `uuid`. A `priority` field on input lines was **not examined**: its
semantics could include interruption, which the contract forbids probing
blind.

## Probe design and budget

Each run: a fresh disposable git fixture under `$MC_SCRATCH` holding
`build.sh` (prints `BUILD-START`, sleeps 40 s, prints a random
`BUILD-TOKEN-…` and `BUILD-END`, exits 3), the probe role text in the
provider's mc role channel, and one task: run `./build.sh` once in the
foreground and end with `BUILD RESULT exit=<status> last=<line>`. When the
build's tool call starts, the probe sends a normal message after 4 s and an
urgent one after 9 s; run 2 also sends a late normal message the moment the
build's result is observed. A receiver answers with one envelope JSON line per
message. The probe kills nothing except at its own 290 s guard.

Launch flags equal mc's `headlessArgs` session/role flags:

- Codex: `codex app-server --listen stdio:// -c project_doc_max_bytes=0 -c
  features.multi_agent=true -c instructions=<role>` (= `sessionArgs` +
  `profileArgs`), `thread/start {cwd, sandbox: danger-full-access,
  approvalPolicy: never, ephemeral: true}` (= `exec --sandbox
  danger-full-access`, exec's approval `never`). `ephemeral` keeps probe
  threads out of the machine's session history; a production launch must not
  use it.
- Claude: `claude -p --permission-mode acceptEdits --tools
  Bash,Read,Edit,Write,Grep,Glob,Agent --strict-mcp-config --settings <mc
  sessionArgs> --append-system-prompt <role> --input-format stream-json
  --output-format stream-json --verbose` plus `--replay-user-messages`.
  `--autocompact` and `--model` were left out: neither touches the input path.

| Run | Started (UTC) | Elapsed | Outcome | Usage |
| --- | --- | --- | --- | --- |
| codex-run1 | 17:28:37 | 268.2 s to turn end, 271.7 s to exit 0 | positive; `initialize` took 122.8 s (stderr: `timed out negotiating with the code-mode host`) | 134 955 tokens: 134 433 in (115 840 cached), 522 out |
| claude-run1 | 17:34:40 | 74.9 s to `result`; probe guard SIGTERM at 290.2 s, exit 143 | delivery and replies positive; probe's whole-message parser missed two envelopes in one text block, so it kept stdin open until its guard — the session had already finished its turn | 4 in, 271 out, 17 015 cache read, 3 705 cache write; reported $0.0274 |
| claude-run2 | 17:41:20 | 88.7 s to `result`, 91.1 s to exit 0 | positive, mc-faithful stdin end at first `result` | 10 in, 659 out, 49 529 cache read, 4 315 cache write; reported $0.0447 |
| codex-run2 | 17:43:13 | 63.8 s to turn end, 64.9 s to exit 0 | positive, including the late message | 108 238 tokens: 107 782 in (97 152 cached), 456 out |

Total: four runs, two per provider, serial, none over 300 s. No retry.

## Reconciliation per provider

### Codex

| Question | Evidence | Finding |
| --- | --- | --- |
| Installed version/help/schema | `codex --version`, `app-server --help`, generated schema | 0.166.0; `turn/steer` with `expectedTurnId` and `clientUserMessageId` exists (experimental server). |
| Launch/control ownership | probe spawns app-server over stdio; one pid per run (26541, 57718) | The spawning process owns the only control channel. Closing stdin after `turn/completed` ended the server with exit 0 in 1–3 s. |
| Next model boundary | codex-run1 t=224.3–229.6 s, codex-run2 t=20.0–25.2 s | `userMessage` item with `clientId = <message id>` appears 1–3 s after the steer, **while `./build.sh` is still running** (pid 11637 / 77011). Codex's shell tool yields a running command back to the model, which polls it (`terminalInteraction`); steered input enters at that next sampling request. |
| Active-turn steering | every `turn/steer` returned `{turnId}` equal to the active turn | Accepted on the bound turn; `expectedTurnId` is the transport guard. |
| Effect on in-flight work | codex-run2 t=25.1 s: agentMessage `…4886883bc4` started, never completed | A steer may abandon the model's in-flight sampling (partial text discarded). The command was not touched: same pid, ran 41.0 / 40.6 s, exit 3, output with the token. No signal, no cancellation request. |
| Legacy launch | source + `exec --help` | Unsupported. |
| Receiver event | `item/completed` `agentMessage` whose text is the envelope line | Receiver-authored, on the same `threadId`/`turnId`; parsed from the completed item only. |
| Correlation | `clientUserMessageId` → `userMessage.clientId`; envelope `message_id` | Delivery observed independently of acknowledgement. |
| Result handling | `turn/completed status=completed` after the final `BUILD RESULT` line | Every message was replied before turn end. The late message (run 2) was steered 4 ms after the build's completion and still landed in the turn. |
| Ownership | one thread id, one turn id, one build pid per run; item types: userMessage, reasoning, commandExecution, agentMessage only | No second worker, no subagent, no resume, no new thread. |
| Role / permissions / hooks / billing / accounting | the envelope rule lived only in `-c instructions=`, and was followed; `sandbox=dangerFullAccess approval=never`; `hooks.json` has no hooks today, so no `hook/*` event (not exercised); subscription route; usage in `thread/tokenUsage/updated` | Role and permissions preserved. Hooks: not exercised. Credits gateway: not probed. Accounting needs an app-server reader. |

### Claude

| Question | Evidence | Finding |
| --- | --- | --- |
| Installed version/help | `claude --version`, `--help` | 2.1.318; stream-json input and `--replay-user-messages` documented; `command_lifecycle` observed. |
| Launch/control ownership | mc already pipes stdin (`streamSession`); probe did the same; one pid per run (42200, 54157) | Owner = process holding the stdin pipe. |
| Transport accepted | `command_lifecycle … queued` for the message `uuid`, right after the write | Acceptance, not delivery. |
| Next model boundary | claude-run1 t=68.5–68.9 s, claude-run2 t=52.6–58.7 s | `user isReplay uuid=<uuid>` and `command_lifecycle started` come **after** the foreground Bash `tool_result` (34–39 s after the write) and before the next assistant output, inside the same turn (`num_turns` 2 / 5, one `result`). |
| Active-turn steering | as above | Input written mid-turn is injected at the next tool-result boundary of the same turn; a foreground command is waited for, not interrupted. |
| Legacy launch | source | Today's lines carry no `uuid` and the launch lacks `--replay-user-messages`: no delivery observation. Unsupported as a receipt path. |
| Receiver event | `assistant` text block, envelope line(s) | Receiver-authored on the bound `session_id`. Run 1: both envelopes and the final line in one text block. Run 2: one block each. |
| Correlation | input `uuid` ↔ replay `uuid` ↔ `command_uuid`; envelope `message_id` | Delivery observed independently of acknowledgement. |
| Result handling | run 2: `result` at 88.7 s, stdin ended as `onResultLine` does, exit 0 at 91.1 s | All three envelopes (incl. the late one) preceded `result`. |
| Tool preservation | `tool_result is_error=true "Exit code 3 … BUILD-TOKEN-… BUILD-END …"` | Command ran its full 40 s, output and exit intact. |
| Ownership | one `session_id` per run; tools used: Bash only (run 2: three extra `true` calls, see gaps) | No Agent, no second worker, no resume. |
| Role / permissions / hooks / billing / accounting | envelope rule only in `--append-system-prompt`, followed; `permissionMode=acceptEdits`; `SessionStart:startup` hook ran (`hook_started`/`hook_response`); `apiKeySource=none`; `result.usage` as today | Preserved; `--replay-user-messages` adds `user` echo lines the result parsers must tolerate. Credits gateway: not probed. |

## Delivery modes against the contract

- **Normal** (next observable safe model-input boundary, same session): both
  providers meet it — Codex at the next sampling request, Claude at the next
  tool-result boundary — without waiting for goal end, a successor or a resume.
- **Urgent** (earliest safe attention): neither provider exposes anything
  safer and earlier than the path normal already uses. Urgent therefore means:
  precede pending normal messages in mc's own queue (FIFO per priority), and
  submit at once. On Claude a foreground command must finish first; the UI
  must say so (measured: 34–39 s, i.e. the rest of the build). On Codex,
  attention came during the command because the shell tool yields.
- **Never**: no signal, no `turn/interrupt`, no `priority` experiment, no
  thread restart, no second worker. None was used.

## Known gaps

1. **Turn-end / result drain — inconclusive.** Not observed: a message
   accepted (`queued` / steer ok) but not yet delivered when the turn ends.
   Codex: a steer after `turn/completed` must fail on `expectedTurnId`
   (schema); an accepted steer racing the turn end was not seen. Claude: a line
   `queued` but not `started` at `result` — mc ends stdin there; whether the CLI
   then runs it as a new turn or drops it is unknown. Phase 2 must fence this:
   no submission after turn end/result, and accepted-but-undelivered at exit is
   `delivery-unknown` (Codex) or `session-ended` (Claude) unless the
   `userMessage`/`started` event was seen.
2. **Credits (billing gateway) route — inconclusive.** Not probed: it is paid
   and needs the provider key. `gatewayToolConfig` prepends `-c
   model_provider…` to the tool's args; `codex app-server` accepts `-c`, so
   the shape should carry over, but this is unverified.
3. **Codex accounting and persistence — open.** `readCodexEvents`,
   `readSessionOutput` quota/refusal detection and the session-log `.jsonl`
   assume `exec --json` lines. The probe used `ephemeral: true`; whether a
   persistent app-server thread is resumable by mc's existing
   `codex exec resume <id>` recovery path is unverified.
4. **Codex hooks — not exercised.** `~/.codex/hooks.json` holds no hooks on
   this machine, so neither launch would show one. The protocol does report
   `hook/started`/`hook/completed`; phase 2 must check them with mc's Codex
   hook installed.
5. **Receiver compliance — measured.** Claude run 1 merged two envelopes and
   the final line into one text block; run 2 inserted three no-op `true` Bash
   calls "to separate envelope messages". The envelope must be one whole line,
   several allowed per message, and the role must say so; a parser keyed on
   whole messages loses receipts.
6. **Partial output — measured.** Codex abandoned an in-flight
   `agentMessage` on steer. Only `item/completed` items count; deltas never.
7. **Codex startup — measured.** `initialize` took 122.8 s in run 1 and 4.0 s
   in run 2. A message sent before a thread and turn exist has no address and
   must be refused, not queued blind.
8. **Codex app-server is `[experimental]`** in 0.166.0. A version change can
   alter it; capability must be checked per launch (see decision).

## Implementation decision

Recommendation for plan, within the approved scope. Both providers: adopt.

**Address and envelope (both).** At launch `runGoal` mints an immutable
`session_instance` id and writes it, with provider and (once known) the
conversation id, into the current record next to `pid`/`started`. The
conversation is bound from the provider's own first event: Codex
`thread/start` response `thread.id`; Claude `system/init` `session_id`. A
message is submitted only by the runner process holding the child's stdio —
the draining predecessor included; a new runner cannot reach that pipe, which
is the fence. Receiver envelope v1: one line, entire, of a completed receiver
text item, outside a code fence:
`{"mc_envelope":1,"message_id":"<id>","kind":"ack"|"reply","ack":true,"reply":"…"}`.
Accept it only when `message_id` is pending for this instance and the item is
on the bound thread/session. Never from deltas, tool output, user/replay lines
or sender text. Repeated identical envelopes are idempotent; a conflicting
second reply is refused and recorded.

**Codex — future launches only.**

- Replace `codex exec` for runner-owned goal sessions with
  `codex app-server --listen stdio://` + the same `-c` session switches and
  `-c instructions=<role>` (`headlessArgs` gets an app-server shape;
  `sessionArgs`/`profileArgs` unchanged). The runner sends `initialize`,
  `thread/start {cwd, sandbox: danger-full-access, approvalPolicy: never}`
  (not ephemeral), then `turn/start {input: prompt}`; it ends stdin on
  `turn/completed`. `gatewayLaunch` wraps it as today.
- `watchFor` returns a control handle for Codex instead of `{}`;
  `streamSession` gets a JSON-RPC mode (request ids, responses,
  notifications) beside its stream-json mode.
- Transport accepted = `turn/steer` response `turnId` (record it);
  delivered = `item/started userMessage clientId=<message id>`;
  acknowledged/replied = envelope in `item/completed agentMessage`.
- Accounting: read `thread/tokenUsage/updated` totals and `thread.id` into
  the existing `runs.tsv` columns; refusal/quota detection from app-server
  `error`/`turn/completed` errors. Keep the stream in the session `.jsonl`.
- Capability: reported only when the launch is app-server and `initialize`
  succeeded; every `codex exec` session — all current ones — is `unsupported`.

**Claude — the existing stream-json launch.**

- Add `--replay-user-messages` to `headlessArgs`' stream io; give every
  `userMessageLine` (prompt, check-ins, messages) a `uuid`.
- Transport accepted = `command_lifecycle queued` for that uuid;
  delivered = `user isReplay` with that uuid (or `command_lifecycle started`);
  acknowledged/replied = envelope in an `assistant` text block.
- `scan` in `streamSession` must parse these lines in addition to `result`
  and `background_tasks_changed`; result parsers must ignore replay lines.
- Drain: `send` already refuses after `result`. Messages `queued` but not
  `started` at `result` are closed as `session-ended` (or held, if plan
  decides to keep stdin open until they start — that is a policy choice and
  needs its own evidence).

**Required focused fixtures (phase 2, from the commissioned list).**
`tests/mc/run-session.test.js`: fake child emitting the recorded JSON-RPC
notifications (Codex) and stream-json lines (Claude) — accepted without
`clientId`/replay leaves delivered unset; envelope in a delta, tool output or
replay is ignored; urgent submitted during an active command leaves the
command's completion and exit untouched and sends no signal; send after
`turn/completed`/`result` is refused. `tests/mc/run-codex.test.js`: app-server
argument composition keeps `project_doc_max_bytes=0`,
`features.multi_agent=true`, `instructions=`, sandbox and approval.
`tests/mc/session-messages.test.js`: records, instance/stale-id routing,
request-id idempotency, conflicting replies. The three fault replays
SESSION-MESSAGES.md names (acceptance-as-ack, stale-instance routing, urgent
command cancellation) stand.

**Follow-up commands.** Prerequisites: Codex ≥ 0.166.0 and Claude ≥ 2.1.318
on the subscription route, a disposable directory, and the probe budget of
the goal that runs them. Extract and run the probes below:

```sh
mkdir -p "$MC_SCRATCH/probes" "$MC_SCRATCH/out"
node -e 'const fs=require("fs");const t=fs.readFileSync(process.argv[1],"utf8");for(const m of t.matchAll(/<!-- probe:(\S+) -->\n```js\n([\s\S]*?)\n```/g))fs.writeFileSync(process.argv[2]+"/"+m[1],m[2]+"\n");' docs/technical/mc-session-message-transport.md "$MC_SCRATCH/probes"
codex app-server generate-json-schema --experimental --out "$MC_SCRATCH/schema"
node "$MC_SCRATCH/probes/codex-probe.mjs" "$MC_SCRATCH/out" 1   # ≤ 290 s
node "$MC_SCRATCH/probes/claude-probe.mjs" "$MC_SCRATCH/out" 2  # ≤ 290 s, mc-faithful stdin end
```

Run `2` adds the late message and line-level envelope parsing; `1` is the
whole-message parser of the first runs. Each writes
`<provider>-run<n>.trace.jsonl` (condensed, timestamped) and `.raw.jsonl`
(every protocol line) to the out directory. Each run is a paid model call.

Before phase 2 activation plan must still settle: gap 1 policy (close vs.
hold on result), whether to authorise one credits-route probe (gap 2), and
the Codex resume path (gap 3). Until then `mc/live-session-messages` stays in
plan.

## Redacted traces

Condensed from `*.trace.jsonl`; `$MC_SCRATCH` and `~` replace local paths.
Deltas, reasoning items, rate-limit and token-usage ticks are omitted (usage is
in the table above). `t=` citations above refer to the second column.

#### codex-run1

```text
17:28:37.930    0.1s spawn codex app-server --listen stdio:// -c project_doc_max_bytes=0 -c features.multi_agent=true -c instructions=<probe role>
17:28:38.618    0.7s pid 26541
17:30:40.693  122.8s <- initialize ok=True
17:30:42.308  124.4s account/updated
17:31:01.080  143.2s <- thread/start thread=01a1acc3-559b-7e53-b38b-96cf7b0f1732 model=gpt-6.1-sol sandbox=dangerFullAccess approval=never
17:31:01.113  143.2s thread/started
17:31:04.641  146.7s <- turn/start turn=01a1acc3-a0c4-71c0-94f2-aa81166b6884 inProgress
17:31:04.649  146.7s turn/started turn=01a1acc3-a0c4-71c0-94f2-aa81166b6884
17:31:10.539  152.6s item/started userMessage turn=aa81166b6884 clientId=task-1
17:31:10.544  152.6s item/completed userMessage turn=aa81166b6884 clientId=task-1
17:32:09.462  211.5s item/started commandExecution turn=aa81166b6884 `/bin/zsh -lc "ps -ax -o pid,ppid,command | grep '[b]uild.sh'; ls -la"` pid=33296 status=inProgress exit=None ms=None
17:32:12.179  214.2s item/completed commandExecution turn=aa81166b6884 `/bin/zsh -lc "ps -ax -o pid,ppid,command | grep '[b]uild.sh'; ls -la"` pid=33296 status=completed exit=0 ms=4310
17:32:17.425  219.5s item/started commandExecution turn=aa81166b6884 `/bin/zsh -lc 'cat build.sh'` pid=76201 status=inProgress exit=None ms=None
17:32:17.752  219.8s item/completed commandExecution turn=aa81166b6884 `/bin/zsh -lc 'cat build.sh'` pid=76201 status=completed exit=0 ms=517 out='#!/bin/sh\necho "BUILD-START $(date -u +%Y-%m-%dT%H:%M:%SZ)"\nsleep 40\necho "BUILD-TOKEN-c19e7c43"\necho "BUILD-END $(date -u +%Y-%m-%dT%H:%M:%SZ)"\nexit 3\n'
17:32:21.464  223.5s item/started commandExecution turn=aa81166b6884 `/bin/zsh -lc ./build.sh` pid=11637 status=inProgress exit=None ms=None
17:32:22.219  224.3s -> turn/steer clientUserMessageId=m-normal-d5332e expectedTurnId=01a1acc3-a0c4-71c0-94f2-aa81166b6884
17:32:23.416  225.5s <- turn/steer ok=True turnId=01a1acc3-a0c4-71c0-94f2-aa81166b6884
17:32:25.146  227.2s item/started userMessage turn=aa81166b6884 clientId=m-normal-d5332e
17:32:25.149  227.2s item/completed userMessage turn=aa81166b6884 clientId=m-normal-d5332e
17:32:26.507  228.6s -> turn/steer clientUserMessageId=m-urgent-9081cf expectedTurnId=01a1acc3-a0c4-71c0-94f2-aa81166b6884
17:32:26.815  228.9s <- turn/steer ok=True turnId=01a1acc3-a0c4-71c0-94f2-aa81166b6884
17:32:27.506  229.6s item/started userMessage turn=aa81166b6884 clientId=m-urgent-9081cf
17:32:27.506  229.6s item/completed userMessage turn=aa81166b6884 clientId=m-urgent-9081cf
17:32:35.689  237.8s item/started agentMessage turn=aa81166b6884 id=3d0adf4ab3
17:32:36.367  238.4s item/completed agentMessage turn=aa81166b6884 text='{"mc_envelope":1,"message_id":"m-normal-d5332e","kind":"reply","ack":true,"reply":"I am running build.sh."}' id=3d0adf4ab3
17:32:41.829  243.9s terminalInteraction (model polls the running command)
17:32:45.370  247.4s item/started agentMessage turn=aa81166b6884 id=83621909c1
17:32:46.987  249.1s item/completed agentMessage turn=aa81166b6884 text='{"mc_envelope":1,"message_id":"m-urgent-9081cf","kind":"reply","ack":true,"reply":"Yes, the build process is still running and has not returned an exit status."}' id=83621909c1
17:32:52.380  254.4s terminalInteraction (model polls the running command)
17:33:02.489  264.6s item/completed commandExecution turn=aa81166b6884 `/bin/zsh -lc ./build.sh` pid=11637 status=failed exit=3 ms=41025 out='BUILD-START 2026-11-05T17:32:22Z\nBUILD-TOKEN-c19e7c43\nBUILD-END 2026-11-05T17:33:02Z\n'
17:33:05.831  267.9s item/started agentMessage turn=aa81166b6884 id=0a3f58e59b
17:33:06.703  268.8s item/completed agentMessage turn=aa81166b6884 text='BUILD RESULT exit=3 last=BUILD-TOKEN-c19e7c43' id=0a3f58e59b
17:33:06.790  268.9s turn/completed turn=01a1acc3-a0c4-71c0-94f2-aa81166b6884 status=completed
17:33:06.810  268.9s probe ends stdin (turn completed, 268.2 s)
17:33:09.590  271.7s child exit code=0 signal=None
```

#### codex-run2

```text
17:43:13.574    0.0s spawn codex app-server --listen stdio:// -c project_doc_max_bytes=0 -c features.multi_agent=true -c instructions=<probe role>
17:43:13.581    0.0s pid 57718
17:43:17.537    4.0s <- initialize ok=True
17:43:18.212    4.6s <- thread/start thread=01a1acce-d170-74a3-aab8-0418fc724694 model=gpt-6.1-sol sandbox=dangerFullAccess approval=never
17:43:18.264    4.7s thread/started
17:43:18.265    4.7s account/updated
17:43:18.546    5.0s <- turn/start turn=01a1acce-d42d-70e0-9804-5540cd071151 inProgress
17:43:18.570    5.0s turn/started turn=01a1acce-d42d-70e0-9804-5540cd071151
17:43:21.422    7.8s item/started userMessage turn=5540cd071151 clientId=task-1
17:43:21.422    7.8s item/completed userMessage turn=5540cd071151 clientId=task-1
17:43:29.589   16.0s item/started commandExecution turn=5540cd071151 `/bin/zsh -lc ./build.sh` pid=77011 status=inProgress exit=None ms=None
17:43:33.592   20.0s -> turn/steer clientUserMessageId=m-normal-f8d745 expectedTurnId=01a1acce-d42d-70e0-9804-5540cd071151
17:43:36.576   23.0s <- turn/steer ok=True turnId=01a1acce-d42d-70e0-9804-5540cd071151
17:43:36.576   23.0s item/started userMessage turn=5540cd071151 clientId=m-normal-f8d745
17:43:36.576   23.0s item/completed userMessage turn=5540cd071151 clientId=m-normal-f8d745
17:43:37.686   24.1s terminalInteraction (model polls the running command)
17:43:38.591   25.0s -> turn/steer clientUserMessageId=m-urgent-7f8dda expectedTurnId=01a1acce-d42d-70e0-9804-5540cd071151
17:43:38.603   25.0s <- turn/steer ok=True turnId=01a1acce-d42d-70e0-9804-5540cd071151
17:43:38.659   25.1s item/started agentMessage turn=5540cd071151 id=4886883bc4
17:43:38.768   25.2s item/started userMessage turn=5540cd071151 clientId=m-urgent-7f8dda
17:43:38.768   25.2s item/completed userMessage turn=5540cd071151 clientId=m-urgent-7f8dda
17:43:40.363   26.8s item/started agentMessage turn=5540cd071151 id=9e47242cc2
17:43:41.384   27.8s item/completed agentMessage turn=5540cd071151 text='{"mc_envelope":1,"message_id":"m-normal-f8d745","kind":"reply","ack":true,"reply":"I am running ./build.sh without editing any files."}' id=9e47242cc2
17:43:43.595   30.0s item/started agentMessage turn=5540cd071151 id=4f49145985
17:43:44.592   31.0s item/completed agentMessage turn=5540cd071151 text='{"mc_envelope":1,"message_id":"m-urgent-7f8dda","kind":"reply","ack":true,"reply":"Yes, the shell reports an active session and no exit status yet."}' id=4f49145985
17:43:50.263   36.7s terminalInteraction (model polls the running command)
17:43:58.179   44.6s terminalInteraction (model polls the running command)
17:44:06.059   52.5s terminalInteraction (model polls the running command)
17:44:10.251   56.7s item/completed commandExecution turn=5540cd071151 `/bin/zsh -lc ./build.sh` pid=77011 status=failed exit=3 ms=40647 out='BUILD-START 2026-11-05T17:43:30Z\nBUILD-TOKEN-d934005a\nBUILD-END 2026-11-05T17:44:10Z\n'
17:44:10.255   56.7s -> turn/steer clientUserMessageId=m-late-7aa003 expectedTurnId=01a1acce-d42d-70e0-9804-5540cd071151 (late: after command completion)
17:44:10.526   57.0s <- turn/steer ok=True turnId=01a1acce-d42d-70e0-9804-5540cd071151
17:44:11.479   57.9s item/started userMessage turn=5540cd071151 clientId=m-late-7aa003
17:44:11.480   57.9s item/completed userMessage turn=5540cd071151 clientId=m-late-7aa003
17:44:16.301   62.7s item/started agentMessage turn=5540cd071151 id=e78cd89360
17:44:16.434   62.9s item/completed agentMessage turn=5540cd071151 text='{"mc_envelope":1,"message_id":"m-late-7aa003","kind":"reply","ack":true,"reply":"The build returned exit status 3."}' id=e78cd89360
17:44:16.438   62.9s item/started agentMessage turn=5540cd071151 id=8e71ea3fa8
17:44:16.442   62.9s item/completed agentMessage turn=5540cd071151 text='BUILD RESULT exit=3 last=BUILD-TOKEN-d934005a' id=8e71ea3fa8
17:44:17.355   63.8s turn/completed turn=01a1acce-d42d-70e0-9804-5540cd071151 status=completed
17:44:17.357   63.8s probe ends stdin (turn completed, 63.8 s)
17:44:18.429   64.9s child exit code=0 signal=None
```

#### claude-run1

```text
17:34:40.096    0.0s spawn claude -p --permission-mode acceptEdits --tools Bash,Read,Edit,Write,Grep,Glob,Agent --strict-mcp-config --settings {"env":{"CLAUDE_CODE_DISABLE_CLAUDE_MDS"… --append-system-prompt <probe role> --input-format stream-json --output-format stream-json --verbose --replay-user-messages
17:34:40.119    0.0s pid 42200
17:34:57.133   17.0s system/hook_started SessionStart:startup
17:34:59.279   19.2s system/hook_response SessionStart:startup
17:35:02.198   22.1s system/init session=9c584b90-d66d-4035-a7a1-00c77ce2fea9 model=claude-opus-5-5 permissionMode=acceptEdits apiKeySource=none
17:35:05.190   25.1s user isReplay uuid=e9759e5e-095c-4e28-ac6b-f331a50b717d Run `./build.sh` in this directory with your shell tool, in the foregr
17:35:05.235   25.1s assistant tool_use Bash AHmGNnUg9B7u "./build.sh"
17:35:09.239   29.1s -> stdin user uuid=178802b0-af4e-49a0-b37a-330f22192b71 id=m-normal-369a45
17:35:14.238   34.1s -> stdin user uuid=ae31ba77-be76-4b7f-8c74-24aba98067fd id=m-urgent-7d5341
17:35:48.588   68.5s user tool_result AHmGNnUg9B7u is_error=True "Exit code 3\nBUILD-START 2026-11-05T17:35:07Z\nBUILD-TOKEN-a036804b\nBUILD-END 2026-11-05T17:35:47Z"
17:35:48.957   68.9s user isReplay uuid=178802b0-af4e-49a0-b37a-330f22192b71 [mc-message v1 id=m-normal-369a45 priority=normal from=probe-sender]
17:35:48.962   68.9s user isReplay uuid=ae31ba77-be76-4b7f-8c74-24aba98067fd [mc-message v1 id=m-urgent-7d5341 priority=urgent from=probe-sender]
17:35:53.832   73.7s assistant text msg=TBVQyrofsZ '{"mc_envelope":1,"message_id":"m-normal-369a45","kind":"reply","ack":true,"reply":"I\'m not editing any file; I ran ./build.sh in the fixture directory."}\n\n{"mc_envelope":1,"message_id":"m-urgent-7d5341","kind":"reply","ack":true,"reply":"No, it finished and exited with status 3, which the task says is expected."}\n\nBUILD RESULT exit=3 last=BUILD-TOKEN-a036804b'
17:35:54.971   74.9s result/success session=9c584b90-d66d-4035-a7a1-00c77ce2fea9 turns=2 cost_usd=0.0274
17:39:30.267  290.2s deadline note=probe budget reached; SIGTERM to the probe child
17:39:31.998  291.9s child exit code=143 signal=None
-- command_lifecycle (command_uuid → state, in order):
   e9759e5e-095c-4e28-ac6b-f331a50b717d queued
   e9759e5e-095c-4e28-ac6b-f331a50b717d started
   178802b0-af4e-49a0-b37a-330f22192b71 queued
   ae31ba77-be76-4b7f-8c74-24aba98067fd queued
   178802b0-af4e-49a0-b37a-330f22192b71 started
   ae31ba77-be76-4b7f-8c74-24aba98067fd started
   178802b0-af4e-49a0-b37a-330f22192b71 completed
   ae31ba77-be76-4b7f-8c74-24aba98067fd completed
   e9759e5e-095c-4e28-ac6b-f331a50b717d completed
```

#### claude-run2

```text
17:41:20.339    0.0s spawn claude -p --permission-mode acceptEdits --tools Bash,Read,Edit,Write,Grep,Glob,Agent --strict-mcp-config --settings {"env":{"CLAUDE_CODE_DISABLE_CLAUDE_MDS"… --append-system-prompt <probe role> --input-format stream-json --output-format stream-json --verbose --replay-user-messages
17:41:20.346    0.0s pid 54157
17:41:23.710    3.4s system/hook_started SessionStart:startup
17:41:25.157    4.8s system/hook_response SessionStart:startup
17:41:26.111    5.8s system/init session=0e9d3ce8-c854-40fa-a29e-07741dace438 model=claude-opus-5-5 permissionMode=acceptEdits apiKeySource=none
17:41:29.382    9.0s user isReplay uuid=be11fe67-f357-4ffa-b393-128932b54ee6 Run `./build.sh` in this directory with your shell tool, in the foregr
17:41:29.476    9.1s assistant tool_use Bash qafeJ7JVCbi8 "./build.sh"
17:41:33.480   13.1s -> stdin user uuid=95873747-689e-4fae-80c0-98f23257fbd7 id=m-normal-b5142d
17:41:38.478   18.1s -> stdin user uuid=9d7868a3-66ae-404d-8ca3-f09c72b72ec7 id=m-urgent-7348a9
17:42:12.930   52.6s user tool_result qafeJ7JVCbi8 is_error=True "Exit code 3\nBUILD-START 2026-11-05T17:41:32Z\nBUILD-TOKEN-a854c967\nBUILD-END 2026-11-05T17:42:12Z"
17:42:12.931   52.6s -> stdin user uuid=7e52301d-8e00-4164-8127-3e10dbf4c16a id=m-late-bbb829 (late: after tool result)
17:42:13.828   53.5s user isReplay uuid=95873747-689e-4fae-80c0-98f23257fbd7 [mc-message v1 id=m-normal-b5142d priority=normal from=probe-sender]
17:42:13.831   53.5s user isReplay uuid=9d7868a3-66ae-404d-8ca3-f09c72b72ec7 [mc-message v1 id=m-urgent-7348a9 priority=urgent from=probe-sender]
17:42:17.815   57.5s assistant text msg=YcE1Mr1cj9 '{"mc_envelope":1,"message_id":"m-normal-b5142d","kind":"reply","ack":true,"reply":"I\'m not editing any file; I only ran ./build.sh in the fixture directory."}'
17:42:17.836   57.5s assistant tool_use Bash BXSCKDRcS8wA "true"
17:42:19.075   58.7s user tool_result BXSCKDRcS8wA is_error=False "(Bash completed with no output)"
17:42:19.081   58.7s user isReplay uuid=7e52301d-8e00-4164-8127-3e10dbf4c16a [mc-message v1 id=m-late-bbb829 priority=normal from=probe-sender]
17:42:22.794   62.5s assistant text msg=FfGmwzudHD '{"mc_envelope":1,"message_id":"m-urgent-7348a9","kind":"reply","ack":true,"reply":"No, ./build.sh already finished and exited with status 3."}'
17:42:23.020   62.7s assistant tool_use Bash H7kX3rib2zcy "true"
17:42:33.471   73.1s user tool_result H7kX3rib2zcy is_error=False "(Bash completed with no output)"
17:42:36.759   76.4s assistant text msg=qnCVersZ1B '{"mc_envelope":1,"message_id":"m-late-bbb829","kind":"reply","ack":true,"reply":"The build exited with status 3, which is expected by design."}'
17:42:37.188   76.8s assistant tool_use Bash 94ib8xvPEGhS "true"
17:42:44.545   84.2s user tool_result 94ib8xvPEGhS is_error=False "(Bash completed with no output)"
17:42:48.025   87.7s assistant text msg=H3nUh7zSB9 'I ran `./build.sh` once in the foreground. It took about 40 seconds and exited with status 3, as you said it would.\n\nBUILD RESULT exit=3 last=BUILD-TOKEN-a854c967'
17:42:49.008   88.7s result/success session=0e9d3ce8-c854-40fa-a29e-07741dace438 turns=5 cost_usd=0.0447
17:42:49.010   88.7s stdin-end note=as mc streamSession onResultLine replied=['m-normal-b5142d', 'm-urgent-7348a9', 'm-late-bbb829']
17:42:51.469   91.1s child exit code=0 signal=None
-- command_lifecycle (command_uuid → state, in order):
   be11fe67-f357-4ffa-b393-128932b54ee6 queued
   be11fe67-f357-4ffa-b393-128932b54ee6 started
   95873747-689e-4fae-80c0-98f23257fbd7 queued
   9d7868a3-66ae-404d-8ca3-f09c72b72ec7 queued
   95873747-689e-4fae-80c0-98f23257fbd7 started
   9d7868a3-66ae-404d-8ca3-f09c72b72ec7 started
   7e52301d-8e00-4164-8127-3e10dbf4c16a queued
   7e52301d-8e00-4164-8127-3e10dbf4c16a started
   95873747-689e-4fae-80c0-98f23257fbd7 completed
   9d7868a3-66ae-404d-8ca3-f09c72b72ec7 completed
   7e52301d-8e00-4164-8127-3e10dbf4c16a completed
   be11fe67-f357-4ffa-b393-128932b54ee6 completed
```

## Probe source

The exact scripts of the runs above (run 1 used the same files before the run-2
additions, which are gated on `run === '2'`). The extraction command in
[Implementation decision](#implementation-decision) writes them back out.

<!-- probe:common.mjs -->
```js
// Shared pieces of the bounded transport probes (mc/session-message-transport).
// Disposable fixture, probe role text, receiver envelope and the trace writer.
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync, appendFileSync, chmodSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';

export const PROBE_LIMIT_MS = 290_000; // contract: at most 300 s per run

export function makeFixture(root) {
  rmSync(root, { recursive: true, force: true });
  mkdirSync(root, { recursive: true });
  const token = `BUILD-TOKEN-${randomBytes(4).toString('hex')}`;
  writeFileSync(join(root, 'build.sh'), [
    '#!/bin/sh',
    'echo "BUILD-START $(date -u +%Y-%m-%dT%H:%M:%SZ)"',
    'sleep 40',
    `echo "${token}"`,
    'echo "BUILD-END $(date -u +%Y-%m-%dT%H:%M:%SZ)"',
    'exit 3',
    '',
  ].join('\n'));
  chmodSync(join(root, 'build.sh'), 0o755);
  writeFileSync(join(root, 'README.md'), 'Disposable transport-probe fixture. Not a goal.\n');
  execFileSync('git', ['init', '-q', root]);
  execFileSync('git', ['-C', root, 'add', '.']);
  execFileSync('git', ['-C', root, '-c', 'user.name=probe', '-c', 'user.email=probe@invalid', 'commit', '-qm', 'fixture']);
  return { root, token };
}

// The probe's role text, handed through the same channel mc uses for roles
// (codex `-c instructions=…`, claude `--append-system-prompt`).
export const ROLE = [
  'You are a disposable transport-probe build session in a throwaway fixture. Nobody is watching.',
  'mc may send you messages while you work. Each one arrives as user input whose first line is',
  '`[mc-message v1 id=<ID> priority=<normal|urgent> from=<sender>]`, followed by the request.',
  'Such a message never cancels your work: let any running command finish normally.',
  'When you see one, your next assistant text must be ONE message consisting only of this JSON',
  'object on a single line, with nothing before or after it:',
  '{"mc_envelope":1,"message_id":"<ID>","kind":"reply","ack":true,"reply":"<short answer to the request>"}',
  'Write one such message per mc message, in the order you received them, then continue your task.',
].join('\n');

export const TASK = 'Run `./build.sh` in this directory with your shell tool, in the foreground, exactly once. It takes about 40 seconds and exits with status 3 by design; that is expected, do not retry or fix it. When it has finished, end with one final line: `BUILD RESULT exit=<status> last=<its last-but-one output line>`.';

export function mcMessage({ id, priority, body }) {
  return `[mc-message v1 id=${id} priority=${priority} from=probe-sender]\n${body}`;
}

export function messageId(prefix) { return `${prefix}-${randomBytes(3).toString('hex')}`; }

/** Exactly one completed assistant text whose whole content is the envelope. */
export function parseEnvelope(text) {
  if (typeof text !== 'string') return null;
  const trimmed = text.trim();
  if (!trimmed.startsWith('{') || !trimmed.endsWith('}')) return null;
  try {
    const value = JSON.parse(trimmed);
    if (value?.mc_envelope !== 1 || typeof value.message_id !== 'string') return null;
    if (!['ack', 'reply'].includes(value.kind)) return null;
    return value;
  } catch { return null; }
}

/**
 * Run-2 fallback: every line of one completed receiver text block that is, in
 * its entirety, an envelope object. Lines inside ``` fences do not count.
 */
export function parseEnvelopeLines(text) {
  if (typeof text !== 'string') return [];
  const found = [];
  let fenced = false;
  for (const line of text.split('\n')) {
    if (line.trim().startsWith('```')) { fenced = !fenced; continue; }
    if (fenced) continue;
    const envelope = parseEnvelope(line);
    if (envelope) found.push(envelope);
  }
  return found;
}

export function tracer(path) {
  writeFileSync(path, '');
  const t0 = Date.now();
  return (event) => {
    const line = { at: new Date().toISOString(), t: ((Date.now() - t0) / 1000).toFixed(1), ...event };
    appendFileSync(path, `${JSON.stringify(line)}\n`);
    process.stdout.write(`${line.t}s ${JSON.stringify(event).slice(0, 220)}\n`);
  };
}

/** The probe child's environment: no mc goal context, no API keys (subscription route). */
export function probeEnv(extra = {}) {
  const env = { ...process.env };
  for (const name of Object.keys(env)) if (name.startsWith('MC_')) delete env[name];
  for (const name of ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'CLAUDE_API_KEY', 'OPENAI_API_KEY']) delete env[name];
  return { ...env, ...extra };
}
```

<!-- probe:codex-probe.mjs -->
```js
// Codex transport probe: an mc-owned `codex app-server` over stdio, one
// ephemeral thread, one turn running a 40 s foreground build; a normal and an
// urgent message are sent with `turn/steer` while the command runs.
// Usage: node codex-probe.mjs <out-dir> <run-number>
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { mkdirSync, appendFileSync } from 'node:fs';
import { makeFixture, ROLE, TASK, mcMessage, messageId, parseEnvelope, parseEnvelopeLines, tracer, probeEnv, PROBE_LIMIT_MS } from './common.mjs';

const [out, run = '1'] = process.argv.slice(2);
mkdirSync(out, { recursive: true });
const fixture = makeFixture(join(out, `fixture-codex-${run}`));
const trace = tracer(join(out, `codex-run${run}.trace.jsonl`));
const raw = join(out, `codex-run${run}.raw.jsonl`);
// The same session switches and role channel mc's headlessArgs gives `codex exec`.
const args = ['app-server', '--listen', 'stdio://',
  '-c', 'project_doc_max_bytes=0', '-c', 'features.multi_agent=true',
  '-c', `instructions=${JSON.stringify(ROLE)}`];
trace({ ev: 'spawn', bin: 'codex', args: args.map((a) => (a.startsWith('instructions=') ? 'instructions=<probe role>' : a)), cwd: fixture.root, token: fixture.token });
const started = Date.now();
const child = spawn('codex', args, { cwd: fixture.root, stdio: ['pipe', 'pipe', 'pipe'], env: probeEnv() });
trace({ ev: 'pid', pid: child.pid });

let nextId = 1;
const pending = new Map();
const request = (method, params) => new Promise((resolve) => {
  const id = nextId++;
  pending.set(id, { method, resolve });
  const line = JSON.stringify({ jsonrpc: '2.0', id, method, params });
  appendFileSync(raw, `>> ${line}\n`);
  child.stdin.write(`${line}\n`);
});
const notify = (method, params) => { const line = JSON.stringify({ jsonrpc: '2.0', method, params }); appendFileSync(raw, `>> ${line}\n`); child.stdin.write(`${line}\n`); };

const messages = [
  { id: messageId('m-normal'), priority: 'normal', body: 'What file are you working on right now? One short sentence.', afterMs: 4000 },
  { id: messageId('m-urgent'), priority: 'urgent', body: 'Urgent status check: is your build command still running? Answer yes/no and one reason.', afterMs: 9000 },
];
const late = { id: messageId('m-late'), priority: 'normal', body: 'Late question: what exit status did the build return?' };
const state = { threadId: null, turnId: null, sent: 0, commandStarted: false, lateSent: false };

function finish(reason) {
  trace({ ev: 'probe-end', reason, elapsed_s: ((Date.now() - started) / 1000).toFixed(1) });
  try { child.stdin.end(); } catch { /* closed */ }
}
const deadline = setTimeout(() => { trace({ ev: 'deadline', note: 'probe budget reached; SIGTERM to the probe child' }); child.kill('SIGTERM'); }, PROBE_LIMIT_MS);

let buffer = '';
child.stdout.on('data', (chunk) => {
  buffer += chunk.toString('utf8');
  const lines = buffer.split('\n');
  buffer = lines.pop();
  for (const line of lines) {
    if (!line.trim()) continue;
    appendFileSync(raw, `<< ${line}\n`);
    let msg; try { msg = JSON.parse(line); } catch { continue; }
    if (msg.id != null && pending.has(msg.id) && !msg.method) {
      const { method, resolve } = pending.get(msg.id); pending.delete(msg.id);
      trace({ ev: 'response', method, ok: !msg.error, error: msg.error ?? undefined, result: summarizeResult(method, msg.result) });
      resolve(msg);
      continue;
    }
    if (msg.method && msg.id != null) { trace({ ev: 'server-request', method: msg.method, note: 'probe answers decline' }); child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { decision: 'decline' } })}\n`); continue; }
    if (msg.method) onNotification(msg.method, msg.params ?? {});
  }
});
child.stderr.on('data', (chunk) => appendFileSync(raw, `!! ${chunk}`));
child.on('close', (code, signal) => { clearTimeout(deadline); trace({ ev: 'child-exit', code, signal }); });

function summarizeResult(method, result) {
  if (!result) return undefined;
  if (method === 'thread/start') return { threadId: result.thread?.id, model: result.model, modelProvider: result.modelProvider, sandbox: result.sandbox, approvalPolicy: result.approvalPolicy, cwd: result.cwd };
  if (method === 'turn/start') return { turnId: result.turn?.id, status: result.turn?.status };
  if (method === 'initialize') return { userAgent: result.userAgent };
  return result;
}

function onNotification(method, p) {
  const item = p.item;
  if (method === 'item/agentMessage/delta' || method.includes('Delta') || method.endsWith('/delta') || method === 'item/commandExecution/outputDelta') return;
  if (method === 'turn/started') { state.turnId = p.turn?.id; trace({ ev: method, threadId: p.threadId, turnId: p.turn?.id }); return; }
  if (method === 'turn/completed') { trace({ ev: method, threadId: p.threadId, turnId: p.turn?.id, status: p.turn?.status, error: p.turn?.error ?? undefined }); finish('turn completed'); return; }
  if (method === 'thread/tokenUsage/updated') { trace({ ev: method, threadId: p.threadId, turnId: p.turnId, total: p.tokenUsage?.total }); return; }
  if (method === 'item/started' || method === 'item/completed') {
    const base = { ev: method, threadId: p.threadId, turnId: p.turnId, item: item?.type, itemId: item?.id };
    if (item?.type === 'userMessage') return trace({ ...base, clientId: item.clientId, text: (item.content ?? []).map((c) => c.text).join('').slice(0, 120) });
    if (item?.type === 'agentMessage') return trace({ ...base, text: item.text, envelopes: method === 'item/completed' ? (run === '2' ? parseEnvelopeLines(item.text) : [parseEnvelope(item.text)].filter(Boolean)) : undefined });
    if (item?.type === 'commandExecution') {
      trace({ ...base, command: item.command, status: item.status, exitCode: item.exitCode, processId: item.processId, durationMs: item.durationMs, output: item.aggregatedOutput?.slice(-300) });
      if (method === 'item/started' && /build\.sh/.test(String(item.command)) && !state.commandStarted) { state.commandStarted = true; scheduleSends(); }
      // Run 2: a late message, steered the moment the build's completion is seen.
      if (run === '2' && method === 'item/completed' && /build\.sh/.test(String(item.command)) && !state.lateSent) {
        state.lateSent = true;
        trace({ ev: 'send', message_id: late.id, priority: late.priority, expectedTurnId: state.turnId, note: 'late: after command completion' });
        request('turn/steer', { threadId: state.threadId, expectedTurnId: state.turnId, clientUserMessageId: late.id, input: [{ type: 'text', text: mcMessage(late) }] });
      }
      return;
    }
    return trace({ ...base });
  }
  if (method.startsWith('hook/')) return trace({ ev: method, ...p });
  trace({ ev: method });
}

function scheduleSends() {
  for (const m of messages) setTimeout(async () => {
    trace({ ev: 'send', message_id: m.id, priority: m.priority, threadId: state.threadId, expectedTurnId: state.turnId });
    await request('turn/steer', { threadId: state.threadId, expectedTurnId: state.turnId, clientUserMessageId: m.id, input: [{ type: 'text', text: mcMessage(m) }] });
  }, m.afterMs);
}

const init = await request('initialize', { clientInfo: { name: 'mc-transport-probe', title: 'mc transport probe', version: '0' } });
if (init.error) { finish('initialize failed'); } else {
  notify('initialized', {});
  const thread = await request('thread/start', { cwd: fixture.root, sandbox: 'danger-full-access', approvalPolicy: 'never', ephemeral: true });
  state.threadId = thread.result?.thread?.id;
  if (!state.threadId) finish('no thread');
  else await request('turn/start', { threadId: state.threadId, clientUserMessageId: 'task-1', input: [{ type: 'text', text: TASK }] });
}
```

<!-- probe:claude-probe.mjs -->
```js
// Claude transport probe: `claude -p` with mc's headless flags and stream-json
// in/out, plus --replay-user-messages. A normal and an urgent message are
// written to stdin while the 40 s foreground Bash build runs.
// Usage: node claude-probe.mjs <out-dir> <run-number>
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { mkdirSync, appendFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { makeFixture, ROLE, TASK, mcMessage, messageId, parseEnvelope, parseEnvelopeLines, tracer, probeEnv, PROBE_LIMIT_MS } from './common.mjs';

const [out, run = '1'] = process.argv.slice(2);
mkdirSync(out, { recursive: true });
const fixture = makeFixture(join(out, `fixture-claude-${run}`));
const trace = tracer(join(out, `claude-run${run}.trace.jsonl`));
const raw = join(out, `claude-run${run}.raw.jsonl`);
// mc's headlessArgs for claude (src/mc/run-plan.js:438) plus --replay-user-messages.
const settings = JSON.stringify({ env: { CLAUDE_CODE_DISABLE_CLAUDE_MDS: '1', CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1', CLAUDE_CODE_PROMPT_CACHE_TTL: '5m', CLAUDE_CODE_SUBAGENT_PROMPT_CACHE_TTL: '5m' } });
const args = ['-p', '--permission-mode', 'acceptEdits', '--tools', 'Bash,Read,Edit,Write,Grep,Glob,Agent', '--strict-mcp-config',
  '--settings', settings, '--append-system-prompt', ROLE,
  '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose', '--replay-user-messages'];
trace({ ev: 'spawn', bin: 'claude', args: args.map((a) => (a === ROLE ? '<probe role>' : a)), cwd: fixture.root, token: fixture.token });
const started = Date.now();
const child = spawn('claude', args, { cwd: fixture.root, stdio: ['pipe', 'pipe', 'pipe'], env: probeEnv({ MC_HEADLESS: '1' }) });
trace({ ev: 'pid', pid: child.pid });
child.stdin.on('error', (error) => trace({ ev: 'stdin-error', error: error.message }));

const write = (text, uuid) => {
  const line = JSON.stringify({ type: 'user', message: { role: 'user', content: text }, parent_tool_use_id: null, session_id: '', uuid });
  appendFileSync(raw, `>> ${line}\n`);
  child.stdin.write(`${line}\n`);
};
const messages = [
  { id: messageId('m-normal'), priority: 'normal', body: 'What file are you working on right now? One short sentence.', afterMs: 4000, uuid: randomUUID() },
  { id: messageId('m-urgent'), priority: 'urgent', body: 'Urgent status check: is your build command still running? Answer yes/no and one reason.', afterMs: 9000, uuid: randomUUID() },
];
const late = { id: messageId('m-late'), priority: 'normal', body: 'Late question: what exit status did the build return?', uuid: randomUUID(), sent: false };
const replied = new Set();
let commandStarted = false;
let results = 0;
const deadline = setTimeout(() => { trace({ ev: 'deadline', note: 'probe budget reached; SIGTERM to the probe child' }); child.kill('SIGTERM'); }, PROBE_LIMIT_MS);
function maybeEnd(reason) {
  if (results > 0 && replied.size === messages.length) { trace({ ev: 'probe-end', reason, elapsed_s: ((Date.now() - started) / 1000).toFixed(1) }); try { child.stdin.end(); } catch { /* closed */ } }
}

let buffer = '';
child.stdout.on('data', (chunk) => {
  buffer += chunk.toString('utf8');
  const lines = buffer.split('\n');
  buffer = lines.pop();
  for (const line of lines) {
    if (!line.trim()) continue;
    appendFileSync(raw, `<< ${line}\n`);
    let e; try { e = JSON.parse(line); } catch { continue; }
    onEvent(e);
  }
});
child.stderr.on('data', (chunk) => appendFileSync(raw, `!! ${chunk}`));
child.on('close', (code, signal) => { clearTimeout(deadline); trace({ ev: 'child-exit', code, signal }); });

function onEvent(e) {
  const base = { ev: `${e.type}${e.subtype ? `/${e.subtype}` : ''}`, session_id: e.session_id, uuid: e.uuid };
  if (e.type === 'stream_event') return;
  if (e.type === 'system' && e.subtype === 'init') return trace({ ...base, model: e.model, tools: e.tools, permissionMode: e.permissionMode, apiKeySource: e.apiKeySource, cwd: e.cwd });
  if (e.type === 'system') return trace({ ...base, hook: e.hook_name ?? e.hook_event ?? undefined, keys: Object.keys(e) });
  if (e.type === 'assistant') {
    for (const block of e.message?.content ?? []) {
      if (block.type === 'tool_use') {
        trace({ ...base, block: 'tool_use', tool: block.name, tool_use_id: block.id, input: block.input });
        if (block.name === 'Bash' && /build\.sh/.test(String(block.input?.command)) && !commandStarted) {
          commandStarted = true;
          for (const m of messages) setTimeout(() => { trace({ ev: 'send', message_id: m.id, priority: m.priority, uuid: m.uuid }); write(mcMessage(m), m.uuid); }, m.afterMs);
        }
      } else if (block.type === 'text') {
        const envelopes = run === '2' ? parseEnvelopeLines(block.text) : [parseEnvelope(block.text)].filter(Boolean);
        for (const envelope of envelopes) replied.add(envelope.message_id);
        trace({ ...base, block: 'text', message_id: e.message?.id, text: block.text, envelopes });
      }
    }
    return;
  }
  if (e.type === 'user') {
    const content = e.message?.content;
    if (typeof content === 'string') return trace({ ...base, isReplay: e.isReplay, text: content.slice(0, 120) });
    for (const block of content ?? []) {
      if (block.type === 'tool_result') {
        trace({ ...base, block: 'tool_result', tool_use_id: block.tool_use_id, is_error: block.is_error, content: JSON.stringify(block.content).slice(-400) });
        // Run 2: a late message, written the moment the build's result is seen.
        if (run === '2' && commandStarted && !late.sent) { late.sent = true; trace({ ev: 'send', message_id: late.id, priority: late.priority, uuid: late.uuid, note: 'late: after tool result' }); write(mcMessage(late), late.uuid); }
      }
      else trace({ ...base, isReplay: e.isReplay, block: block.type, text: String(block.text ?? '').slice(0, 160) });
    }
    return;
  }
  if (e.type === 'result') {
    results += 1;
    trace({ ...base, num_turns: e.num_turns, is_error: e.is_error, duration_ms: e.duration_ms, total_cost_usd: e.total_cost_usd, usage: e.usage, result: String(e.result ?? '').slice(0, 300) });
    // Run 2 is mc-faithful: streamSession ends stdin at the first result line.
    if (run === '2' && results === 1) { trace({ ev: 'stdin-end', note: 'as mc streamSession onResultLine', replied: [...replied] }); try { child.stdin.end(); } catch { /* closed */ } return; }
    maybeEnd('result with every message replied');
    return;
  }
  trace({ ...base });
}

write(TASK, randomUUID());
```
