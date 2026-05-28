# Changelog

All notable changes to `memoro-cli` are documented in this file. The format
follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this
project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- `mc setup` — non-interactive self-verifying onboarding checklist
  (§11b). Runs every probe `mc auth status` exposes and prints only
  the missing steps with exact runnable commands. Writes
  `${MC_HOME}/.setup-done-v1` when everything is green.
- `mc auth status [--json]` — single-screen health check answering
  "is mc ready to use here?" (§11a). Adapter contract codified:
  `TOOL_NAME`, `STATUS_TIMEOUT_MS`, `getStatus(opts?)` →
  `{ installed, version, authenticated, hint, detailLines }`. Hint
  invariant locked in the contract test so future tool-adders can't
  ship placeholder strings.
- `mc auth memoro [--logout|--status]` and `mc auth <claude|codex|gemini>`
  per-target helpers (§11c). `mc auth memoro` is a thin alias for
  `memoro-cli login/logout` with passthrough for unknown flags.
- `mc list --orphans` and `mc gc --reap-orphans [--dry-run --min-age D]`
  (§9j). Detects orphaned `memoro-cli heartbeat-loop` daemons via the
  canonical Unix reparent-to-PID-1 signal and cleans them up — landed
  after observing 9 accumulated orphans pinging the API ~1 req/min
  sustained.
- First-run friendliness in `mc new` and `mc list` (§11d). When both
  the sentinel and the keychain token are missing, a one-line hint
  ("Looks like a fresh install. Run `mc setup` to get started.") goes
  to stderr in place of the cryptic prereq failure. `mc list` keeps
  stdout machine-parseable. Migrants who already ran `memoro-cli login`
  get a silent sentinel write on first successful `mc new` and never
  see the hint.
- README rewrite + `docs/onboarding.md` (§11e). README front door is
  now `mc setup`; the long story (per-tool install, multi-machine
  notes, shell-wrapper specifics) lives in `docs/onboarding.md`.
  Install commands are not duplicated in docs — `mc setup` and
  `mc auth status` are the authority.

### Fixed
- `/memoro-update` body rewritten to be unambiguously display-only.
  Previous wording ("Run these two commands in the user's shell") had
  the LLM trying to execute `npm install -g memoro-cli` via Bash, which
  auto-mode correctly blocks as sanctioned global persistence. New body
  tells the LLM to display the recipe and not run it.
- `/memoro-update`, `/memoro-coordinator`, `/memoro-coordinator-suggest`
  files are now refreshed on every `mc` launch (in addition to the
  existing `hook install` path). Updates to their canonical bodies
  propagate without re-running `memoro-cli hook install`.

### Added
- `/memoro-coordinator-suggest` slash command — analyses every active
  session and recommends a concrete next step per session, plus a
  one-sentence prioritisation. Built for the "where should I spend the
  next 30 minutes?" triage moment.

### Changed
- `/memoro-coordinator` body upgraded: instructs the LLM to present
  active sessions as a **numbered list** with one-line characterisation
  per session, flag PAUSED sessions explicitly, and point users at
  `/memoro-coordinator-suggest` when they want next-step recommendations.
- Coordinator slash command files now **overwrite-on-launch** if their
  canonical content has changed — updates land automatically without
  re-running `memoro-cli hook install`.

### Added
- `mc new <label>` — launch a labeled mc session. Labels appear in
  `mc sessions list` (`[audit]` instead of `[sess_xxx]`) and resolve
  cleanly when dispatching: `mc sessions send audit "..."`. First-match
  wins on collision; warns to stderr.
- `mc` heartbeats now carry `last_assistant_excerpt` — the trailing text
  of what Claude is currently showing in the wrapped session, ANSI-stripped.
  `mc sessions list` displays it under each session so a peer coordinator
  can spot paused prompts (e.g. *"How should I proceed? 1. Update Gemini
  Flash only…"*) at a glance instead of relying on `idle_seconds` alone.

## [0.2.0] — 2026-04-24

### Added
- `memoro show <section>` — prints one lens section on demand (`loose-ends`,
  `decisions`, `rules`, `stack`, `repos`, `practices`, `tool-use`) via a new
  untrimmed `/api/lens/portrait-coding/sections` endpoint. Designed to back
  slash-command output inside Claude Code and similar tools.
- Claude Code adapter: `installCommands` / `uninstallCommands` manage
  `~/.claude/commands/memoro-*.md` files. `hook install` now also installs
  slash commands; `hook uninstall` also removes them. A managed marker
  inside each file means uninstall leaves hand-authored `memoro-*.md` files
  alone.
- Daily auto-update-check. Every invocation compares the running version to
  a cached `latestVersion` and prints a one-line notice to stderr when an
  update is available. Cache is refreshed at most once per 24h by a
  detached child that fetches `registry.npmjs.org`; the main process never
  blocks on the network. Disable with `MEMORO_NO_UPDATE_CHECK=1`.

### Changed
- Claude Code adapter resolves paths lazily via `homedir()` so tests and
  future env overrides can redirect `HOME` without fighting ESM module
  caching.

## [0.1.0] — 2026-04-23

Initial public release.

### Added
- Commands: `login`, `logout`, `status`, `config set/get`, `session upload`,
  `lens pull`, `codex run`, `hook install`, `hook uninstall`.
- Adapters for **Claude Code** (native `SessionStart` / `SessionEnd` hooks) and
  **Codex CLI** (via a `~/.local/bin/codex` shim plus `codex-memoro` wrapper).
- Client-side transcript cleanup — raw tool outputs and code bodies are stripped
  locally; only cleaned user/assistant messages plus deterministic metadata
  (`coding_context`, `repo_manifest`) are uploaded.
- Session annotations captured client-side before upload.
- Managed-block helpers (`upsertManagedBlock`, `removeManagedBlock`,
  `readManagedBlock`) for safely writing the Memoro lens into tool config files
  such as `~/.claude/CLAUDE.md` and `AGENTS.md`.
- Secure token storage via the OS keychain (macOS Keychain / Linux libsecret /
  Windows Credential Manager) with a documented `~/.memoro/config.json` (mode
  `0600`) fallback when no keyring is available.
- Programmatic API re-exporting `adapters`, `parseTranscript`,
  `buildSessionPayload`, and the managed-block helpers.

### Fixed
- Paste into the hidden token prompt on macOS Terminal.
- `SessionEnd` hook being killed mid-upload on Claude Code.
- `SessionEnd` transcript path now read from stdin JSON for compatibility with
  current Claude Code hook payloads.

[0.2.0]: https://github.com/martinforsberg81/memoro-cli/releases/tag/v0.2.0
[0.1.0]: https://github.com/martinforsberg81/memoro-cli/releases/tag/v0.1.0
