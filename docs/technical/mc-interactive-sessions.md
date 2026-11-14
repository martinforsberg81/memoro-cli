# Interactive sessions across SSH

## Platform boundary

On Linux, an interactive `mc plan <programme>`, `mc manager` (`mc brief`),
`mc helper` or `mc martin` launched through SSH uses provider persistence:
Claude Code background sessions and, for Codex only, the tmux transport.
Eligibility requires Linux, `SSH_CONNECTION` or `SSH_TTY`, an interactive
terminal and absence of `MC_HEADLESS=1`.

Provider resolution precedes the transport decision. In particular,
`--resume <id>` selects its conversation's provider even without a tool flag.
macOS, Linux local terminals, pipes, noninteractive calls and headless calls
keep the foreground path. Helper collection/intake and manager headless tasks
keep their existing paths. No shell, SSH, daemon-service or personal tmux
configuration is changed.

## Claude: open and reconnect

Use the same entrance after reconnecting, for example:

```sh
ssh tc
mc plan <programme> --claude
```

A desk is the work root, area, normalized role and programme. Several Claude
background sessions may coexist at one desk. A session exists until its
provider process exits, including while idle or detached; the last turn and
the number of attached terminals do not determine its lifetime.

With no session, the entrance starts one with `--bg` and attaches with
`attach <id>`. Otherwise the existing numbered `select` prompt lists each
session's name and started time, plus “start a new one”. Joining never sends
a turn, replaces another session or kills a provider. `Ctrl+Z` detaches;
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
The name is passed through `--name`. Roles normalize as for session identity:
`brief` is `manager`, and `plan-session` is `plan`.

Claude must already trust the area. If `--bg` reports “Workspace not trusted”,
mc refuses visibly; open that directory once in Claude Code and accept its
native trust prompt, then retry. mc does not edit Claude's trust settings or
answer a trust prompt on the person's behalf.

## Claude: launch, environment and registration

`work-open.js` constructs one interactive launch plan: conversation selection,
provenance, model, instructions, permissions, argv, identity, billing and role
record. Foreground launches, the Codex tmux worker and the Claude background
path all use it. `session-entrance.js` owns desk agreement, join/new selection,
flag rules, names, registration and the post-client status line. Its provider
driver supplies `list`, `start` and `join`; `claude-background.js` implements
that driver with agents discovery, settings, background launch and attachment.
It resolves the executable through the provider adapter, never a separate
binary choice.

Claude's daemon supplies the provider process environment, not the launching
mc process. The background launch therefore merges the adapter's settings
and every `SESSION_IDENTITY_ENV` member into one settings document. Absent
identity members are empty strings, overriding any old goal/headless identity
in the daemon. Readers treat empty identity as absent. `MC_HOME` and
`MC_WORK_ROOT` also name the current root, not the daemon's first caller.
The process invoking `--bg` receives the same allowlisted, runtime-secret-free
and provider-key-free environment as the terminal transport. It carries no
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

## Codex: tmux transport

There is one Codex terminal per work root, area, normalized role and programme,
on a work-root-specific tmux socket. The existing worker runs the shared
opener and owns foreground registration for as long as the provider runs.
An existing terminal is joined, without an extra provider turn. Several
clients may view it. `Ctrl-B`, then `D` detaches; lost SSH leaves it running.
When the provider exits, the worker unregisters and the terminal ends.

While it is live, `--new`, `--resume` and `--model` are refused. A matching
explicit provider flag joins; a different or unconfirmed provider is refused.
Atomic tmux creation arbitrates simultaneous openers. No entrance kills or
respawns someone else's session. Missing tmux or failed creation/attachment
is visible, with no fallback to a fragile SSH foreground launch.

The single-use request in `runner/interactive-requests/` contains launch
options, not environment or credentials (0600 file, 0700 directory). The
worker consumes it. Launch environment is allowlisted; tmux supplies TERM.
The private server uses `/dev/null` configuration; mouse scrolling, hidden
status and history limit are session settings, never personal/global edits.

## Old owners and survival limits

Existing foreground or tmux providers are not moved into Claude's daemon.
The old-owner check still refuses a second provider for the same desk or the
exact area cwd, naming the live pid. Background rows with matching registration
are recognized rather than mistaken for old owners. Descendant goal worktrees
are separate. Return to an old owner's terminal and exit it there; mc never
kills it, removes provider locks or rewrites history to force entry.

These paths protect against transport loss, not host reboot, power loss or
explicit provider termination. The host must allow detached user processes.
Claude's daemon runs on demand, not as an mc-installed service.

## Evidence boundary

`tests/mc/claude-background.test.js` protects routing, entrance choice,
conversation exclusion, identity, credentials, holder lifetime and registration
with injected process, agents, register, filesystem, gateway and clock
boundaries. Existing work-open, foreground, session-role and billing tests
retain their protection. A bounded real-binary pty check separately measures
Claude launch, SIGHUP survival, rejoin, suffix naming and tool environment.
It does not certify a real Mac→TC SSH logout, host reboot, or future Claude CLI
changes to `agents --json` and `--bg`. The programme's probe used Claude Code
2.1.325.
