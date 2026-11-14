# Interactive sessions across SSH

For entrances from another computer with a configured server, see
[mc server: configuration, remote driver and local Codex client](mc-server.md).
The provider mechanics below also serve that server half.

## Platform boundary

On Linux, an interactive `mc plan <programme>`, `mc manager` (`mc brief`),
`mc helper` or `mc martin` launched through SSH keeps its provider alive past
the terminal: a Claude Code background session, or a Codex `app-server` of its
own. Eligibility requires Linux, `SSH_CONNECTION` or `SSH_TTY`, an interactive
terminal and absence of `MC_HEADLESS=1`. No tmux is used by either provider.

Provider resolution precedes the transport decision. In particular,
`--resume <id>` selects its conversation's provider even without a tool flag.
macOS, Linux local terminals, pipes, noninteractive calls and headless calls
keep the foreground path. Helper collection/intake and manager headless tasks
keep their existing paths. No shell, SSH or daemon-service configuration is
changed.

The entrance rules below (desk, join or new, naming, registration) are the
same for both providers: `session-entrance.js` owns them and a provider driver
supplies `list`, `start` and `join`. `work-open.js` chooses the driver by the
resolved provider.

## Open and reconnect

Use the same entrance after reconnecting, for example:

```sh
ssh tc
mc plan <programme> --claude
```

A desk is the work root, area, normalized role and programme. Several sessions
may coexist at one desk. A session exists until its provider process exits,
including while idle or detached; the last turn and the number of attached
terminals do not determine its lifetime, except by the end rule of a Codex
session below.

With no session, the entrance starts one (Claude: `--bg`, then `attach <id>`;
Codex: its own server, then a `--remote` client) and attaches. Otherwise the
existing numbered `select` prompt lists each session's name and started time, plus “start a new one”. Joining never sends
a turn, replaces another session or kills a provider. Claude: `Ctrl+Z` detaches;
losing SSH or closing the attaching terminal leaves the provider in Claude's
background daemon. After attach returns, mc reports whether the session is
still running and names the entrance to rejoin.

- `--new` starts a fresh conversation without asking.
- `--resume <id>` joins a session already holding that conversation. Otherwise
  it starts a background session resuming the conversation. Matching live
  registration supplies identity evidence even before a transcript exists.
- `--resume` without an id keeps the compatible conversation picker. Choosing
  a held conversation joins it instead of running it again.
- `--model` or a different explicit provider flag with a join is refused.
  Those choices apply only to starts.
- “Start a new one” without flags uses the most recent compatible conversation
  not held by an existing process, otherwise starts fresh. A conversation is
  never deliberately run by two processes. A per-desk selection lock spans
  discovery through provider registration, not attachment; a concurrent
  selector is asked to retry, not allowed to race the first start. The Linux
  advisory flock follows the selector's pipe lifetime, releasing on client death
  without reaping or replacing a stale lock inode. During startup the detached
  holder inherits the pipe until provider registration, so losing the client
  cannot release selection while its provider is still being started.

Names are `mc <role> <programme>`, or `mc <role>` for a desk without a
programme. Additional sessions take the lowest unused suffix: ` 2`, ` 3`, …
Claude receives the name through `--name`; Codex keeps it in its session record.
Roles normalize as for session identity:
`brief` is `manager`, and `plan-session` is `plan`.

Every folder mc opens Claude in is trusted before Claude starts, foreground
or background; no session waits on, or is refused for, Claude's trust prompt
(Martin, 2026-11-14). `claude-trust.js` records
`projects[<realpath of the launch folder>].hasTrustDialogAccepted: true` in
Claude's global config (`$CLAUDE_CONFIG_DIR/.claude.json`, else
`~/.claude.json`), the key Claude itself names as the alternative to its
dialog. Claude finds a folder's trust at the folder or above it up to its
git root, so the launch folder is sufficient. An existing record is never
rewritten. A write takes Claude's own `<file>.lock` directory lock (10 s
stale), merges only that key and replaces the file atomically with its
mode kept; an unreadable config or a lock that stays held is logged
(`work.claude-trust-failed`) and leaves the file untouched, and the launch
continues to Claude's own answer. mc changes no other Claude setting.

## Claude: launch, environment and registration

`work-open.js` constructs one interactive launch plan: conversation selection,
provenance, model, instructions, permissions, argv, identity, billing and role
record. Foreground launches and both persistent paths use it.
`session-entrance.js` owns desk agreement, join/new selection, flag rules,
names, registration and the post-client status line. `claude-background.js`
implements the driver with agents discovery, settings, background launch and
attachment; `codex-sessions.js` implements it for Codex. Each resolves the
executable through the provider adapter, never a separate binary choice.

Claude's daemon supplies the provider process environment, not the launching
mc process. The background launch therefore merges the adapter's settings
and every `SESSION_IDENTITY_ENV` member into one settings document. Absent
identity members are empty strings, overriding any old goal/headless identity
in the daemon. Readers treat empty identity as absent. `MC_HOME` and
`MC_WORK_ROOT` also name the current root, not the daemon's first caller.
The process invoking `--bg` receives an allowlisted, runtime-secret-free
and provider-key-free environment (`terminalEnvironment`). It carries no
caller identity. No launch changes `~/.claude` settings, daemon configuration
or the person's shell.

Each start uses a detached holder and a private directory under
`runner/claude-background/` (0700), with settings/request files of mode 0600.
On plan billing the holder needs no gateway. On credits it opens the bounded
gateway grant as described in [mc-run.md § Billing](mc-run.md#billing), using
settings env `ANTHROPIC_BASE_URL` and `ANTHROPIC_AUTH_TOKEN`, never argv. The
provider key stays in the trusted holder. Unavailable billing refuses the
start. The holder removes its directory when the provider dies or its grant
expires. Neither the short-lived `--bg` launcher nor the attaching terminal
owns this cleanup or the gateway lifetime.

Discovery reads `agents --json` and the foreground register together. Only
matching live provider pids at the exact cwd and desk count. Each new session
registers the provider pid from the agents row, with verb, area, programme,
short tool name, model and role record. No launcher-exit hook releases that
entry. The existing writer sweep removes dead entries, and the page's
liveness check omits them immediately. There is no second session registry.
An unreadable agents response is a discovery failure, not an empty desk.
After a successful launch, a failed read or delayed agents row leaves the
holder reconciling that start, with its grant and inherited desk lock intact.
After 50 unsuccessful polls it reports the measured discovery problem to the client;
client exit does not stop reconciliation. The holder registers the observed
provider pid before releasing selection, so the next entrance can join it.
A discovery timeout never authorizes another start or kills the provider.
Before launch the holder writes a 0600 nonsecret pending intent beside its
private directory: desk/launch identity and the agents ids seen before start.
If the grant expires before discovery recovers, the holder closes its gateway,
removes the settings directory and exits, retaining only that intent. The next
entrance reconciles it with agents and registers the observed provider before
offering join; a pending intent with no unambiguous provider row refuses a
second start. Observing that provider dead also removes the intent. Registration
empties the intent, as an outbox; it never counts as a session and never renews
a grant. Persistent discovery failure therefore refuses new starts rather than
risking two processes on one conversation.
The holder writes `work.open` provenance using the observed conversation id:
Claude 2.1.325's background launcher assigns its own id despite `--session-id`.
This keeps ordinary compatible conversation selection working after exit.

## Codex: its own app-server

Each Codex entrance session is a detached `codex app-server --listen
unix://<dir>/app.sock` that mc starts, in the desk's worktree. The person's
terminal runs `codex --remote unix://<dir>/app.sock` as a client of it. The
server holds the conversation, so a lost terminal leaves it alive. `codex
app-server daemon bootstrap` and Codex's shared daemon are not used: the server
belongs to one session.

**Session directory.** `<work root>/runner/codex-sessions/session-XXXXXX/`,
created 0700 and verified user-owned and not group- or world-accessible before
any server starts in it; a loose directory is refused. It holds `app.sock`,
`server.log` (0600; the server's output, whose tail is named when a start
fails), `session.json` (name, server pid, worktree, socket, the conversation
resumed at start, new-thread access flags, started time; written after the spawn,
atomically) and
`clients/` (one file per attached mc process, named by its pid). Nothing is
written outside mc's work root. A long socket path is symlinked by Codex into
`/tmp/codex-daemon-<uid>/`; mc follows the link when it speaks to the server.

**Launch.** `codexSessionDriver` splits the launch plan's argv (the same plan
every provider path uses; there is no second Codex argv builder) into two:

- Server argv: root-level `-c <key=value>` pairs, then `app-server --listen
  unix://<socket>`. The server has no `--model`, `--sandbox` or `--add-dir`, so
  `-m`, `--sandbox`, `--ask-for-approval` and `--add-dir` become `model`,
  `sandbox_mode`, `approval_policy` and `sandbox_workspace_write.writable_roots`.
  `developer_instructions`, `project_doc_max_bytes` and the other `-c` entries
  go here too. Model, effort and role instructions reach a TUI-started thread
  from the server. Access is different in Codex 0.168.0: a new thread takes
  sandbox and approval from the client, not these server settings. A flag
  with no app-server equivalent refuses the launch, by name.
- New-thread client argv: the launch plan's `--sandbox <mode>` and, when
  present, `--ask-for-approval <policy>`, then `--remote unix://<socket> [prompt]`.
  Access remains on the server as `-c` too (Martin, 2026-11-14, client_access).
- Resume/join argv: `resume <id> --remote unix://<socket> [prompt]`, with no
  access flags: Codex rejects permission overrides on a remote resume, and a
  loaded thread keeps its existing policy. A thread without a turn has no
  resumable rollout, so joining it starts a thread with the stored plan access.
  Prompts starting with `-` go behind `--`. Neither client carries `-c`, model,
  effort, role instructions or roots; those belong only to the server.

**Environment and billing.** The server runs the session's tools, so its
environment is the launch plan's role identity (`MC_ROLE`, `MC_PROGRAMME`; no
`MC_GOAL`, no `MC_HEADLESS`) with every provider API key and runtime secret
removed. The terminal client gets the same allowlisted environment as the
Claude path, with no role identity. On plan billing the server is the
provider binary. On credits it is started through `gatewayLaunch`, so the
[gateway wrapper](mc-run.md#billing) is the server's parent for the server's
whole life and the grant never appears on argv. The wrapper's one optional
`--session-directory` parameter opts this long-lived server into expiry cleanup.
At the grant's `expiresAt` it stops the server with SIGTERM, closes the gateway,
and removes the session directory and register entry. An attached TUI ends when
its server disconnects. A private one-shot `expired-session-*.json` notice beside
the removed directory lets the next entrance say the session ended because its
gateway grant expired, instead of offering it for join. The conversation stays
resumable with `--resume <id>` in a new session. This is the same bounded grant
lifetime as Claude's holder; there is no automatic renewal. Plan billing has no
grant or expiry clock. Unavailable billing refuses the start with its reason
before anything is created.

**Registration.** A start waits for the server to answer on its socket
(15 s; the log tail is named when it does not), then registers the *server's*
pid in the foreground register with the plan's role record, as the Claude path
does with its provider's pid. The register entry belongs to the server's
lifetime, never to the attaching client's exit. `session-entrance.js` then
requires matching register record, worktree and a live pid before it counts a
row as a session of the desk.

**Which conversation a session holds.** Never remembered, never read from
Codex's global store: it is asked of the session's own server (`thread/loaded/list`
then `thread/read` without turns). A server also holds short-lived helper
threads (a title generator), so the session's thread is the loaded one that is
not ephemeral, has no parent thread and has had a turn, newest `updatedAt`
first. A thread that has had no turn is the session's, but joining is by plain
`--remote`, not `resume`. A server that is running but does not answer within the
bounded deadline (20 s overall, 1 MiB) refuses the entrance with what was measured and
the `kill <pid>` that clears it; it is never treated as an empty desk. An
unreachable socket (ENOENT/ECONNREFUSED) instead means the server is gone even
if its pid is alive (it may have been reused): mc forgets that session and its
register entry, reports what it measured, and never signals that pid. A session
whose server pid is dead is also removed with its register entry. A server whose
worktree is another is not asked.

**End rule.** The session ends only when its person left it, and mc only ever
ends a server the client it ran was attached to. After the client exits, the
server is stopped (`SIGTERM`, bounded wait 5 s) and its directory and register
entry removed only if all hold: the client exited with status 0 (Codex's
`/quit`), no signal ended it, no other mc process is attached (`clients/`),
and no loaded thread is active. Otherwise the session is left running, with a
stderr line naming what was measured: a hangup (SIGHUP), any other signal, a
nonzero status, a client that did not start, a turn still running, another
attached terminal, or a server that could not be asked. The next entrance
offers join or new.

## What survives what

| Event | Claude background | Codex app-server |
|---|---|---|
| Terminal closed / SSH lost (SIGHUP) | survives | survives |
| Clean quit, idle | survives (it is a daemon session) | stops, with directory and register entry |
| Clean quit with a turn running, or other terminal attached | survives | survives |
| Nonzero exit or other signal of the client | survives | survives |
| `mc` itself exits | survives | survives |
| Host reboot, power loss, explicit provider termination | ends | ends |

The host must allow detached user processes. Claude's daemon runs on demand,
not as an mc-installed service. A session or foreground provider that
predates this transport is not adopted: mc does not kill it, remove its locks
or rewrite history to force entry.

## Evidence boundary

`tests/mc/claude-background.test.js` protects routing, entrance choice,
conversation exclusion, identity, credentials, holder lifetime and registration
with injected process, agents, register, filesystem, gateway and clock
boundaries. `tests/mc/codex-sessions.test.js` protects the Codex server and
client argv, environment, directory mode, billing, entrance rules with the
Codex driver, the session-thread rule, the end rule and the rpc limits with
injected spawn, rpc, filesystem, liveness and clock boundaries. Existing
work-open, foreground, session-role and billing tests retain their protection.
Bounded real-binary pty checks separately measure launch, SIGHUP survival,
rejoin, suffix naming and tool environment for each provider. They do not
certify a real Mac→TC SSH logout, host reboot, or future provider CLI changes.
The probes used Claude Code 2.1.325 and the Codex `app-server` of the Codex
CLI installed on TC.
