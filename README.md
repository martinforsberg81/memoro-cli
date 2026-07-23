# memoro-cli

Command-line glue between external coding tools (Claude Code, Cursor, Codex, Windsurf, Gemini CLI) and your [Memoro](https://meetmemoro.app) account.

## What it does

Two directions, one binary:

- **Sessions → Memoro.** At the end of a coding session, the CLI cleans the transcript locally into a tool-agnostic conversation payload, attaches deterministic metadata (`coding_context`, `repo_manifest`), and POSTs it to Memoro. Server-side AI processing happens inside Memoro. Raw tool outputs and code bodies are still stripped client-side before upload.
- **Memoro → tools.** Before a coding session starts, the CLI pulls compact User Profile and Coding Profile context from Memoro and injects it through the selected adapter at launch. Repo-owned instruction files such as `CLAUDE.md` and `AGENTS.md` remain static contracts, not copies of the user's profile.

The result: every coding tool you use feels like it remembers you.

## Install

```sh
npm install -g memoro-cli
```

Node 22 or later. macOS or Linux. The `mc` coordinator (below) uses `node-pty` for transparent terminal wrapping — no extra system dep beyond a normal `npm install`.

## Quick start

```sh
npm install -g memoro-cli
mc
mc setup
```

On first run, `mc` signs this machine in to Memoro with browser device auth and stores the token in the OS keychain. Then `mc setup` reads every local probe needed to get you running and prints a numbered checklist of *only* the missing steps — each step is a single command you can paste. On a terminal it also offers optional resource profiles for local image/motion jobs; pressing Enter keeps the current profile, and fresh installs default to no limits. Re-run setup whenever; once everything is green it just confirms.

Then a typical day:

```sh
mc new my-experiment      # branch + worktree + your default coding tool launches in it
# ... work, /exit when done ...
mc end my-experiment      # review status, then permanently delete the local session
```

See [`docs/onboarding.md`](docs/onboarding.md) for the long story — per-tool install details, multi-machine notes, and shell-wrapper specifics.

## `mc` — the terminal coordinator

`mc` is a Memoro-aware wrapper around your coding tool of choice. It owns a worktree per session, registers each session with Memoro so peer sessions on the same account can see and dispatch to each other, and gives you the shell ergonomics that drop the manual `git worktree` / `git branch` ceremony.

```sh
mc setup                  # self-check + optional local heavy-job limits
mc auth status            # single-screen health check
mc new <name>             # create worktree + branch + launch the tool
mc list                   # show your sessions, filters per §9d of the plan
mc end <name>             # confirm permanent local teardown
mc resume <name>          # cd back into a worktree, relaunch the tool
mc sessions list          # active sessions across machines
mc sessions send <id|label> "<msg>"
```

Inside any wrapped Claude session, the slash command `/memoro-coordinator` opens the coordinator role — Claude shows the current snapshot of your other sessions and helps you route attention across them. `/memoro-coordinator-suggest` recommends a next step per session for the "where should I spend the next 30 minutes?" triage moment.

Under the hood: `mc` runs the tool in a PTY it owns, with your terminal piped transparently to and from it. A WebSocket to Memoro delivers remote dispatches by writing into the tool's PTY stdin — they land as real user turns. No tmux, no Claude Code modifications, terminal-native scrollback works.

## Commands

### `mc` — coordinator + worktree lifecycle

| Command | Purpose |
|---|---|
| `mc` | First run signs in to Memoro with browser device auth |
| `mc setup [--resource-profile <name>]` | Setup checklist and optional local image/motion resource profile (§11b) |
| `mc auth status [--json]` | Single-screen health check |
| `mc auth memoro [--logout]` | Token login/logout for CI or headless setup |
| `mc auth <claude\|codex\|gemini>` | Re-check one tool's status + fix hint |
| `mc coding-profile read\|diff\|write` | LLM-callable read, compare, and full-replacement update flow for your Coding Profile |
| `mc new <name> [--from <ref>] [--tool <id>]` | Create worktree + launch tool |
| `mc list [--rich\|--awaiting\|--safe-to-end\|--orphans]` | List sessions with filters |
| `mc status <name>` | Per-session derived status |
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
| `mc gc --stale-worktrees [--dry-run]` | Reap clean + merged worktrees with no live broker |
| `mc gc --sidecars [--dry-run]` | Reap stale `hosts/` and `guard-bin/` runtime sidecars |
| `mc gc --all-safe --dry-run\|--apply` | Runtime cleanup plus clean + merged worktrees |
| `mc gc --reap-orphans` | SIGTERM orphan heartbeat daemons |
| `mc install-shell` | Install the zsh/bash wrapper |
| `mc sessions list` | List active sessions across machines |
| `mc sessions send <id\|label> <msg>` | Dispatch a message into another session |
| `mc sessions read <id\|label>` | Fetch a peer session's recent transcript |

### Coding Profile workflow

Durable work-method changes are explicit and dialogue-based. A coding agent
should read the current profile, discuss the intended change with you, diff the
candidate profile, then write only after approval.

```sh
mc coding-profile read --json
mc coding-profile diff --stdin
mc coding-profile write --stdin --base-revision <n> --summary "<summary>"
```

When the profile does not exist yet, `read --json` returns `base_revision: 0`
and a compact `template_markdown` for revision 1.

### `memoro-cli` — low-level surface

| Command | Purpose |
|---|---|
| `memoro-cli login` | Save a Memoro API token to the OS keychain |
| `memoro-cli logout` | Remove the stored token |
| `memoro-cli status` | Show token info, last session uploaded, last legacy lens pull |
| `memoro-cli config set <key> <value>` | Store non-secret CLI config such as `api-url` |
| `memoro-cli session upload <transcript>` | Clean + POST a session transcript |
| `memoro-cli lens pull [--tool <id>] [--repo <name>]` | Legacy: refresh the old portrait-coding lens block |
| `memoro-cli codex run [-- <codex args...>]` | Legacy manual wrapper; prefer `mc new --codex` |
| `memoro-cli hook install [--tool ...]` | Legacy raw-tool integration; not required for `mc` |
| `memoro-cli hook uninstall [--tool ...]` | Remove legacy raw-tool hooks/shims |

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
- Transcript cleanup and metadata extraction happen on your machine. The uploaded payload contains cleaned user/assistant messages plus deterministic metadata; Memoro performs the AI extraction server-side.
- You can inspect every uploaded session in the Memoro library and delete any that feel too revealing — deletion cascades through the observation pipeline.

## Development

```sh
git clone https://github.com/martinforsberg81/memoro-cli.git
cd memoro-cli
npm test
npm link
memoro-cli --help
```

## License

MIT
