# Interactive sessions on a configured mc server

## Configuration and routing

mc remains fully usable locally. An optional **single** server changes only the
person's interactive entrances: `mc plan`, `mc manager` (`mc brief`), `mc martin`
and `mc helper`.

```sh
mc server set tc       # any single destination understood by the person's OpenSSH
mc server              # saved destination and its current measured handshake
mc server clear        # return to local entrances
mc manager --local     # this entrance here, without changing the setting
```

`set` runs a version handshake through `ssh <destination>` before saving. An
unreachable host, missing mc, unsuccessful SSH exit or unsupported descriptor
refuses the save, preserving the previous setting. The file is
`<work root>/runner/server.json`, atomically replaced, mode 0600, containing only
`destination`. `clear` removes it. With no setting, the entrance only reads the
absent file: SSH, provider and remote-selection machinery are not loaded.

A configured server is used only at an interactive terminal, without
`MC_HEADLESS=1`. `--local`, pipes/noninteractive calls, headless manager tasks,
helper intake/collection, plan archive, `martin get`, help and every other verb
stay local. In particular, the runner, gates, merges and headless work never
move to the server. `--new`, `--resume`, `--model` and the entrance's provider
flags retain their existing meanings and are forwarded. Programme, goal and
area names belong to the server; they need not exist on the client. Remote
routing precedes local programme/desk creation.

Transport is the person's own `ssh`; mc installs no key, credential, agent,
daemon or network configuration and writes nothing to `~/.ssh` or shell files.
Its setting and temporary files are under the client's mc work root. The local
SSH process retains the caller's `SSH_AUTH_SOCK` to use an existing agent; the
provider TUI does not receive it, and it is not a descriptor member.

## Both halves

`src/mc/server-link.js` is the only SSH-spawning boundary. Its destination,
process, filesystem and clock boundaries are injectable. The small
`server-settings.js` contains setting I/O without loading that boundary.
Every remote shell word is single-quoted by **one** function, `remoteCommand`;
embedded quotes are escaped as POSIX shell literals. Programme names, resume
ids, models, spaces, quotes, semicolons, substitutions and newlines are data,
not remote commands. NUL and option-like SSH destinations are refused.

The client's `server-client.js` supplies a remote driver to
`session-entrance.js`; it does not implement another join-or-new selector. The
server returns the desk's sessions and conversation-selection questions; the
client asks them locally. Starts and joins are revalidated on the server under
its existing desk lock. The server half (`commands/session.js`) invokes the
original entrance, launch plan, conversation selection and provider driver.
Naming, provenance, identity, billing, registration, conversation exclusion and
[provider persistence/end rules](mc-interactive-sessions.md) remain server-owned.

Internal `mc session version|list|start|join <entrance> … --json` calls carry
only the entrance's arguments and already-selected answers. `list` can return
a question for the local terminal to answer before retrying. A Codex `start`
or `join` emits its session descriptor, then holds stdin open through that
client's attachment. Its server-side mc process is the provider driver's
attached-client registration. The only clean-end request is `end\n` on **that
connection**, followed by EOF; there is no unbound stop-by-id operation. EOF
alone is a nonclean client exit, never permission to stop a server. Startup
and connection-close waits are bounded at 30 s; descriptor output at 1 MiB.

Server refusals are shown with the destination: `on tc: open <path> in Claude
once`, for example. SSH failures retain their measured cause (`ssh tc:
connection refused`); discovery failures are not treated as an empty desk.

## Descriptor and versions

`server-protocol.js` defines and validates the single schema on **both** ends.
All envelopes contain `version: 1`, `mcVersion` and `kind`. Unknown versions,
fields, missing required members and invalid values are refused, not guessed;
a schema refusal names both mc versions. mc release versions need not be equal
when both understand the descriptor version.

Envelope kinds are `handshake`; `refusal` (`reason`); `question` (`title`,
`items`, either null or enumerated key/value/name/label rows); `snapshot`
(`provider`, `providerVersion`, `chosen`, `sessions`); `session`; and `result`
(`status`, `signal`). Snapshot members are themselves validated sessions.

A session contains exactly:

- `provider` (`codex` or `claude-code`), `providerVersion` (the server's exact
  `codex --version` or `claude --version` stdout), `id`, `name`, nullable
  `sessionId` (resumable thread/conversation) and nullable `started`.
- For Codex only, `socket`: the server's **real** absolute socket path, and
  `access`: the launch plan's `--sandbox <mode>` and optional
  `--ask-for-approval <policy>` for a new thread, otherwise an empty array.
  A non-null resume target with access flags is refused.
- For Codex only, optional `prompt`: the opening **user message** selected by
  the server's launch plan, initial prompt for a fresh conversation or
  `resumePrompt` for a historical start. A join of an already-running session
  carries no opening message. Empty/nonstring/NUL messages are refused.

No other launch-plan argument crosses: no role/developer instructions, model,
effort, roots, environment, grant, provider key or credential. Access flags and
the opening user message are not credentials. Billing and role configuration
stay entirely on the server, under the
[credential boundary](mc-codebase.md#credential-boundary-normative).

## Codex client

Before any tunnel, the client measures its local `codex --version` and compares
it with the descriptor's provider version, exactly. A mismatch refuses and
names both measurements and the host; mc does not install or upgrade Codex.

The link creates a verified user-owned 0700 directory
`<client work root>/runner/s/c-XXXXXX/` with socket `s`. The complete local path
must be **under 100 bytes**, leaving room under macOS's 104-byte limit. An
unprivate/overlong path refuses before forwarding and removes the directory;
use a shorter `MC_WORK_ROOT` if needed. No fallback writes a socket elsewhere.

```text
ssh -N -o ExitOnForwardFailure=yes -L <local>:<remote> <destination>
codex <descriptor access flags> --remote unix://<local> [prompt]
codex resume <thread> --remote unix://<local> [prompt]
```

The first Codex form starts a thread; the second resumes/joins and carries **no
access flag**, because Codex refuses permission overrides on remote resume.
Either appends the optional opening user message, behind `--` if dash-leading.
Neither carries `-c`, model, effort, role instructions or roots. Typing is local;
provider execution and billing are remote. The server's real socket may be
Codex's own short-path symlink target, not the path mc originally supplied.

A local client exit 0 without signal/error, with both tunnel and connection
intact, sends the connection-bound clean end. The server then applies the
existing rule: stop only if idle and no other mc client is attached. Nonzero
exit, signal, failed startup, tunnel loss or connection loss sends no clean end.
The client stops its owned tunnel and removes the socket directory on return,
including refusals and connection-close errors. A lost tunnel terminates the
local TUI, not the server.

## Claude client

Claude has no local terminal client. The remote driver runs
`ssh -t <destination> <quoted mc session start|join …>` and returns its status;
only the server launches `claude attach`. Refusals there also carry the
forwarded host name. Claude versions are reported by the server, not compared
with a nonexistent local Claude client. Claude's background persistence is
unchanged by attachment or disconnection.

## What survives what

| Event | Server session | Client resources |
|---|---|---|
| Codex clean idle quit, no other client | ends by existing end rule | tunnel/socket removed |
| Codex clean quit while active or another client attached | survives | tunnel/socket removed |
| Codex client nonzero/signal, failed startup or lost link | survives | tunnel/socket removed on client return |
| Claude detach/SSH loss | survives in provider daemon | SSH terminal returns |
| Client sleep or network outage | survives; same entrance offers join | connection may be lost |
| Server reboot/power loss or explicit provider termination | ends | connection fails; history remains resumable |

## Probed versions and upgrade procedure

The bounded TC probes used **Codex CLI 0.168.0** and **Claude Code 2.1.325**.
Claude's launch/settings-env/hooks/background/attach evidence is phase 1's
`mc-server/claude-background-sessions/LOG.md`. Phase 2's Codex probe measured
server-owned model/effort/instructions and client-owned new-thread access in
rollout `turn_context`; a loaded-thread join retained that access. This goal's
one-host substitute probe measures the full configured-client loop separately;
its evidence is in `mc-server/server-client/LOG.md`.

After a Codex or Claude upgrade **on the server**, perform one bounded manual
probe before use. For Codex: one new and one resumed thread, inspecting each
rollout's `turn_context` for `sandbox_policy`, `approval_policy`, `model` and
`effort`, along with the new/resume argv split. For Claude: repeat phase 1's
live check (background launch, role/settings environment, hooks, detach and
attach). Update the recorded provider version and evidence. There is **no**
scheduled, automated, recurring or recurring-paid compatibility probe.

## Evidence limits and residual risks

Injected tests in `tests/mc/server-link.test.js` and
`tests/mc/commands/server.test.js` protect routing, literal argv, strict schema,
version refusal, connection/end lifetime, client argv and private short-socket
cleanup; existing entrance/provider tests retain join/new and end-rule coverage.
They use no real SSH or network. The commissioned live loop uses an SSH
substitute that executes the server command locally and relays a Unix socket,
with isolated client/server roots and at most two short plan-billed turns.

That loop does **not** prove real two-machine OpenSSH unix-socket forwarding,
Mac sleep/reconnect behaviour or macOS-specific limits and Homebrew/npm Codex
installations. Martin's first real Mac-to-server use is the remaining evidence;
no build adds SSH keys or changes host networking to manufacture it.
