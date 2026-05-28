# memoro-cli

Command-line glue between external coding tools (Claude Code, Cursor, Codex, Windsurf, Gemini CLI) and your [Memoro](https://meetmemoro.app) account.

## What it does

Two directions, one binary:

- **Sessions → Memoro.** At the end of a coding session, the CLI cleans the transcript locally into a tool-agnostic conversation payload, attaches deterministic metadata (`coding_context`, `repo_manifest`), and POSTs it to Memoro. Server-side AI processing happens inside Memoro. Raw tool outputs and code bodies are still stripped client-side before upload.
- **Memoro → tools.** Before a coding session starts, the CLI pulls your personal context lens from Memoro and writes a managed section into the tool's config file (`~/.claude/CLAUDE.md`, `.cursorrules`, `AGENTS.md`, etc.) — identity, writing voice, cross-repo rules, and in-flight threads from recent work.

The result: every coding tool you use feels like it remembers you.

## Install

```sh
npm install -g memoro-cli
```

Node 22 or later. macOS or Linux. The `mc` coordinator (below) uses `node-pty` for transparent terminal wrapping — no extra system dep beyond a normal `npm install`.

## Quick start

```sh
mc setup
```

`mc setup` reads every probe needed to get you running and prints a numbered checklist of *only* the missing steps — each step is a single command you can paste. Re-run it whenever; once everything is green it just confirms.

Then a typical day:

```sh
mc new my-experiment      # branch + worktree + Claude Code launches in it
# ... work, /exit when done ...
mc end my-experiment      # close the worktree, hand the branch back
```

See [`docs/onboarding.md`](docs/onboarding.md) for the long story — per-tool install details, multi-machine notes, and shell-wrapper specifics.

## `mc` — the terminal coordinator

`mc` is a Memoro-aware wrapper around your coding tool of choice. It owns a worktree per session, registers each session with Memoro so peer sessions on the same account can see and dispatch to each other, and gives you the shell ergonomics that drop the manual `git worktree` / `git branch` ceremony.

```sh
mc setup                  # idempotent self-check; prints what's left to do
mc auth status            # single-screen health check
mc new <name>             # create worktree + branch + launch the tool
mc list                   # show your sessions, filters per §9d of the plan
mc end <name>             # close worktree, deal with the branch
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
| `mc setup` | Self-verifying setup checklist (§11b) |
| `mc auth status [--json]` | Single-screen health check |
| `mc auth memoro [--logout]` | Alias for `memoro-cli login/logout` |
| `mc auth <claude\|codex\|gemini>` | Re-check one tool's status + fix hint |
| `mc new <name> [--from <ref>] [--tool <id>]` | Create worktree + launch tool |
| `mc list [--rich\|--awaiting\|--safe-to-end\|--orphans]` | List sessions with filters |
| `mc status <name>` | Per-session derived status |
| `mc resume <name>` | cd into worktree + relaunch tool |
| `mc end <name> [<name>...]` | End worktrees (bulk + `--dry-run`) |
| `mc rename <old> <new>` | Branch + dir + registry rename in one verb |
| `mc cd <name>` | cd into worktree (needs `mc install-shell`) |
| `mc gc [--dry-run]` | Reap dead + merged + clean worktrees |
| `mc gc --reap-orphans` | SIGTERM orphan heartbeat daemons |
| `mc install-shell` | Install the zsh/bash wrapper |
| `mc sessions list` | List active sessions across machines |
| `mc sessions send <id\|label> <msg>` | Dispatch a message into another session |
| `mc sessions read <id\|label>` | Fetch a peer session's recent transcript |

### `memoro-cli` — low-level surface

| Command | Purpose |
|---|---|
| `memoro-cli login` | Save a Memoro API token to the OS keychain |
| `memoro-cli logout` | Remove the stored token |
| `memoro-cli status` | Show token info, last session uploaded, last lens pull |
| `memoro-cli config set <key> <value>` | Store non-secret CLI config such as `api-url` |
| `memoro-cli session upload <transcript>` | Clean + POST a session transcript |
| `memoro-cli lens pull [--tool <id>] [--repo <name>]` | Fetch the coding lens |
| `memoro-cli codex run [-- <codex args...>]` | Run Codex with lens pull on start + upload on exit |
| `memoro-cli hook install [--tool ...]` | Wire SessionStart + SessionEnd hooks |
| `memoro-cli hook uninstall [--tool ...]` | Remove hooks |

Most users only ever see `mc setup` and `mc auth memoro` — those wrap the underlying `memoro-cli login` and `hook install` flows.

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
