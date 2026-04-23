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

Node 18 or later.

## Quick start

1. Create a Memoro API token at <https://meetmemoro.app/app/settings> → API tokens. Pick **Full access** (or issue two narrower tokens: `sessions.write` for upload, `lens.read` for pull).

2. Log in locally:

   ```sh
   memoro-cli login
   ```

   Paste the token. It goes into your OS keychain (macOS Keychain / Linux libsecret / Windows Credential Manager) — never a plaintext file unless no keyring is available.

3. Install hooks into your coding tool:

   ```sh
   memoro-cli hook install --tool claude-code
   ```

   For Codex, install the wrapper instead:

   ```sh
   memoro-cli hook install --tool codex
   ```

4. Start a coding session.
   Claude Code uses native hooks.
   Codex installs a `~/.local/bin/codex` shim plus `codex-memoro`. If `~/.local/bin` comes before the real Codex binary in your `PATH`, plain `codex ...` now pulls the lens into `AGENTS.md`, runs the real Codex binary, and uploads the finished session when Codex exits.

## Commands

| Command | Purpose |
|---|---|
| `memoro-cli login` | Save a Memoro API token to the OS keychain |
| `memoro-cli logout` | Remove the stored token |
| `memoro-cli status` | Show stored token info, last session uploaded, last lens pull |
| `memoro-cli config set <key> <value>` | Store non-secret CLI config such as `api-url` |
| `memoro-cli session upload <transcript>` | Clean + POST a session transcript |
| `memoro-cli lens pull [--tool <id>] [--repo <name>]` | Fetch the coding lens and write it to the tool's managed section |
| `memoro-cli codex run [-- <codex args...>]` | Run Codex with lens pull on start and session upload on exit |
| `memoro-cli hook install [--tool ...]` | Wire SessionStart + SessionEnd hooks into a coding tool |
| `memoro-cli hook uninstall [--tool ...]` | Remove hooks |

## Supported tools

- Claude Code
- Codex CLI

Cursor, Windsurf, and Gemini CLI remain planned.

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
