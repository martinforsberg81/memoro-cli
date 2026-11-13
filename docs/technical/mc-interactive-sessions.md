# Interactive sessions across SSH

## Platform boundary

On Linux, an interactive `mc plan <programme>`, `mc manager` (`mc brief`),
`mc helper` or `mc martin` launched through SSH opens a persistent tmux
terminal. Both Codex and Claude use the same transport. Automatic selection
requires Linux, `SSH_CONNECTION` or `SSH_TTY`, an interactive terminal and
absence of `MC_HEADLESS=1`.

macOS keeps the existing foreground launch, including when SSH variables
are present. Linux local terminals, pipes, noninteractive calls and headless
execution keep their existing paths. Helper collection/intake and manager
headless tasks do not go through the interactive opener. No Mac tmux setup,
shell startup edits or SSH configuration changes are required.

## Open and reconnect

Use the same entrance after reconnecting, for example:

```sh
ssh tc
mc plan <programme> --codex
```

An existing terminal is joined before transcript discovery or provider launch.
The same provider process, in-progress turn and foreground ownership remain.
Several clients may view the same terminal; attaching does not disconnect the
other clients. `Ctrl-B`, then `D` detaches deliberately. A lost SSH client
also leaves the worker running. No provider turn or refresh prompt is injected
when joining a live session; use the desk's existing read commands for fresh
information.

There is one terminal per work root, area, normalized role and programme.
The work root also namespaces a separate tmux socket. This prevents the server
and Mac, or separate roots on one host, from sharing ownership accidentally.
`plan`/`plan-session` and `brief`/`manager` normalize consistently with existing
launch identity. Separate programmes and desks keep separate terminals.

While a terminal is live, `--new`, `--resume` and `--model` are refused rather
than replacing or duplicating work. A matching explicit provider flag joins;
a different or not-yet-confirmed provider is refused. Exit the running provider
before making a different selection. tmux's atomic session creation arbitrates
simultaneous openers: an ordinary loser joins the winner, and a conflicting
loser refuses. No caller kills or respawns somebody else's live session.

After the provider actually exits, its worker unregisters and its tmux session
ends. The next entrance uses ordinary conversation discovery, role provenance,
model selection, current executable resolution and billing configuration.
This also applies after a provider exits for an update. Reattachment to a
running provider retains that process's original environment and version.

## Old foreground processes and failures

A provider opened before this transport existed cannot be moved into tmux.
Before starting a new terminal, the opener checks live foreground records for
the same owner and Linux `codex`/`claude` processes at the exact area cwd.
A match refuses the new launch with the owning PID. Descendant goal worktrees
are separate; their providers do not block the programme's planning terminal.
Dead records are not owners. These checks do not infer historical role authority
and do not replace the transcript provenance checks used on an actual resume.

Return to the old terminal and exit that provider. If its terminal is no longer
accessible, identify the exact process before explicitly terminating it. mc
never removes provider locks, rewrites history or kills the old process to
force entry. A live native conversation lock must not be bypassed. This refusal
prevents the observed case of a second Codex opening against the old process's
conversation and reporting that another app owns it.

Missing tmux, failed creation or failed attachment is visible. There is no
fallback that silently launches a provider on the fragile SSH terminal. Retry
the entrance after correcting the failure. A failed attachment may leave the
successfully started terminal available for a later connection.

This protects against SSH transport loss, not host reboot, power loss or an
explicit OS/process termination. The host must permit detached user processes
(the observed TC setup has user lingering enabled). No runner/service settings
are changed by these entrances.

## Implementation and environment

`openInWorkArea` delegates eligible entrances to `interactive-terminal.js`.
A tmux worker (`interactive-terminal-worker.js`) runs the existing opener,
including its provider adapters, permissions, role instructions, billing route
and foreground registration. The worker, rather than an attached SSH client,
owns that existing registration. No second conversation registry is maintained.

The private single-use request under `runner/interactive-requests/` contains
launch options, not the environment, credentials or provider output. Its file
mode is `0600`, and a newly created request directory is `0700`. The worker
consumes the file before opening the provider; failed and losing creations
remove their own requests. A successful creation owns its request even if the
client fails to attach. An abrupt interruption before creation can leave an
unused request; it is not a live-session record.

Each fresh launch explicitly supplies current home/user, executable PATH,
locale, terminal color, temporary directory, XDG directory and mc/provider home
settings. Provider API keys, runtime secret names, inherited goal/role/headless
identity and arbitrary environment values are excluded. tmux supplies the pane's
TERM. An older tmux server cannot contribute stale launch identity or PATH.
No environment values are written in a request or mc log.

The mc-specific tmux server starts with `/dev/null` configuration; personal tmux
startup settings cannot destroy its detached sessions. Mouse scrolling, hidden
status and the existing history limit are session settings, not global changes
to the person's own tmux. In an existing unrelated tmux terminal the SSH client
may attach as a nested client; the outer terminal is not switched or replaced.

## Evidence boundary

`tests/mc/work-open.test.js` protects transport eligibility, shared-opener
routing, single-worker reattachment, conflicts, creation races, old-owner
refusal and fresh nonsecret environment composition. Existing provider and
entrance tests protect the ordinary launch behavior. These checks substitute
the tmux boundary; they do not prove SSH or tmux process survival.

Real Linux tmux/SSH survival is checked separately with isolated roots and an
inert provider, retaining worker PID, terminal and foreground evidence before
and after disconnect/reconnect. It does not make a paid provider call or certify
host reboot recovery.
