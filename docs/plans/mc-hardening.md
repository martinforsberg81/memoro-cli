# mc hardening

**Status:** active draft · 2026-06-04 · serves G1, G2, G3

Detailed plan for raising `mc` from working prototype to dependable daily
entrypoint. This plan exists because recent live tests exposed the same class of
failure in several places: mc had the right high-level architecture, but launch,
vault, tool-switch, global install, and live verification were not governed by a
single end-to-end contract.

Product boundary: mc is a **minimal grounded coordinator runtime**, not a PM
system and not an agent-runner. Its job is to make the coordinator session wake
with the whole; the session itself writes briefs, sends agents, asks review
agents, and proposes map updates.

## Problem

mc currently works by stitching together several powerful but fragile seams:
registry state, tool adapters, grounding files, vault materialisation, pty launch,
startup messages, and npm/global install. Each seam has tests, but the combined
start path has been fixed by repeated small patches.

The live failures were concrete:

- stale global `mc` showed old help even after dev had the right behavior
- missing `MEMORO.md` initially risked becoming an empty skeleton instead of an
  evidence-based first map inside the launched session
- `tool-switch --here` was the wrong abstraction: a running LLM TUI cannot
  switch tool in place. The correct surface is to exit the tool and relaunch the
  session with `mc resume <name> --codex/--claude`.
- Codex auth was overwritten by generic OpenAI vault materialisation
- Codex Pro/ChatGPT login was treated like an API-key path
- vault unlock prompted in contexts where the selected tool should not need vault
  materialisation at all
- live `mc tool-switch codex --dry-run` in the ordinary `memoro` repo failed
  because it still expected repo-local `docs/coding-agent-protocol.md`, despite
  package-canon support

These are not isolated bugs. They show missing invariants and a missing live
release gate.

## Goal

Make `mc` boringly reliable as the command a developer runs to enter grounded
coding sessions across tools.

`mc new`, `mc resume`, and bare `mc` must be predictable:
same worktree, same session record, selected tool only, correct grounding,
credentials left intact unless explicitly targeted, and no surprise writes beyond
the documented lifecycle.

The goal is not to add more management commands. If a coordinator session can
solve a workflow by writing a better prompt and using existing agent tools, mc
should not encode that workflow.

## Non-negotiable invariants

1. **Native tool auth is owned by the tool.**
   mc must never overwrite Codex ChatGPT/Pro auth, Claude Code auth, or any other
   native auth file unless the user has explicitly configured that exact
   materialisation target.

2. **Vault materialisation is selected-tool scoped.**
   Starting a Codex session must not materialise Claude credentials just because
   Claude is installed. Starting a Claude session must not touch Codex auth just
   because Codex is installed.

3. **Generic provider metadata is not enough for native auth writes.**
   `provider=openai` may mean "OpenAI API key for app/dev work", not "write this
   into `~/.codex/auth.json`". Tool auth writes require an explicit target
   contract.

4. **Grounding is safe and reversible.**
   Adapter grounding may write managed blocks into tool instruction files, but it
   must preserve hand-authored content and be removable by marker. Missing
   `MEMORO.md` is handled by a first real message inside the launched session,
   after user opt-in.

5. **Session tool is per-session.**
   `mc resume <name>` uses the registry entry's tool. The global default affects
   future `mc new`, not existing sessions.

6. **A running TUI never switches tool in place.**
   `mc tool-switch <tool>` only changes the default for future bare `mc` /
   `mc new` starts. An existing session changes tool only after the user exits
   the current TUI and runs `mc resume <name> --codex/--claude`.

7. **Publish is gated by live behavior, not only unit tests.**
   No npm release after start-path changes without a live matrix pass and global
   install verification.

8. **The coordinator session owns orchestration.**
   mc may provide grounding, continuity, and tool/session plumbing. It should not
   implement map-review workflows, fanout state machines, resume-by-intent
   search, ensemble management, or automatic map rewriting until live work proves
   the model cannot handle it from a grounded session.

## Start-path contract

Every entry uses the same conceptual pipeline:

1. Resolve repo/worktree/session identity.
2. Resolve selected tool:
   - bare `mc`: explicit env/default/fallback
   - `mc new`: flag > stored default > fallback
   - `mc resume`: flag > registry entry tool
3. Compute vault materialisation plan for the selected tool only.
4. If the selected tool has no vault target, skip vault access entirely.
5. If it has a target and vault is locked, offer unlock only on interactive TTY.
6. Render grounding through selected adapter.
7. Launch selected tool through adapter `launchSpec`.
8. Inject startup message only when grounding reported a missing map.
9. On end/shred, remove only files listed in the per-session manifest.

## Vault redesign

Current phase should be conservative:

- Keep Claude/Anthropic materialisation where explicitly mapped and tested.
- Disable Codex automatic OpenAI materialisation.
- Keep Codex adapter-level `materializeToken` tests as a low-level capability,
  but do not call it from lifecycle by generic provider matching.
- Add a future explicit target model before re-enabling Codex API-key auth:
  `target_tool`, `target_location`, or an equivalent encrypted payload field.

Future target examples:

```json
{
  "kind": "api_token",
  "provider": "openai",
  "target_tool": "codex",
  "target_auth_mode": "api_key"
}
```

Without such explicit metadata, Codex uses its own login.

## Tool selection hardening

Default tool acceptance:

- `mc tool-switch <tool>` sets only the default for future bare `mc` / `mc new`.
- It does not touch existing registry entries.
- In ordinary repos without materialised canon files, tool-switch must use the
  package canon for wrapper sync decisions instead of failing on missing
  `docs/coding-agent-protocol.md`.

Existing-session tool acceptance:

- `mc resume <name> --codex/--claude` updates that session's registry `tool`
  before relaunch.
- The selected tool is passed through the same prelaunch path as `mc new`.
- The user must exit the old TUI first; mc does not attempt to switch a running
  LLM process in place.

## Coordinator wake-up hardening

Do less, better:

- Keep `MEMORO.md` small, committed, and read-only by default.
- Ground every session with role + map + selected tool/worktree/session context.
- Make the role boundary explicit: high-altitude coordinator by default; delegate
  non-trivial implementation through a brief; use a separate review agent when
  risk warrants it.
- When `MEMORO.md` is missing, the launched session asks before creating it and
  writes an evidence-based first map inside the session.
- When `MEMORO.md` is created in a repo, it should be committed so existing and
  future worktrees inherit it. mc may surface this as a status hint, but should
  not auto-commit.

Do not build:

- `mc map ...` command family
- resume-by-intent lookup
- fanout/verify/gather as a first-class engine
- ensemble/hierarchy orchestration
- automatic map updates

## Test matrix

Automated unit/integration:

- `mc new` passes only selected adapter to vault startup.
- `mc resume` passes only registry tool adapter to vault startup.
- lifecycle returns ok without vault access when selected adapter has no provider
  mapping.
- Codex generic `provider=openai` is never written to `~/.codex/auth.json`.
- `mc resume <name> --codex/--claude` updates the session tool before relaunch.
- `mc tool-switch <tool>` does not mutate existing sessions.
- missing `MEMORO.md` startup message requires opt-in and evidence-based draft.
- `mc help` and `mc tool-switch --help` match installed release surface.
- `mc tool-switch <tool> --dry-run` works in an ordinary repo with no
  `docs/coding-agent-protocol.md`, using package canon rather than failing.

Live/manual release matrix:

- Fresh Codex ChatGPT/Pro login survives `mc resume <codex-session>`.
- Codex session with locked vault does not prompt if no selected-tool materialise
  target exists.
- Claude session with Anthropic vault secret prompts/materialises/shreds as
  expected.
- Exit Claude, then run `mc resume <name> --codex`.
- Missing `MEMORO.md` in a real repo creates the map inside the launched session
  after opt-in.
- Global `npm install -g memoro-cli@<version>` shows expected `mc --version`,
  `mc help`, and `mc tool-switch --help`.
- In `~/memoro`, `mc tool-switch codex --dry-run --json` succeeds without
  requiring repo-local mc canon files.
- In `~/memoro`, `MEMORO.md` is committed on `main` and present in the resumed
  worktree before `mc resume <session>`.

### Codex no-auth-mutation checklist

Before publishing a vault/tool-switch patch, run this on a machine with a real
Codex ChatGPT/Pro login:

1. Record whether `~/.codex/auth.json` exists and its checksum if present.
2. Start a Codex-selected session with locked vault:
   `mc new codex-auth-check --codex`, or `mc resume <codex-session>`.
3. Confirm startup does not prompt for vault unlock when Codex has no explicit
   vault materialisation target.
4. Confirm the Codex TUI reaches its normal auth state and does not report an
   injected API key.
5. Re-check `~/.codex/auth.json`: absent stays absent, present checksum is
   unchanged.
6. Run `mc end codex-auth-check` or clean up the test session normally.

## Release gate

Before publishing:

1. Working tree reviewed: unrelated grounding files ignored; intended files known.
2. Targeted tests for touched seams pass.
3. Full `npm test` passes.
4. `npm pack --dry-run` inspected.
5. Install package globally from the candidate version.
6. Run live matrix entries relevant to changed seams.
7. Verify no native auth file was overwritten unexpectedly.
8. Publish once. No chained patch releases without re-running the gate.

## Current dev-worktree audit

Already published in `0.7.1`–`0.7.4`:

- workflow-oriented help
- missing `MEMORO.md` startup message inside session
- Codex extra-submit handling for injected startup messages
- vault unlock prompt before launch
- tool-switch relaunch wording
- Codex auth casing fix
- disabled generic OpenAI-to-Codex materialisation

Landed in dev after `0.7.4`, not yet released:

- selected-tool-scoped vault startup for `mc new` and `mc resume`
- lifecycle early-return before vault access when selected tool has no provider
  mapping
- `mc status <name>` now shows the session's selected tool and the recommended
  relaunch command in both JSON and human output
- bare `mc` now honours the persisted default tool when allowed to start outside
  the primary worktree, and `mc new` uses the same default when no tool flag is
  given
- bare `mc` now enters the same selected-tool-scoped vault startup path; `mc new`
  and `mc resume` mark the re-exec so wrap mode does not double-prompt or
  double-materialise
- wrap-mode start decisions are now extracted from `src/bin-mc.js` into
  `src/mc/wrap-start.js`: selected tool resolution, focus precedence, vault
  startup/shred intent, and missing-`MEMORO.md` startup-message detection are
  directly testable without importing the PTY/WS CLI runtime
- wrap-mode runtime data is now extracted into `src/mc/wrap-runtime.js`: socket
  and metadata paths, the local session metadata JSON, heartbeat identity, and
  heartbeat tick payload are tested directly. `bin-mc.js` still owns the live
  PTY/socket/WS process lifecycle, but the coordinator-visible data contract no
  longer lives only inside the TUI runtime.
- local dispatch socket handling is now extracted into `src/mc/wrap-dispatch.js`:
  JSON parse errors, missing/blank messages, success response shape, and message
  delivery are directly tested without a real PTY. `bin-mc.js` now only wires the
  socket server to `writeToPty`.
- WebSocket command handling for wrap mode is now extracted into
  `src/mc/wrap-ws.js`: remote `dispatch_message` validation/delivery and
  `fetch_transcript` handler assembly are tested directly without a live WS
  connection or PTY. `bin-mc.js` now wires the handler table to `CliWsClient`.
- missing-`MEMORO.md` startup-message timing is now extracted into
  `src/mc/wrap-startup-message.js`: idle scheduling, timer reset, immediate
  send, and cleanup cancellation are tested directly without a live PTY.
- `mc new` / `mc resume` prelaunch is now extracted into
  `src/mc/commands/launch-preflight.js`: selected-tool vault startup, canonical
  `MC_GROUNDING_TOOL`, `MC_SESSION_NAME`, `MC_VAULT_STARTUP_DONE`, optional
  focus, and resume `--resume` reexec argv are tested without launching a TUI.

Live findings after local global install:

- `mc resume data` in `~/memoro` is viable under Codex after committing
  `MEMORO.md` to `main` and cherry-picking it into the existing `sess/data`
  worktree. Grounding in that worktree now includes the real map instead of the
  missing-map startup prompt.
- `mc auth status` must be checked outside sandbox when validating macOS
  Keychain behavior; sandboxed probes can report a false missing-token state.
- `mc tool-switch codex --dry-run --json` in an ordinary repo must not require
  repo-local `docs/coding-agent-protocol.md`. The code path is now covered by
  regression tests; the live `~/memoro` check remains part of the release gate.

## Concrete phases from here

### Phase A — Start-path/tool portability hardening   · `landed in dev`

Make the real launch seams dependable without adding orchestration features:
selected-tool vault startup, Codex no-auth-mutation by default, ordinary-repo
package-canon fallback for `tool-switch`, prelaunch env contracts, wrap runtime
extractions, and status/relaunch visibility.

Acceptance:

- `mc new`, `mc resume`, and bare `mc` all resolve exactly
  one selected tool.
- Codex starts without generic OpenAI vault writes unless an explicit future
  target contract exists.
- Tool-switch works in repos that have not materialised mc canon files.

### Phase B — Coordinator wake-up quality   · `landed in dev`

Refine the startup role and canon so a coordinator session wakes around the
three real targets: roadmap/end-goal awareness, orchestrator-role discipline,
and cross-session work-project order. This phase deliberately adds no CLI verbs.

Acceptance:

- Grounding renders the three targets directly in the role block.
- Canon protocol/skill/command describe `mc` as a minimal grounded coordinator
  runtime, not an agent-runner or PM system.
- Missing-map guidance still writes only after opt-in, builds from repo
  evidence, and reminds the user to commit `MEMORO.md` because it is
  cross-session project state.

### Phase C — Live release matrix   · `next`

Validate the exact daily-driver paths outside the sandbox on a real machine with
real tool auth and a global install candidate.

Acceptance:

- `~/memoro`: `mc tool-switch codex --dry-run --json` succeeds without repo-local
  canon files.
- `~/memoro`: `mc resume data` launches Codex with real `MEMORO.md` grounding.
- Codex ChatGPT/Pro auth checksum is unchanged after Codex-selected starts.
- Locked vault skips prompting for Codex when no selected-tool target exists.
- Claude/Anthropic vault materialisation still prompts/materialises/shreds.

### Phase D — Publish gate   · `after Phase C`

Only after live behavior is boring: inspect the tarball, bump version, install
the candidate globally, re-check help/status/tool-switch surfaces, then publish
once.

Acceptance:

- `npm pack --dry-run` includes the new start/wrap/canon modules.
- Global candidate shows the expected `mc --version`, `mc help`, and
  `mc tool-switch --help`.
- Release notes call out native-auth safety, ordinary-repo tool-switch, and
  coordinator wake-up quality.

Automated verification:

- `node --test tests/mc/lifecycle/new.test.js tests/mc/lifecycle/resume.test.js tests/mc/vault/startup.test.js tests/mc/vault/lifecycle.test.js`
- `node --test tests/mc/vault/lifecycle.test.js tests/mc/vault/startup.test.js tests/mc/lifecycle/status.test.js`
- `node --test tests/bin-mc.test.js tests/mc/vault/startup.test.js tests/mc/vault/lifecycle.test.js tests/mc/lifecycle/status.test.js`
- `node --test tests/mc/lifecycle/new.test.js tests/mc/lifecycle/resume.test.js tests/mc/lifecycle/status.test.js tests/mc/tool-switch-here.test.js tests/bin-mc.test.js tests/mc/vault/startup.test.js tests/mc/vault/lifecycle.test.js`
- `node --test tests/mc/wrap-start.test.js tests/bin-mc.test.js`
- `node --test tests/mc/wrap-start.test.js tests/bin-mc.test.js tests/mc/lifecycle/new.test.js tests/mc/lifecycle/resume.test.js tests/mc/vault/startup.test.js tests/mc/vault/lifecycle.test.js tests/mc/tool-switch-here.test.js`
- `node --test tests/mc/wrap-runtime.test.js tests/mc/wrap-start.test.js tests/bin-mc.test.js`
- `node --test tests/mc/wrap-runtime.test.js tests/mc/wrap-start.test.js tests/bin-mc.test.js tests/mc/lifecycle/new.test.js tests/mc/lifecycle/resume.test.js tests/mc/vault/startup.test.js tests/mc/vault/lifecycle.test.js tests/mc/tool-switch-here.test.js`
- `node --test tests/mc/wrap-dispatch.test.js tests/mc/wrap-runtime.test.js tests/mc/wrap-start.test.js tests/bin-mc.test.js`
- `node --test tests/mc/wrap-ws.test.js tests/mc/wrap-dispatch.test.js tests/mc/wrap-runtime.test.js tests/mc/wrap-start.test.js tests/bin-mc.test.js`
- `node --test tests/mc/wrap-startup-message.test.js tests/mc/wrap-ws.test.js tests/mc/wrap-dispatch.test.js tests/mc/wrap-runtime.test.js tests/mc/wrap-start.test.js tests/bin-mc.test.js`
- `node --test tests/mc/wrap-dispatch.test.js tests/mc/wrap-runtime.test.js tests/mc/wrap-start.test.js tests/bin-mc.test.js tests/mc/lifecycle/new.test.js tests/mc/lifecycle/resume.test.js tests/mc/vault/startup.test.js tests/mc/vault/lifecycle.test.js tests/mc/tool-switch-here.test.js tests/mc/lifecycle/dispatch-read.test.js`
- `npm test` (943 passing)
- `node --test tests/mc/ground.test.js tests/mc/ground-lifecycle.test.js tests/mc/ground-role-canon.test.js tests/mc/canon-drift.test.js tests/bin-mc.test.js` (87 passing)
- `npm test` (950 passing)
- `npm_config_cache=/private/tmp/memoro-npm-cache npm pack --dry-run`

Smoke-run finding fixed: `tests/mc/lifecycle/new.test.js` was order-dependent
on the first-run sentinel being written by another test file. The lifecycle
tests now create their own sentinel explicitly, keeping onboarding behavior in
`first-run-cli.test.js` and making the `mc new` smoke runnable in isolation.

Still required before the next npm publish: the live/manual release matrix.

## Next implementation order

1. Re-run the `~/memoro` live check: `mc tool-switch codex --dry-run --json`,
   then `mc resume data` under Codex with locked vault.
2. Run no-auth-mutation Codex live check against a real Codex ChatGPT/Pro login.
3. Run the remaining live matrix entries relevant to vault + tool-switch.
4. Inspect `npm pack --dry-run`.
5. Only then publish the next patch.

## Deferred on purpose

Do not schedule these until live coordinator sessions prove an actual gap:

- map command family
- resume-by-intent
- first-class fanout/verify/gather engine
- ensemble/hierarchy management
- automatic map rewriting
