# Changelog

All notable changes to `memoro-cli` are documented in this file. The format
follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this
project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- `mc spawn <name> "<brief>"` creates an idle, durable project session
  with its own worktree/branch, `.mc/brief.md`, parent coordinator,
  focus, and optional `MEMORO.md` node metadata.
- `mc list --tree` shows parent/child session fabric so coordinator and
  project sessions are visible together.
- `mc status <name>` now reports effective policy visibility: selected
  tool, permission profile source, whether vault materialisation is
  expected, and whether native auth remains owned by the tool.
- Vault secret payloads now support explicit native-auth target metadata
  (`target_tool`, `target_auth_mode`, `target_location`). Provider-only
  OpenAI secrets still do not materialise into Codex; an explicit Codex
  target is required.
- Effective policy visibility now honours permission profile precedence:
  session registry policy, then `.mc/policy.json` in the worktree, then
  global mc config, then defaults.
- `mc status` now labels permission profile fields unsupported per adapter
  until mc has explicit, reversible renderer support for that tool.
- `mc auth status` now includes the same effective policy/secrets report per
  tool, including native-auth ownership, vault targets, repo policy precedence,
  and unsupported permission fields.
- Codex launches now render explicit mc permission policy into launch args for
  `workspace` (`--sandbox`) and `approval` (`--ask-for-approval`). Default
  policy placeholders render no flags, so native Codex behavior stays unchanged
  unless the user configures policy. mc never renders Codex full-access mode.
- `mc vault scan` and `mc vault import <dotenv-file>` migrate existing `.env`
  / `.dev.vars` secrets into the encrypted vault without printing values.
  Imports create deterministic labels, skip duplicate source keys, skip existing
  vault labels by default, and persist value-free repo bindings in
  `.mc/secrets.json`.
- `mc vault set <label> --bind ENV_KEY` lets manually created secrets be
  attached to the current repo. Without `--bind`, manually set secrets remain
  account-wide/global by design.
- Repo-bound dotenv secrets now materialise during session launch into managed
  blocks in the bound `.env` / `.dev.vars` file, are tracked in the session
  vault manifest, covered by the existing LLM read-blocking hook, and shredded
  by `mc end`.

### Changed
- `mc list` now separates reachable active sessions from local dead/idle
  sessions, uses clean terminal excerpt sanitisation, and supports a numbered
  picker path via `mc resume`.
- Session resume now reuses stable mc coding session IDs for named sessions,
  so a resumed session reconnects to the same tracked mc session instead of
  silently minting a new identity.
- Repo-bound vault materialisation is an allowlist: when `.mc/secrets.json`
  exists, runtime use is limited to labels bound by that repo. Provider-compatible
  global secrets are not used as fallback.

### Fixed
- `mc tool-switch codex` now persists the default tool even when adapter wrapper
  sync reports drift, so later `mc new` / bare `mc` invocations honour the
  selected default.
- JSON/non-interactive `mc vault import` no longer prompts for the master
  password when the vault is locked; it returns a structured locked-vault error.
- `mc vault import` human output no longer calls a confirmed mutation preview a
  dry-run, and `mc vault list` sizes its columns to long labels.

## [0.7.5] — 2026-06-04

### Added
- `mc` now sends a real first user message into the launched coding
  session when a repo is missing `MEMORO.md`, so the file is created
  inside Claude/Codex only after user opt-in instead of being silently
  seeded out-of-band.
- `mc new`, `mc resume`, and bare `mc` share a selected-tool preflight
  path for vault startup, grounding focus, and relaunch environment.
  Bare `mc` now honours the persisted default from `mc tool-switch`.
- `mc resume <name>` accepts `--codex`, `--claude`, and `--tool <name>`
  to relaunch an existing session under a different tool after the
  current TUI has been closed.
- Wrap-mode runtime pieces are split into testable modules for startup
  decisions, local session metadata, heartbeats, dispatch socket handling,
  WebSocket command handlers, and delayed startup-message delivery.

### Changed
- `mc --help` is rewritten around the ordinary user workflow: start,
  resume, setup, secrets, fleet/advanced, and what happens on session
  start.
- Bare `mc` now refuses to start a coding session in the primary
  worktree; use `mc new <name>` for isolated work or `mc resume <name>`
  for existing session work.
- Coordinator grounding now states the three product targets explicitly:
  roadmap/end-goal awareness, orchestrator-role discipline, and
  cross-session work-project order.
- `MEMORO.md` and the fanout plan now document the sharper product
  boundary: mc is a continuity/grounding layer, not a PM system or
  agent-runner.

### Fixed
- `mc tool-switch codex --dry-run` now works in ordinary repos that have
  not materialised `docs/coding-agent-protocol.md`; it falls back to the
  coordinator canon shipped in the installed package.
- Adapter sync now treats an instruction file containing only mc grounding
  as a missing wrapper, not as hand-edited drift. This fixes grounded
  Codex sessions whose `AGENTS.md` existed before `mc adapter sync`.
- Codex session grounding no longer writes runtime state into `AGENTS.md`;
  the static adapter-sync wrapper stays clean and the grounding bundle is
  delivered as Codex's initial CLI prompt instead.
- Claude session grounding no longer writes runtime state into `CLAUDE.md`;
  the static adapter-sync wrapper stays clean and the grounding bundle is
  delivered via Claude Code's `--append-system-prompt` launch arg instead.
- Startup grounding no longer tells agents to read repo-local coordinator
  canon paths when those files are absent. Package-canon is described as
  already supplied by mc, with `mc adapter materialise` as the explicit way
  to put full canon files on disk.
- `mc resume <name>` under Codex no longer falls into Codex's native
  resume picker. mc strips the Claude-only resume signal and starts Codex
  with the grounding bundle as its initial prompt in the selected worktree.
- `mc resume` without a name now lists mc registry sessions across tools,
  so Claude-started sessions remain visible after relaunching under Codex
  or changing the default tool.
- Codex-selected sessions no longer auto-materialise generic OpenAI vault
  secrets into Codex auth. This avoids overwriting ChatGPT/Pro native
  auth with a project/API token.
- Vault startup skips unlock prompts when the selected tool has no
  matching provider target, and `mc status <name>` now shows the stored
  session tool plus the recommended relaunch command.

## [0.7.0] — 2026-06-01

### Added
- `mc vault` — encrypted secret store with full lifecycle (§12 phase
  1+2+3). Client-side AES-GCM with PBKDF2 (600k iterations); the
  server holds only ciphertext. Verbs: `init`, `unlock`, `lock`,
  `set`, `get`, `list`, `delete`, `change-password`, `destroy`,
  `status`. Phase 2 caches the unlocked key in the OS keychain so
  repeated `mc resume` doesn't reprompt; JIT materialisation writes
  decrypted tokens to disk only for the lifetime of the launched
  session (PR #47, #51). Phase 3 installs a per-session PreToolUse
  hook that blocks foreign LLMs from reading the materialised
  paths — the LLM-blindness invariant (PR #53). `mc vault` errors
  print human-readable codes in non-JSON mode (PR #48).
- `mc auth devices` — list and revoke registered devices (§14
  phase 1 client). Fresh installs auto-trigger the OAuth Device
  Flow on first command so onboarding is one less prompt
  (PR #54).

### Plan
- §14 — device-aware auth via OAuth Device Flow, with fixed 90-day
  rotation instead of sliding TTL (PRs #49, #50).
- §15 — memoro-agent as a remote Streamable-HTTP MCP endpoint on
  the Memoro Worker, exposing the existing chat orchestrator as a
  tool surface for Claude Code, Cursor, and Codex. Token enrollment
  via Pattern A (bearer in MCP config) or Pattern B (`headersHelper`
  from OS keychain). Implementation drev queued (PR #55).

### Docs
- Skill: `agent-coordination.md` gains the drev 3+4 lessons —
  honest uncertainty disclosure when verification is blocked, and
  the bounded architectural-self-upgrade pattern (PR #52). Also
  the test-only `--json` anti-pattern from PR #48.

## [0.6.0] — 2026-05-31

### Added
- `mc reconcile [--apply --only-safe] [--json]` (§9e). Detects
  sessions whose work has already shipped elsewhere and groups them
  by suggested action: `safe_to_end` (squash-phantoms — deterministic
  via cherry + content-diff), `branch_merged_recently` (gh PR head
  match within 7 days), `verify_and_end` (transcript-mention PRs that
  merged in 7 days, found by scanning the last ≤200 KB of the
  session's Claude transcript). `--apply --only-safe` acts ONLY on
  the squash-phantom bucket — the cron-safe acceptance bar
  ("can I run this on a cron and never lose work?"). `gh` calls go
  through an injectable portal so missing/expired auth soft-degrades
  to empty buckets instead of crashing. File-overlap heuristic
  category deferred to v2 (§11f.5).
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

[0.7.5]: https://github.com/martinforsberg81/memoro-cli/releases/tag/v0.7.5
[0.7.0]: https://github.com/martinforsberg81/memoro-cli/releases/tag/v0.7.0
[0.2.0]: https://github.com/martinforsberg81/memoro-cli/releases/tag/v0.2.0
[0.1.0]: https://github.com/martinforsberg81/memoro-cli/releases/tag/v0.1.0
