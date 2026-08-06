# mc command and support matrix

**Status:** current. Published by PR 11A, which removed the legacy local
implementation. If a command is not listed here it does not exist.

mc manages coding sessions on a machine. It does not require a Git repository:
a repository is one thing a session's workspace may happen to be, alongside a
worktree, a checkout, or an ordinary directory. Plain `mc` lists your sessions.

## Sessions

| Command | Does |
|---|---|
| `mc new <name> [objective]` | Create a session in the current directory. Creates no branch and no worktree. |
| `mc open <name>` | Attach to the live runtime, or start/resume one. `--cwd` associates another directory. |
| `mc resume <name>` | Alias for `mc open`. |
| `mc restart <name>` | Stop the runtime and open again. Removes nothing. |
| `mc list` | Local sessions from disk, cloud sessions from Memoro. No sockets, no network for the local half. |
| `mc status <name>` | Durable session, workspace, and runtime state. |
| `mc rename <old> <new>` | Rename metadata. Identity and workspaces are untouched. |
| `mc cd <name>` | Print or enter an associated directory. `--workspace <id>` selects among several. |
| `mc attach <name>` | Attach to the exact live terminal. |
| `mc sessions send <name> <text>` | Write to that terminal. |
| `mc sessions read <name>` | Read its bounded current screen. |
| `mc end <name>` | Stop and archive. Keeps every workspace and every Git resource. |
| `mc cleanup <name> --dry-run\|--apply` | Remove only resources whose receipt proves mc created them. |
| `mc delete <name> --force` | Delete an archived session home. |

## Maintenance

| Command | Does |
|---|---|
| `mc doctor [--repair]` | Diagnose, and apply loss-free catalog and stale-runtime repairs. |
| `mc storage status\|explain\|repair` | Summarize, explain, or repair durable and ephemeral state. |
| `mc gc [--dry-run\|--apply]` | Remove stale runtime homes. Never a Git resource. |
| `mc migrate [--session <name>]` | The one-time move from pre-V1 storage. Nothing else migrates. |

## Setup and capabilities

| Command | Does |
|---|---|
| `mc setup` | Verify local setup. |
| `mc install-shell` | Install shell directory-change support. |
| `mc auth status` | Memoro and coding-tool readiness. |
| `mc connections` | Manage connected services. |
| `mc github status\|pr …` | The typed GitHub App capability. Repository-scoped by nature. |
| `mc coding-profile read\|diff\|write` | The durable Coding Profile. |
| `mc vault …` | The token vault. |
| `mc tool-auth` | Coding-tool credentials. |
| `mc dev`, `mc deps` | Dev services and dependency snapshots. Repository-scoped by nature. |
| `mc cloud-session`, `mc cloud-runtime` | Cloud-owned sessions. Separately source-owned. |
| `mc security` | Security checks. |

## Removed

These existed before the V1 cutover and are gone. Nothing forwards to them.

| Was | Why it is gone |
|---|---|
| bare `mc` wrapping a coding tool | A session is created with `mc new` and entered with `mc open`. Wrap mode was gated on being inside a repository; nothing in mc is any more. |
| `mc wrap <label>` | Same. |
| `mc spawn` | Created a branch and worktree per session. Workspaces are associations now, not resources mc creates implicitly. |
| `mc broker …` | There is no global broker. Each session owns its runtime host under `run/`. |
| `mc supervisor` | Supervised the global broker. |
| `mc reconcile` | Reconciled the global registry, which no longer exists. |
| `mc fanout`, `mc gather` | Plan-driven multi-session orchestration built on the registry. |
| `mc sessions watch\|stop\|remove` | Broker-owned session control. `mc end`, `mc restart`, and `mc delete` own these outcomes. |

`registry.json`, `hosts/`, `managed-sessions/`, `managed-session-identities/`,
and the broker sockets are read only by the migrator, which is finite. After
`mc migrate` completes they are quarantined with a backup and an interlock
that stops an older binary from writing to them.

## Not covered here

Cloud-side storage and the V1 control-plane API are `memoro`'s side of the
plan (PRs 3–4) and are not required for local sessions to work.
