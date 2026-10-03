# memoro-cli

Command-line glue between external coding tools (Claude Code, Cursor, Codex, Windsurf, Gemini CLI) and your [Memoro](https://meetmemoro.app) account.

## What it does

One binary, `mc`. Nothing on this machine reports sessions into Memoro any more (ruling 24).

- **Roles → tools.** A session mc starts in a role is handed that role's instructions (`canon/roles/`) through the selected adapter at launch, and nothing else — the Coding Profile it once fetched from Memoro was removed by ruling 24. Repo-owned instruction files such as `CLAUDE.md` and `AGENTS.md` remain static contracts.

The result: every coding tool you use feels like it remembers you.

## Install

Node 22 or later. macOS or Linux.

## Quick start

```sh
mc
mc setup
```

On first run, `mc` signs this machine in to Memoro with browser device auth and stores the token in the OS keychain. Then `mc setup` reads every local probe needed to get you running and prints a numbered checklist of *only* the missing steps — each step is a single command you can paste. On a terminal it also offers a local image/motion resource profile and a project-dependency mode. Pressing Enter keeps the current choices; fresh installs default to no heavy-job limits and safe snapshot reuse. Re-run setup whenever; once everything is green it just confirms.

Then a typical day:

```sh
mc new my-experiment      # branch + worktree + your default coding tool launches in it
# ... work, /exit when done ...
mc end my-experiment      # review status, then permanently delete the local session
```

## `mc` — the terminal coordinator

`mc` is a Memoro-aware wrapper around your coding tool of choice. It owns a worktree per session, registers each session with Memoro so peer sessions on the same account can see and dispatch to each other, and gives you the shell ergonomics that drop the manual `git worktree` / `git branch` ceremony.

```sh
mc setup                  # self-check + resource/dependency choices
mc auth status            # single-screen health check
mc new <name>             # create worktree + branch + launch the tool
mc list                   # show your sessions, filters per §9d of the plan
mc end <name>             # confirm permanent local teardown
mc resume <name>          # cd back into a worktree, relaunch the tool
mc sessions list          # active sessions across machines
mc sessions send <id|label> "<msg>"
```

Under the hood: `mc` runs the tool in a PTY it owns, with your terminal piped transparently to and from it. A WebSocket to Memoro delivers remote dispatches by writing into the tool's PTY stdin — they land as real user turns. No tmux, no Claude Code modifications, terminal-native scrollback works.

## Commands

### `mc` — coordinator + worktree lifecycle

| Command | Purpose |
|---|---|
| `mc` | First run signs in to Memoro with browser device auth |
| `mc setup [--resource-profile <name>] [--dependency-mode <mode>]` | Setup checklist plus local resource and dependency choices (§11b) |
| `mc auth status [--json]` | Single-screen health check |
| `mc auth memoro [--logout]` | Token login/logout for CI or headless setup |
| `mc auth <claude\|codex\|gemini>` | Re-check one tool's status + fix hint |
| `mc new <name> [--from <ref>] [--tool <id>]` | Create worktree + launch tool |
| `mc list [--rich\|--awaiting\|--safe-to-end\|--orphans]` | List sessions with filters |
| `mc status <name>` | Per-session derived status |
| `mc dev list [--json]` | Show machine-local dev servers and their health |
| `mc dev plan [service] [--profile <name>]` | Validate and show the worktree's declarative dev plan |
| `mc dev ensure [service] [--profile <name>] [--restart]` | Prepare dependencies and ensure the exact worktree-local server is healthy |
| `mc dev status\|logs <session>` | Inspect a session's registered dev server |
| `mc dev stop\|restart <session>` | Run identity-verified project controls |
| `mc deps status\|hydrate [service]` | Inspect or explicitly hydrate isolated worktree dependencies |
| `mc resume <name>` | cd into worktree + relaunch tool |
| `mc end <name> [<name>...]` | End worktrees (bulk + `--dry-run`) |
| `mc rename <old> <new>` | Branch + dir + registry rename in one verb |
| `mc cd <name>` | cd into worktree (needs `mc install-shell`) |
| `mc doctor [--json]` | Diagnose local mc memory/storage state |
| `mc storage status\|candidates\|explain` | Inspect runtime/worktree storage without mutating |
| `mc storage prune-deps --dry-run\|--apply` | Prune old inactive worktree `node_modules` directories |
| `mc storage prune-generated --dry-run\|--apply` | Prune old ignored worktree build/cache directories |
| `mc gc [--dry-run]` | Reap registry-dead + merged + clean worktrees |
| `mc gc --runtime [--dry-run]` | Reap stale runtime pid/socket sidecars |
| `mc gc --dependency-snapshots --dry-run\|--apply` | Preview or remove old unlocked dependency snapshots |
| `mc gc --stale-worktrees [--dry-run]` | Reap clean + merged worktrees with no live broker |
| `mc gc --sidecars [--dry-run]` | Reap stale `hosts/` and `guard-bin/` runtime sidecars |
| `mc gc --all-safe --dry-run\|--apply` | Runtime and dependency-cache cleanup plus clean + merged worktrees |
| `mc gc --reap-orphans` | SIGTERM orphan heartbeat daemons |
| `mc install-shell` | Install the zsh/bash wrapper |
| `mc sessions list` | List active sessions across machines |
| `mc sessions send <id\|label> <msg>` | Dispatch a message into another session |
| `mc sessions read <id\|label>` | Fetch a peer session's recent transcript |

### Role instructions

mc hands a new conversation its role and nothing else: `canon/roles/_common.md`
and the role's own file, as a launch argument (`docs/technical/mc-roles.md`).
There is no Coding Profile — ruling 24 removed it, and the one rule in it
nothing else said, what is written in English, is a sentence in `_common.md`.

Most users only ever see `mc`, `mc setup`, and `mc new` / `mc resume`.

`mc end` is permanent. It shows session/worktree/branch state and the exact
verified provider artifacts, then asks once for the whole batch. Answering `y`
removes the broker session, vault materialisation, ID-bound Codex/Claude
transcript and auxiliary paths, worktree, local branch, runtime sidecars, and
registry entry. `--force` supplies that consent for automation; it does not
weaken ownership checks. `--keep-branch` is the explicit exception. Shared
provider databases, global history/config/memory, and other sessions are never
mutated, so a successfully ended session cannot be resumed even though shared
provider stores may retain non-owned index/log references.

## Supported tools

- Claude Code
- Codex CLI

Cursor, Windsurf, and Gemini CLI remain planned. `mc auth status` shows a row for Gemini today as a placeholder so the layout matches what you'll see once the adapter ships.

## Security

- Tokens stored in OS keychain by default. File fallback (`~/.memoro/config.json` mode 0600) is used only when no keyring is available, with a loud warning.

## Development

```sh
git clone https://github.com/martinforsberg81/memoro-cli.git
cd memoro-cli
npm test
npm link
```

## License

MIT
