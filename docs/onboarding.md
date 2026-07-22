# Onboarding `mc`

The README's [Quick start](../README.md#quick-start) covers the
normal path: install, run `mc` once to sign in, then run `mc setup`
to verify the local machine. This file is the longer story — useful
when something doesn't line up, when you're moving to a second machine,
or when you want to know exactly which tools mc will try to integrate
with.

## The first-run flow in one paragraph

Run `mc` first. If this machine has no Memoro token, `mc` starts the
browser device-auth flow, stores the resulting token in the OS keychain,
and asks you to run `mc setup`. `mc setup` then runs every probe
`mc auth status` exposes (Memoro keychain, LLM tools, shell wrapper,
workspace) and prints a numbered checklist of *only* the missing local
steps. Each step is a real command you can paste — `mc`, `mc auth codex`,
`mc install-shell`, or the canonical `npm install -g …` line for a tool
you don't have. When everything passes, it writes
`${MC_HOME}/.setup-done-v1` and exits 0. Re-run it any time; it's
idempotent. On an interactive terminal, setup also offers a resource profile
for local image and motion generation and a project-dependency mode. Pressing
Enter keeps each current selection. Fresh installs use `unlimited` for heavy
jobs and `auto` for dependency snapshot reuse.

## Why install commands are not duplicated here

mc adapters own their install hints (`getStatus()` returns a
`"Install with: …"` string for tools that aren't on PATH). Setup and
`mc auth status` print that string verbatim. This document
deliberately doesn't repeat install commands — drift between docs and
adapters is the bug pattern we're avoiding. To see the exact command
for any tool on your machine, run:

```sh
mc
mc setup
```

…or for one tool's row:

```sh
mc auth codex      # or claude / gemini
```

## What `mc setup` checks, step by step

1. **Memoro token in the OS keychain.** Normally stored by running
   plain `mc`, which starts browser device auth when no token exists.
   The token check is existence-only; `mc setup` does no network
   round-trip in the hot path. `mc auth memoro` remains available as
   the explicit token-login path for CI/headless machines. For that
   path, create a token at <https://meetmemoro.app/app/settings> →
   **API tokens**. Pick **Full access** for the default flow, or split
   into `sessions.write` + `lens.read` if you want a narrower blast
   radius.

2. **The default LLM tool is installed and usable.** Fresh installs use
   Codex by default. Claude Code is supported when selected with
   `mc tool-switch claude` or per-session flags. The probe is
   `which <bin>` plus `<bin> --version`; adapters that can verify auth
   headlessly do so without reading credential contents. If you're
   missing the selected tool, the checklist prints the exact install or
   verification command and asks you to run it before re-running
   `mc setup`.

3. **The shell wrapper.** Installed by `mc install-shell` into your
   `~/.zshrc` or `~/.bashrc` inside a managed block. Without it,
   `mc cd <name>` can't change your shell's cwd — the wrapper
   captures fd 3 from the CLI and `eval`s it. Fish is not currently
   supported by `install-shell` (it's tracked in plan §11f); fish
   users can paste the equivalent function manually.

4. **Optional local heavy-job limits.** The profile controls recognised local
   Python image/motion workloads launched inside future mc sessions. It does
   not affect ordinary Python commands or provider-hosted image generation.
   Setup recommends a profile from physical memory but never selects it for
   you:

   - `unlimited` (default) adds no wrapper or limit.
   - `balanced` allows one heavy job, limits numerical libraries to four
     threads, and stops that job if its process tree passes 4096 MB RSS.
   - `conservative` targets 8 GB-class machines: one job, two threads, a
     2560 MB RSS watchdog, and stricter disk/swap preflight checks.
   - `custom` asks for concurrency, thread, memory, swap, and free-disk
     thresholds.

   Automation never gets a prompt. Select a named profile explicitly with
   `mc setup --resource-profile conservative --json`; custom values use the
   `--heavy-max-*` flags shown by `mc --help`. The choice is stored globally in
   `~/.memoro/config.json` and takes effect only for newly launched or
   relaunched mc sessions. The memory threshold is an active watchdog rather
   than an operating-system hard cap: it terminates only the recognised job
   when the process tree crosses the configured threshold.

5. **Project dependency mode.** This controls what an explicit
   `mc deps hydrate` (and later `mc dev ensure`) may do:

   - `auto` (default) reuses an immutable machine-local snapshot with an APFS
     clone-on-write copy when possible. A cache miss runs the repository's
     declared `npm ci` recipe and publishes a snapshot.
   - `isolated` runs the recipe only in the current worktree and never accesses
     snapshots.
   - `off` prevents mc from installing project dependencies.

   Select it non-interactively with
   `mc setup --dependency-mode <auto|isolated|off> --json`. mc never shares a
   mutable `node_modules` symlink between worktrees, never replaces an
   unmarked directory without `mc deps hydrate --replace`, and never installs
   dependencies during `mc new`. Hydration is an explicit code-execution
   boundary because npm lifecycle scripts may run.

When all required checks pass, `mc setup` writes the `${MC_HOME}/.setup-done-v1`
sentinel so the friendly first-run hint in `mc new` / `mc list`
silences itself for that machine.

## Migrating from `memoro-cli login`

If you already ran `memoro-cli login` before `mc setup` existed, you
have a token but no sentinel. The first-run hint won't fire (the
trigger is **both** signals missing — see [§11d](./plans/worktree-lifecycle.md#11d-first-run-friendliness-in-existing-commands)),
and the first successful `mc new` writes the sentinel silently. No
action required.

## Multi-machine

Memoro sign-in is per-machine. The keychain entry doesn't synchronise
across hosts, so on each new laptop / server / VM you'll run:

```sh
npm install -g memoro-cli
mc
mc setup
```

`mc sessions list` will then show sessions from every machine that
has reported a heartbeat against the same Memoro account — it's the
multi-host view; worktrees themselves stay per-machine.

A "trust this machine from your phone" QR / short-code link is
discussed in plan §11f as a deferred v2 idea. For v1, the manual
login per machine is the path.

## Shell wrapper quirks

`mc install-shell` writes a function into your rc file inside a
managed block (`# >>> memoro mc shell wrapper >>>`). The function
runs `command mc "$@" --emit-shell-directives` and `eval`s the
captured fd 3 — that's how `mc cd <name>` actually changes your
shell's cwd, and how `mc end <name>` can drop you back to the
primary worktree.

- **zsh and bash** are first-class. The same template works for both;
  the install script writes to whichever your `$SHELL` points at.
- **fish** isn't supported by `install-shell` today (plan §11f).
  Fish users get a clear unsupported message and can paste the
  equivalent function manually.
- **WSL** isn't a targeted environment today; the stack assumes a
  POSIX shell with `node-pty` working transparently in the terminal.

## Authority lives in the verbs, not in this document

If anything in this file disagrees with what `mc setup` /
`mc auth status` prints on your machine — believe the CLI. The
checklist is generated from live probes against your actual
installation; this document is a longer-form rationale around it.
The plan in [`docs/plans/worktree-lifecycle.md`](./plans/worktree-lifecycle.md)
is the authoritative design source.
