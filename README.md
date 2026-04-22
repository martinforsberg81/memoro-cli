# memoro-cli

Command-line glue between external coding tools (Claude Code, Cursor, Codex, Windsurf, Gemini CLI) and your [Memoro](https://meetmemoro.app) account.

## What it does

Two directions, one binary:

- **Sessions → Memoro.** At the end of a coding session, the CLI distills the transcript locally (using your own Anthropic API key) into a small structured payload — user turns, corrections, decisions, open threads — and POSTs it to Memoro. Raw code, diffs, and tool outputs never leave your machine.
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

3. Point it at your Anthropic API key (for client-side distillation):

   ```sh
   memoro-cli config set anthropic-api-key sk-ant-...
   ```

4. Install hooks into your coding tool:

   ```sh
   memoro-cli hook install --tool claude-code
   ```

5. Start a coding session. When it ends, your transcript is distilled and uploaded. Your next session starts with fresh personal context in `CLAUDE.md`.

## Commands

| Command | Purpose |
|---|---|
| `memoro-cli login` | Save a Memoro API token to the OS keychain |
| `memoro-cli logout` | Remove the stored token |
| `memoro-cli status` | Show stored token info, last session uploaded, last lens pull |
| `memoro-cli config set <key> <value>` | Store Anthropic key (and future config) |
| `memoro-cli session upload <transcript>` | Distill + POST a session transcript |
| `memoro-cli lens pull [--repo <name>]` | Fetch the coding lens and write it to the tool's managed section |
| `memoro-cli hook install [--tool ...]` | Wire SessionStart + SessionEnd hooks into a coding tool |
| `memoro-cli hook uninstall [--tool ...]` | Remove hooks |

## Supported tools

MVP ships with Claude Code. Architecture is provider-agnostic; adapters for Cursor, Codex, Windsurf, and Gemini CLI follow.

## Security

- Tokens stored in OS keychain by default. File fallback (`~/.memoro/config.json` mode 0600) is used only when no keyring is available, with a loud warning.
- Distillation happens on your machine. The only thing sent to Memoro is the distilled payload — see the schema at [docs/plans/external-coding-sessions.md](https://github.com/martinforsberg81/memoro/blob/main/docs/plans/external-coding-sessions.md) in the Memoro repo.
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
