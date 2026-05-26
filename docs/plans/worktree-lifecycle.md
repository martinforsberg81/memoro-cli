# mc as the worktree + session manager (subsume and replace cs)

**Status:** proposed • 2026-05-25

## Motivation

Today `mc` tracks live Claude processes (heartbeat, list, send) but knows
nothing about the *container* they run in — the worktree and branch. `cs`
owns that container with a clean lifecycle (`new → list → resume → end`),
so working with `cs` feels smoother than working with `mc` — exactly
backwards from what we want.

Concrete pain points observed in practice:

- After a mass shutdown of parallel sessions, `mc sessions list` shows
  many stale heartbeats with `503 No active CLI connection` — no way to
  know from `mc` what each was working on, no way to clean them up.
- When `mc`-spawned Claude (or a subagent with `isolation: "worktree"`)
  creates a worktree, it lands at `.claude/worktrees/<name>` *inside the
  repo working tree*. This makes the working tree dirty, blocks
  `npm run release:race`, and leaves no `mc … end` path to clean up.
- `mc` has no concept of branch naming, so isolation worktrees get
  auto-generated names like `worktree-<name>` that aren't renameable
  without manual `git branch -m`.
- The user has to cross-reference `mc sessions list`, `cs list`, and
  `~/.claude/projects/*/` transcripts by hand to know what each session
  was last doing.

We chose **path A** in the design discussion: `mc` subsumes `cs`, then
`cs` is scrapped. The bar is: `mc` must be **strictly better** than `cs`
on every lifecycle operation, plus add capabilities `cs` doesn't have
(coordinator view, cross-machine, model switching, transcript-derived
status).

## Goals

1. One tool (`mc`) for the entire worktree + branch + session lifecycle.
2. Isolation worktrees from subagents flow through the same lifecycle —
   never leak into the repo working tree.
3. `mc list` shows rich, derived status — "what was this session last
   doing?" — without the user having to read transcripts manually.
4. Switch LLM/model mid-session (Claude → OpenAI/Codex → Gemini …) and
   keep the worktree, branch, and prior context.
5. Spawn heterogeneous subagents — parent on one model, workers on
   cheaper/different models — with a single command. Parallel,
   coordinated, cost-aware.
6. Orchestrate fleets of agents from a single parent session:
   plan-driven fan-out, hierarchical mid-agents, multi-model
   ensembles, and adversarial verifiers — without the parent
   blocking on any of them.
7. Graceful migration: existing `cs` worktrees keep working until cut
   over; nothing breaks under foot.

## Non-goals

- Not building our own Claude-Code-style TUI. We still launch the
  underlying coding tools (Claude Code, Codex, etc.) — `mc` orchestrates.
- Not replacing git. Branches remain pure git; `mc` only owns the
  *conventions* (naming, where worktrees live).
- Not cross-repo session graphs. One repo at a time.

## Design

### 1. Worktree placement — under existing `~/.memoro/mc/`

Drop both `.claude/worktrees/<name>` (leaks into repo working tree) AND
the cs-style sibling-dir `<repo>--<name>` (clutters the parent
directory; the user explicitly called this out as a pain point — having
~20 `memoro--sess-*` siblings next to the repo is too messy to scan).

**Default:** `~/.memoro/mc/worktrees/<repo-slug>/<name>`

(Earlier drafts of this plan named `~/.mc/`; the foundation-decisions
round revealed that `~/.memoro/mc/` already exists with sockets and
metadata. Consolidating mc state under one root is cleaner — backup,
audit, and "delete all mc state" become one operation.)

- `<repo-slug>` = the basename of the primary worktree (`memoro`,
  `memoro-cli`, etc.). Collisions across different repos with the same
  basename are resolved by appending a short hash of the absolute
  primary-worktree path.
- **Do not disturb existing `~/.memoro/mc/` contents** (sockets, the
  registry, runtime metadata). The `worktrees/` directory is purely
  additive as a sibling under that root.
- Editors handle longer paths fine; project-root detection still works
  (each worktree has a `.git` file pointing back at the primary
  worktree's `.git/worktrees/<name>` — git tooling stays happy).

`MC_HOME` env var (defaults to `~/.memoro/mc`) controls the root for
testing and per-machine overrides. Public `mc config worktree.root
<path>` is deferred — YAGNI until a second user wants a different
location.

The shell wrapper (§2b) makes the long path irrelevant in practice —
users navigate by name (`mc cd <name>`), not by typing the path.

### 2. First-class lifecycle commands

Today's `mc new <label>` (tag a wrapped Claude session in cwd with a
label, no worktree) and the new `mc new <name>` (create worktree +
branch + launch tool) are semantically different operations sharing
one verb. Foundation release splits them:

- **`mc new <name>`** — the §2 contract below: worktree + branch +
  launch. The label-tagging behaviour is gone from this verb.
- **`mc wrap <label>`** — the old label-tagging behaviour, moved to
  its own verb. Attaches mc tracking to a Claude session already
  running in cwd. Useful for sessions Claude started outside mc.
- Plain `mc` (no args) keeps its current ad-hoc behaviour.

Registry-schema implication: store `label` and `worktree_name` as
**separate fields** even when they have the same value. Lets us
later add `mc rename --label <new>` without touching the worktree
directory.

```
mc new <name> [--from <ref>] [--tool claude|codex|gemini] [--no-launch]
   create worktree, create bootstrap branch sess/<name>, launch tool.
   --no-launch is an undocumented test-only flag that skips the
   tool-launch step (otherwise tests would hang on a real Claude TUI).

mc list
   default: only user-created work-sessions. Table: name · branch ·
   dirty/clean · session live? · last activity · open question (derived
   from last assistant message, see §4). Transient isolation worktrees
   from subagents are hidden — they are infrastructure noise, not work.

mc list --all
   include transient isolation worktrees (from subagent spawns) and dead
   sessions still pending gc. Same columns plus a `kind` flag
   (work | isolation | spawn).

mc resume <name> [--no-launch]
   cd to worktree, claude --resume (or codex resume, etc., per stored
   tool); same picker behaviour the user already knows.
   --no-launch: test-only, same as on `mc new`.

mc wrap <label>
   attach mc tracking to the Claude session already running in cwd,
   with <label> as the friendly identifier. Does NOT create a worktree.
   Use when Claude was started outside mc and you want it in `mc list`.

mc end [<name>|.] [--force] [--keep-branch]
   - mc end <name>   end by name from anywhere
   - mc end .         auto-detect: end the worktree you're currently in
   - mc end           if you are inside a worktree, treat as `mc end .`
                      with a confirm prompt; otherwise print usage
   refuse if session is live without --force; remove worktree; delete
   bootstrap branch only if merged (cs's heuristic, kept). After end,
   the shell wrapper auto-cd's back to the primary worktree (see §2b)
   so you don't have to `cd ..; cd memoro` by hand — the cs friction
   point the user explicitly called out.

mc cd <name>
   change directory to the worktree (requires shell wrapper, §2b)

mc rename <old> <new>
   git branch -m AND mv worktree directory in one step; updates index

mc gc [--dry-run]
   list/clean worktrees whose session is dead AND branch is merged;
   never deletes a dirty worktree

mc dispatch <name> "<message>"
   today's `mc sessions send`, renamed for symmetry

mc read <name> [--last N]
   today's `mc sessions read`, name-resolved
```

### 2a. Source layout + registry path

memoro-cli has two binaries (`memoro` / `memoro-cli` via `src/bin.js`,
and `mc` via `src/bin-mc.js`). They have different command domains.
Keep them in mirrored trees:

```
src/bin.js          → src/commands/<name>.js    (memoro-cli verbs)
src/bin-mc.js       → src/mc/commands/<name>.js (mc verbs)
src/mc/coordinator.js (renamed from coordinator-command.js — follow-up)
```

`bin-mc.js` is a **thin + lazy** dispatcher: it parses the verb and
`await import('./commands/<verb>.js')` on demand, never preloads all
commands. Cold-start matters because `mc` is invoked frequently from
fan-out flows (§10).

Future mc sub-systems (`src/mc/registry/`, `src/mc/sandbox/`,
`src/mc/orchestration/`, `src/mc/transport/`) all live under
`src/mc/` so the boundary stays clear.

**Registry location:** `${MC_HOME}/registry.json` (default
`~/.memoro/mc/registry.json`). One JSON document per machine, edited
through registry helpers in `src/mc/registry/`. Schema includes
`worktree_name`, `label`, `branch`, `tool`, `parent_id` (§10),
`kind` (§5b + §10), and timestamps.

### 2b. Shell wrapper — make `mc cd` and post-`end` cd-back actually work

A child process cannot change its parent shell's cwd. So `mc cd <name>`
and "auto-cd back to primary worktree after `mc end`" both require a
**shell function wrapper** that evals a directive emitted by the
CLI. This is the same trick `nvm`, `direnv`, `kubie`, and `zoxide` use —
boring, well-understood territory.

Install step (one-time, added to user's `~/.zshrc` / `~/.bashrc` by
`mc install-shell`):

```bash
mc() {
  local out
  out=$(command memoro-cli "$@" --emit-shell-directives 3>&1 1>&2 2>&3)
  local rc=$?
  [ -n "$out" ] && eval "$out"
  return $rc
}
```

The CLI writes normal output to stdout (visible to the user) and any
shell directives — `cd <path>` lines — on fd 3, which the wrapper
captures and eval's. Concretely:

- `mc cd <name>` → emits `cd /Users/x/.mc/worktrees/memoro/<name>`
- `mc new <name>` → spawns the tool, then on exit emits `cd <primary>`
- `mc end <name>` (from inside that worktree) → emits `cd <primary>`
  *before* removing the worktree, so the shell isn't sitting in a
  deleted directory
- `mc resume <name>` → emits `cd <worktree>` *before* launching the
  tool (matters because the tool's cwd should be the worktree)

If the wrapper isn't installed, the commands still work — they just
don't change the shell's cwd. The CLI detects this (no fd 3 attached)
and prints a hint: *"Tip: run `mc install-shell` to enable auto-cd."*

### 3. Branch naming + rename ergonomics

Default bootstrap: `sess/<name>` (same as cs). Renameable without
friction via `mc rename` — single command, branch + directory in one
swoop. Cs left the branch-rename step to the human; `mc` does both.

Isolation worktrees from subagents get a distinct prefix
(`iso/<parent>-<short>`) so they're visible as transient in `mc list`
and `mc gc` knows to be more aggressive about cleaning them.

### 4. `mc list` shows the container, not just the process

The user manually cross-referenced today by `jq`-ing the last
assistant/user message from each transcript at
`~/.claude/projects/<encoded-path>/*.jsonl`. That cross-reference should
be a feature, not a workaround.

For each worktree, derive:

- `last_user_msg` — last `type=user` string-content message
- `last_assistant_text` — last `type=assistant` text content block
- `open_question` — heuristic: if the last assistant text ends with a
  `?` or "Vill du …" / "Want me to …" / multiple-choice prompt, surface
  it as "PAUSED — awaiting answer"
- `last_activity` — mtime of newest `.jsonl` in the project dir
- `session_state` — `live` (heartbeat fresh) / `idle Nm` / `dead` /
  `no-session-yet` (worktree exists but never had Claude run in it)

Same derivation for Codex / Gemini transcripts via the adapter layer —
each adapter exposes `getTranscriptStatus(worktreePath)`.

### 5. Switch LLM / model mid-session

The signature use case the user named: *"I did this part with Claude, my
tokens are out, switch to OpenAI and continue with my OpenAI tokens."*

```
mc switch <name> --to codex [--model gpt-5-mini] [--turns 20]
```

What it does:

1. Stop the active session in the worktree (clean Claude exit).
2. Read the current transcript via the source adapter
   (`adapters/claude-code.js → exportSession(...)` returns a
   tool-agnostic message array).
3. Render it as a *context preamble* via the target adapter
   (`adapters/codex.js → importSession(messages, opts)`). Each adapter
   knows its own format — Codex gets a system-prompt prefix with
   "Continuing from prior session, here is the transcript so far:" and
   the last N turns (default: enough to fit ~20k tokens, configurable).
4. Launch the target tool in the same worktree.
5. Persist the switch in `mc`'s session record so `mc list` shows
   *current* tool + *prior* tool chain ("claude → codex").

Constraints to be explicit about:

- **Lossy by design.** Tool calls, file states, and IDE-side state
  don't transfer; only the conversation does. The user takes over
  in the new tool aware that the *worktree* is the source of truth
  for code state, not the transcript.
- **Token-budget controlled.** `--turns N` and `--budget Tkn` knobs.
  Default trims to last N user-assistant turns *plus* the original
  task prompt (first user message).
- **No silent model-equivalence claims.** `mc list` shows the chain so
  the user remembers which tool produced which part of the code.
- **One-way per call.** Switching back is a fresh `mc switch`. We
  don't try to be smart about merging two transcripts.

Adapter contract additions (extends current `adapters/*.js`):

```js
// adapters/<tool>.js
export async function exportSession(worktreePath, opts) { ... }
//   → { messages: [{ role, content, ts }], tool, transcriptId }
export async function importSession(messages, worktreePath, opts) { ... }
//   → spawns the tool with the messages injected as initial context
export async function getTranscriptStatus(worktreePath) { ... }
//   → { lastUserMsg, lastAssistantText, lastActivity, sessionState }
```

Initial adapters to wire: `claude-code`, `codex`. Gemini CLI is named in
package.json keywords already — likely already part of the roster.

### 5b. Heterogeneous subagents — different model per worker

A complementary use case the user named: *"I'm running Claude as the
main session and want to fire off two subagents using gpt-4.1-mini —
parallel, cheap, focused."*

This is **horizontal** model switching (parallel workers using cheaper
models) vs §5's **vertical** switch (same session continued on a
different model). They share infrastructure but the UX is different.

```
mc spawn <name> --model gpt-4.1-mini --task "audit src/auth/ for ..."
mc spawn <name> --model claude-haiku-4-5 --task "..."
mc spawn <name> --tool codex --model o4-mini --task "..."
```

Semantics:

- `mc spawn` creates a **transient subagent** in a fresh isolation
  worktree (re-using §6's plumbing) but pinned to a specific
  *tool + model*, not just a tool. The adapter takes `model` as a
  first-class option.
- The subagent is **task-shaped, not interactive**. It gets the task
  prompt, runs, reports back via stdout + a structured result file, and
  exits. No `claude --resume` picker needed because there's nothing to
  resume into.
- The parent session sees the spawn in `mc list` as `(subagent,
  parent=<name>, model=<model>)` and can `mc read <subagent-id>` to pull
  the result back into its own context.
- Token accounting is per-tool: a Claude parent + GPT-4.1-mini worker
  draws on two different quotas. `mc list` surfaces token usage per
  tool so the user can see "Claude tokens out, OpenAI tokens fine —
  spawn more on OpenAI for now".

Why this is more than "just run two CLIs in parallel":

- **Coordination layer.** Parent's `mc list` sees worker state; worker
  results land in a stable path the parent can read; cleanup is
  automatic.
- **Model heterogeneity is a feature, not a workaround.** Cheap
  workers (gpt-4.1-mini, Haiku, Gemini Flash) doing parallelisable
  grunt work (audits, formatting, doc generation, test scaffolding)
  while the expensive model (Opus, Sonnet) holds the architecture
  thread. Today this works by hand; `mc spawn` makes it a one-liner.
- **Honest about model strengths.** The adapter layer can warn when
  a task type is poorly matched to the requested model (e.g., "you
  asked Gemini Flash for structured JSON output — that fails
  reliably; suggest gpt-4.1-mini instead", per
  [[feedback_gemini_structured_output]]).

Open questions specific to this:

- Streaming worker output to parent live, or only on completion?
  Probably both — live for tail, final file for the parent to ingest.
- Cost guardrails: should `mc spawn` refuse if the worker quota is at
  90 %+? Default to warn, configurable to hard-stop.
- Result format: free-text vs structured. Probably both available;
  default to free-text + a `mc spawn ... --json-schema <file>` for
  when the parent needs structure.

### 6. Subagent isolation worktrees flow through the same lifecycle

When the host tool (Claude, Codex, …) spawns a subagent with
`isolation: "worktree"`:

- The hook intercepts the request and routes it through `mc new
  --transient --parent <session-name> <short-id>`.
- The transient worktree lands at the configured `worktree.root` with
  branch `iso/<parent>-<short>` — *never* inside `.claude/worktrees/`.
- It shows up in `mc list --all` flagged as `(isolation, transient,
  parent=<name>)`.
- `mc gc` reaps it as soon as the parent agent finishes and the branch
  has no unique commits (or merges back if it does — design TBD).

This is the fix for the gitignore-leak problem the user just hit.

### 7. Migration from `cs`

Phase 1 (this plan): build `mc new/list/resume/end/rename/gc` to parity
with `cs`. Ship behind no flag — they're new commands, they don't
conflict.

Phase 2: `cs` becomes a thin shim that prints a deprecation notice and
calls `mc` under the hood. One release cycle.

Phase 3: remove `cs`.

Existing `cs`-created worktrees at `<repo>--sess-<name>` keep working
throughout because `mc` reads `git worktree list` for state, not its
own registry. The registry stores *extra* metadata (tool, model chain,
parent of transient) but the source of truth for "what worktrees
exist" stays git.

### 8. Memoro-native terminal — sessions in the browser

End-game vision the user articulated: log in once to Memoro, see your
parallel sessions as tabs in a fullscreen browser window — coordinator
view as the entry surface, click a session to attach to its PTY.

Why this is reachable from where mc already is today:

- **Cloud relay exists.** `mc sessions send / read` already round-trips
  through a Memoro-cloud channel to a local listener. Same plumbing
  carries PTY byte-streams once we widen it.
- **Session registry exists.** `mc list` is the coordinator view in CLI
  form; the browser UI is the same data, different render.
- **Auth exists.** Memoro accounts already gate the cloud relay.

What's new:

1. **PTY broker on the local machine.** `mc broker` (daemon) wraps each
   active session in a `node-pty` instance, streams stdout/stderr up
   to Memoro over the existing channel, accepts stdin going back down.
   Detached by default — the broker survives terminal-app close, like
   tmux. One broker per machine; auto-starts on `mc new`.
2. **Browser UI.** `xterm.js` per tab inside the Memoro app. Tabs are
   driven by `mc list` (filtered to this user's sessions across
   machines). Tab open = broker assigns a stream id, browser attaches.
3. **Detach/reattach.** Page reload or tab close = detach. Re-open =
   reattach to same stream, ring-buffer replays the last N kB so you
   see the recent output. Sessions never die just because the browser
   went away — they're owned by the local broker.
4. **Cross-machine pickup.** Each broker registers under
   `<user>/<machine-id>`. Browser shows sessions from all your
   machines; attaching to a session on another machine routes the
   stream through the cloud relay end-to-end. You move from MacBook
   Air to a different machine and your sessions are there.

Security model (non-negotiable):

- **PTY tokens are short-lived, scoped, revocable.** Each browser-tab
  attachment gets a token scoped to one session id + one stream
  direction, TTL ~5 min, refreshed by the active tab. Revoke per-tab
  or globally from the Memoro account.
- **Local hooks still rule.** `block-prod-wrangler.sh`,
  `block-secret-reads.sh`, and the rest of the Claude PreToolUse hooks
  run on the *broker side* — i.e., the actual PTY, same as today.
  Browser-attached sessions get exactly the same denials as a local
  terminal. The browser is a viewport, not a privilege expansion.
  ([[project_pending_key_rotation]] policy intact.)
- **No keystroke logging in transit.** Stream is encrypted hop-to-hop
  via the existing TLS to the relay; the relay does not persist
  contents (it's a router, not a recorder). Audit-log records only
  *session attach/detach events* and target session id — not the
  bytes.
- **End-to-end is a phase 4 follow-up.** Initial release is TLS to
  relay + TLS to broker, relay-trusted. End-to-end (browser ↔ broker
  with relay seeing only ciphertext) is the next hardening pass.

Phasing:

- **Phase 1 (this plan).** Local CLI cleanup: hidden worktree root,
  end-from-anywhere shell wrapper, adapter unification, mc list with
  derived status, mc switch / mc spawn, transient handling. No browser
  surface yet. *This is the bulk of the work and delivers
  ~80 % of the user-felt smoothness on its own.*
- **Phase 2.** `mc broker` + PTY streaming over the existing relay.
  Browser-side proof of concept: one session, one tab, attach/detach
  round-trip. Validates the security model.
- **Phase 3.** Full browser UI inside Memoro app: coordinator view as
  the entry surface, multi-tab, ring-buffer reattach, single-machine
  scope.
- **Phase 4.** Cross-machine session pickup; end-to-end encryption
  hardening; offline broker queueing.

Honest constraints:

- **Latency per keystroke** matters for terminal UX. Same-continent
  routing is fine; trans-continental adds visible lag. Memoro-cloud
  region selection per user becomes a real consideration.
- **Performance.** Many concurrent PTYs streaming chatter from a
  Claude Code session is real bandwidth. The broker must coalesce
  output (1–10 ms windows) and the relay must back-pressure. Standard
  practice; not novel work.
- **Compliance.** A Memoro-hosted terminal that reaches a user's
  *own machine* is technically the user controlling their own shell
  via a browser — no new third-party gets shell access. But the legal
  story for sub-processors / DPA needs to be checked
  ([[project_unused_providers]] reminds us the subprocessors page must
  match reality).

### 9. Cleanup tooling — lessons from a real session-cleanup run

Friction notes from a real session-cleanup run on 2026-05-26 where ~20
parallel sessions had to be triaged, ended, or routed for action. The
existing scaffolding worked but required too much manual bash + jq +
`gh pr view` cross-referencing. Each item below maps a pain point to a
concrete design, with a pointer to where it lives in mc.

**9a. `mc status <name>` and `mc list --rich`** (extends §2 `mc list`)

Combine into a single command what cleanup actually needs per session:

- last activity timestamp (mtime of newest `.jsonl`)
- last *user* message (string-content only — skip tool results)
- last *assistant text* (`type=assistant` text content blocks — skip
  tool calls)
- open question (heuristic on last assistant text: ends with `?`, or
  contains "Vill du" / "Want me to" / "ja eller nej" / "A or B" /
  numbered choices)
- dirty file count
- commits ahead of `origin/main`
- safety verdict: `SAFE_TO_END` | `NEEDS_REVIEW` | `HAS_UNMERGED_WORK`
  | `IS_ACTIVE_NOW` (transcript mtime < 5 min) | `IS_SQUASH_PHANTOM`

`mc list --rich` runs this for every session in one pass and shows the
verdict + open question inline so a human can scan 14 sessions in 30
seconds instead of opening each one.

Open-question detection can fall back to a tiny LLM call (gpt-4.1-mini
or similar via [[feedback_short_llm_interactions]]) when the heuristic
is ambiguous. Budget: ~5 tokens output per session, batched.

**9b. Squash-merge phantom detection in `mc end`** (extends §2 `mc end`)

A branch with N commits ahead of main may already be merged via squash
— the change set lives on main under a different hash. Today this
shows as "1 commit ahead" and looks unsafe.

**Three-tier detection** (soft-degrade across the chain):

```js
// Tier 1 — local, no auth, fast
const cherry = await git('cherry', mainRef, branchRef);
// Output: lines starting with '+' (unmerged) or '-' (patch-equivalent on main)
const allPatchesOnMain = cherry.lines.every(l => l.startsWith('- '));
if (allPatchesOnMain) {
  return { verdict: 'IS_SQUASH_PHANTOM', confidence: 'high', source: 'cherry' };
}

// Tier 2 — remote, requires gh, higher confidence
if (await gh.available()) {
  const prs = await gh.prList({ head: branchRef, state: 'merged' });
  if (prs.length > 0) {
    // Cross-check: do all files touched by the branch appear identical on main?
    const branchFiles = await git('diff', '--name-only', mainRef, branchRef);
    const diff = await git('diff', branchRef, mainRef, '--', ...branchFiles);
    if (diff.empty) {
      return { verdict: 'IS_SQUASH_PHANTOM', confidence: 'high', source: 'gh-pr' };
    }
  }
}

// Tier 3 — degraded; gh unavailable AND cherry inconclusive
return {
  verdict: 'NEEDS_REVIEW',
  hint: 'Possibly squash-phantom. Run `gh auth login` to confirm, ' +
        'or check `gh pr list --head <branch>` manually.',
};
```

Why three tiers:

- Tier 1 catches the common case for free — no auth, no network, ~10ms
- Tier 2 confirms via PR history when gh is present (higher confidence
  because cherry alone can have false positives on rebased branches)
- Tier 3 keeps the command working without gh — `NEEDS_REVIEW` prompts
  human judgement instead of silently proceeding

**`gh` is injected, not invoked directly** — `mc end` takes an
optional `{ gh }` portal in its options; default = real gh shell
wrapper, tests pass a stub. Same DI port for any other gh-touching
command (`mc gather`, `mc fanout`, `mc verify`).

Without this, the user has to manually run `gh pr view`, grep for
files on main, and *decide* — every time. With this, end-of-cycle
cleanup is one command in the common case and explicit about
uncertainty in the degraded case.

**9c. Bulk `mc end` and `--dry-run`** (extends §2 `mc end`)

```
mc end home-status inbox liveapp xero            # bulk, sequential
mc end --dry-run home-status inbox liveapp xero  # preview only
```

`--dry-run` output is one line per target:

```
home-status  → SAFE_TO_END (clean, 0 ahead, branch merged)
inbox        → SAFE_TO_END (clean, 0 ahead, branch merged)
liveapp      → SAFE_TO_END (clean, 0 ahead, branch merged)
xero         → NEEDS_REVIEW (1 dirty file: docs/CHANGELOG.md)
```

→ Today's "4 separate `cs end` commands + read 4 separate confirmations"
becomes one paste + one read.

**9d. `mc list --awaiting` and other status filters** (extends §2 `mc list`)

The single most valuable categorisation during cleanup was "which
sessions are paused on a question to me". Make it a built-in filter:

```
mc list --awaiting           # sessions whose last asst msg is a question
mc list --idle [--since 6h]  # no activity since N (default 6h)
mc list --safe-to-end        # SAFE_TO_END verdict from 9a
mc list --has-unmerged       # commits ahead of main that aren't phantoms
mc list --active             # live heartbeat or transcript activity < 5m
```

Compose with `mc end --dry-run "$(mc list --safe-to-end --names)"`
for one-shot cleanup of the safe set.

**9e. `mc reconcile` — "your work is already on main"**

New top-level command. Scans every session in `mc list` and surfaces:

- Sessions whose entire commit set is on main (squash-merge phantoms,
  per 9b). Suggested action: `mc end`.
- Sessions whose recent transcript references a PR number that has
  since merged. Suggested action: verify + end.
- Sessions whose dirty files match files modified by a recently-merged
  PR (parallel-session collisions). Suggested action: review for lost
  work, then end.

Output is a triage list, one suggested action per session. The user
runs `mc reconcile --apply --only-safe` to act on the unambiguous
cases automatically.

This solves the recurring "I shipped this fix from a parallel session
but the original session doesn't know" problem that hit four times in
the 2026-05-26 cleanup run.

**9f. PR ↔ session mapping** (extends §2 `mc list`)

Today, when a PR merges I have to *guess* which local session owned
that work. `mc list` should show, per session, the PRs that:

- have `head = <session-branch>` and are open
- have `head = <session-branch>` and merged in the last 7 days
- modified files that overlap with the session's dirty/staged files

Cache the GitHub API responses per branch with a 15-minute TTL so this
doesn't hammer rate limits on every `mc list`.

**9g. `mc since <window>` — activity timeline**

```
mc since 1h       # what changed in the last hour
mc since today
mc since 7d
```

Lists, across all sessions:

- PRs that merged (and which sessions owned them)
- branches that moved (commits added)
- sessions that flipped state (`dirty` ↔ `clean`, `active` ↔ `idle`)
- new questions surfaced by sessions (their last asst msg became
  a question since last `mc since` call)

→ Answers "what happened while I was gone" without `git log`
spelunking. Same data the browser UI in §8 surfaces; this is the CLI
view.

**9h. Dispatch to dead sessions + bulk dispatch** (extends §2 `mc dispatch`)

Today's `mc sessions send` only works if the live CLI is attached.
Most sessions in the 2026-05-26 run had dead heartbeats (post-shutdown).
Fix:

- **Queue if not live.** `mc dispatch <name> "<msg>"` writes the
  message to the session's pending-inbox under `~/.mc/inbox/<name>/`.
  On next `mc resume <name>`, the message is replayed as the first
  user turn (after the resume picker selects the transcript).
- **Bulk dispatch:** `mc dispatch fixes asc onboarding "Verifierat —
  du kan stänga"`. Sends the same message to N sessions.
- **Safety:** dispatching to live sessions still goes through the
  existing send channel; queued dispatch is for dead-but-resumable.

→ Lets the user respond to all the "väntar på ditt svar"-sessions in
one batch instead of resuming each first.

**9i. Auth pre-flight in `mc end` / `mc ship` / `mc reconcile`**

The 2026-05-26 run had a parallel Claude session spend 2 min 45 s
hitting `gh auth status` failures because a `gh` keyring token had
silently expired. Fix:

- Any mc command that *will* call `gh` (PR ops, reconcile, etc.)
  runs a 200 ms pre-flight: `gh auth status -h github.com` quietly.
- If it fails, refuse the command up-front with a clear single-line
  hint: `gh token expired or missing — run 'gh auth login -h github.com'
  and retry`.
- Never silently consume a failure and try again 4 times.

Same pattern for any external auth mc depends on (Memoro account
token, OpenAI/Anthropic keys if `mc switch`/`mc spawn` is invoked).

**9j. Orphan daemon reaping in `mc gc` and `mc list`** (extends §2 `mc gc`,
`mc list`)

Real observation from 2026-05-26: 9 orphaned `memoro-cli heartbeat-loop`
daemons were running on the user's machine — accumulated over a week
from sessions whose Claude process had died but whose heartbeat daemon
kept ticking. Several daemons fought for the same `coding_session_id`,
producing a tight ping-pong:

```
GET /api/sessions/ws ...                                            (daemon A connects)
[UserSession] Closed { deviceId: 'cli', code: 4003 }                (server closes daemon B)
GET /api/sessions/ws ...                                            (daemon B reconnects)
[UserSession] Closed { deviceId: 'cli', code: 4003 }                (server closes daemon A)
...
```

~1 req/s per orphan pair, sustained indefinitely.

The immediate client bug — daemon ignoring server's `4003 'Replaced'`
close code — landed as a code fix (`isTerminalCloseCode` in
`src/commands/ws-client.js`). After that, the *replaced* daemon exits
cleanly. But that doesn't help the case where Claude dies and *no
other* daemon replaces the old one — the heartbeat-loop keeps ticking
until something else evicts it.

Surface in mc:

```
mc list --orphans
   List heartbeat-loop processes whose llm_session_id no longer
   maps to a live worktree on this machine, or whose pidfile is
   newer than 24h with no observed activity.

mc gc --reap-orphans [--dry-run]
   Inspect `~/.memoro/heartbeat-*.pid`, cross-reference against
   `mc list`'s known worktrees + active llm sessions, and SIGTERM
   the daemons that don't belong to anything live. Refuses to
   reap a daemon younger than `--min-age` (default 5 min) to
   avoid killing a freshly-spawned one mid-handshake.

mc list (default)
   Annotate any session whose paired daemon is dead, or whose
   daemon is alive but the worktree it's heartbeating for is
   gone, with an `(orphan-daemon)` flag.
```

Detection algorithm (pure helper, testable):

```
for each pidfile in ~/.memoro/heartbeat-*.pid:
  pid = readPidFile()
  if !isAlive(pid): mark "stale pidfile" → unlink, move on
  llmSessionId = parsePidFilename()
  worktree = findWorktreeForLlmSession(llmSessionId)
  if !worktree && pidAge > minAge:
    mark "orphan" → eligible for SIGTERM
```

The pidfile naming already encodes `llm_session_id`
(`pidFilePath()` in `src/commands/heartbeat-loop.js`), so the cross-
reference is local-only. No server round-trip required.

**Server-side complement** (not in this plan; flagged for a separate
follow-up): the UserSession DO emits `4003 'Replaced'` correctly today
but has no eviction path for *truly stale* sessions (no client ever
reconnects, KV TTL hasn't fired yet). A short-lived heartbeat ack
TTL on the server would let it close idle connections faster.

**Priority order**

Of these, **9a, 9b, 9c, 9d** were the friction points that hit during
*every* session in the 2026-05-26 run — they should land in the same
release as the §2 base commands, not as a follow-up. **9j** (orphan
daemon reaping) is high-priority follow-up because the trigger
condition was already observed in prod (9 accumulated daemons hitting
the API ~1 req/s each). The rest (9e–9i) are still wins but have
narrower trigger conditions.

### 10. Orchestration patterns — agent fleets, ensembles, verifiers

§5b introduced `mc spawn` for single heterogeneous subagents. This
section builds on that primitive to support four orchestration
patterns the user named as core to "easier coding": a parent session
becomes a coordinator that ships work in parallel and stays
responsive for planning while children execute.

The patterns are independent primitives — they can be combined (a
fan-out's child can be a mid-agent; an ensemble can be used as a
verifier).

#### 10a. Fan-out by plan phases

```
mc fanout <plan.md> [--from main] [--model-default gpt-4.1-mini]
                   [--budget-total $5] [--strategy serial-deps]
```

mc parses the plan's phase headings (`## Phase 1: ...` or a YAML
frontmatter `phases:` list — both supported, YAML preferred when
ordering or dependencies matter) and spawns one agent per phase in
parallel. Each agent:

- Receives the phase body as its task prompt (plus the plan's intro
  as shared context — captured as a frozen preamble so phases stay
  reproducible).
- Runs in its own fresh isolation worktree (per §6) with a branch
  `fan/<plan-slug>/<phase-N>` rooted at `--from`.
- On completion, opens a PR against a **shared collection branch**
  `wip/<plan-slug>` (not `main` directly) — keeps every phase's
  diff visible side-by-side for review.
- Pings the parent session via push event (`fanout_phase_done`).

Parent renders a collection card in chat (per
`chat-coordinator-coding.md` §6) with one progress row per phase.
**Crucial property: the parent does not block.** While children
work, the parent keeps the conversation going — planning the next
slice, drafting copy, anything.

When all phases land, `mc gather <plan-slug>`:

1. Detects diff conflicts between sibling PRs (overlap on same
   file ranges → escalate, don't auto-merge).
2. Merges phases in dependency order (`--strategy serial-deps`)
   or all-at-once (default) into the collection branch.
3. Opens one summary PR `wip/<plan-slug> → main` with the merged
   set, ready for human review.

#### 10b. Hierarchical orchestration — agents spawning agents

A mid-level agent (e.g. handling "frontend changes") can call
`mc spawn` recursively, becoming a coordinator for its own
sub-fleet. The orchestration tree is what differs from §5b's flat
spawn — mc needs:

- **Tree visualisation:**

  ```
  mc list --tree
  └─ refactor-frontend (Claude Opus, planning sub-areas)
     ├─ refactor-auth (Sonnet, ▶ planning 3 children)
     │  ├─ oauth-flow      (gpt-4.1-mini, ▶ step 2/5)
     │  ├─ session-store   (gpt-4.1-mini, ✓ PR #6478)
     │  └─ logout-route    (gpt-4.1-mini, ✘ failed: tests broken)
     ├─ refactor-nav       (Sonnet, ⏸ blocked on refactor-auth)
     └─ refactor-settings  (Sonnet, ✓ PR #6481)
  ```

  `mc list --tree --deep` to expand grandchildren by default (off
  by default — parents typically only care about their direct
  reports).
- **Budget propagation.** Parent budget is allocated to children
  with a default reserve (e.g. 80/20 split: 80 % to children equally,
  20 % held by parent). Mid-agents wanting to fan-out further must
  request a sub-budget back through `mc spawn --request-budget`.
- **Status bubble-up.** Children push state to mid-agent;
  mid-agent aggregates and pushes a *summary* to grandparent
  (e.g. "refactor-auth: 2/3 done, 1 failed (recovering)"). The
  parent does not see grandchild noise by default.
- **Failure policy per level.** Mid-agent receives default recovery
  for its children (re-run once, then skip; or fail-fast — see §10g).
  The parent only intervenes if the mid-agent fully fails.

#### 10c. Ensemble — multi-model vote / synthesis / debate

```
mc ensemble "<task>" --models claude-opus,gpt-5-mini,gemini-2.5-pro \
                    --strategy synthesize    # default
                                | judge      # cheap judge picks best
                                | debate --rounds 2
                                | unanimous-only
                    [--budget $0.50]
                    [--judge-model claude-haiku]
                    [--synthesize-model claude-haiku]
```

All N models receive the same task simultaneously. Strategies:

- **synthesize** (default): a separate "synthesis" model reads all
  N answers and produces a unified response, keeping insights
  unique to each source. Bias warning: synthesis-model has its own
  bias — use a *peer-quality* synthesis model when stakes are
  high, not necessarily the cheapest one.
- **judge**: a cheap model picks the best answer based on
  task-specific rubric (default: "most actionable + most likely
  correct given the codebase context"). Returns the winner verbatim,
  not a remix.
- **debate**: each model sees the others' first-round answers,
  produces an updated answer. Repeat N rounds. Final round is
  presented as-is (no synthesis). Useful when models disagree on
  facts — convergence is informative.
- **unanimous-only**: returns the answer only if all N agree on
  the core recommendation (heuristic: structural similarity in
  diff suggestions, or LLM-judged equivalence). Otherwise returns
  "no consensus" with all N answers shown. Conservative — use for
  high-stakes decisions like schema changes.

Use cases:

- Hard debugging problems where one model gets stuck
- Code review of risky diffs (3 models inspecting the same PR)
- Design decisions where models have different strengths (Claude
  on reasoning, GPT on idiomatic JS, Gemini on long-context recall
  of the codebase)
- Final "do you trust this fix" pass before merge

Output card in chat shows per-model: latency, cost, one-line
summary, plus the synthesis/winner. Full answers expand on click.

#### 10d. Verification step — adversarial check after "done"

Not parallel — *serial after*. When an agent claims completion:

```
mc verify <session-id> [--model claude-opus]
                       [--against "<assertion>"]
                       [--rerun-on-fail]
```

The verifier agent receives:

- The session's diff (the PR contents)
- The original task prompt
- Read-only access to the sandbox to run tests, build, lint
- Read-only access to the relevant code paths
- **Explicit prohibition on writing code** — the verifier can only
  observe and report

Verdict: `VERIFIED` | `FAILED` | `INCONCLUSIVE` with evidence
(test output, log excerpts, specific assertions). On `FAILED` and
`--rerun-on-fail`, the original session is re-spawned with the
verifier's findings appended as additional context (a "your
previous attempt missed X, fix and rerun" prompt).

Cost-of-Opus for the verifier is almost always justified — the
task that needed verifying was usually larger than a quick read.

A heuristic mc surface: **whenever a session opens a PR claiming
completion, automatically queue a verifier in the background.**
Default off (cost), but enable per-session via `mc spawn --verify`.

#### 10e. Common orchestration registry

The mc session registry (currently `worktree path → branch →
session id`) extends with orchestration metadata:

- `parent_id` — for tree linkage
- `kind`: `work | fanout-leader | fanout-phase | mid-agent |
  ensemble-member | ensemble-judge | ensemble-synth | verifier`
- `ensemble_group_id` — siblings of an ensemble
- `result_branch` — where the agent landed work
- `result_pr` — PR number when opened (cached, with 15-min TTL)
- `result_status`: `running | completed | failed | verified |
  rejected-by-verifier`
- `budget_alloc` / `budget_used` — per the propagation rules

This is the same registry §2 already uses for `mc list`; just
more columns.

#### 10f. Result reporting protocol

Each agent terminates by writing a structured `result.json` to
its sandbox (path: `/workspace/.mc-result.json`):

```json
{
  "status": "completed | failed | inconclusive",
  "summary": "Added null guard, all tests pass",
  "pr": "https://github.com/.../pull/6478",
  "branch": "fan/auth/oauth-flow",
  "tokens_used": 45000,
  "tools_called": 23,
  "cost_estimate_usd": 0.07,
  "verifier_hint": "Test the OAuth callback specifically",
  "failures_to_report": []
}
```

The parent's push handler reads this on `mc_agent_done` events
and updates the orchestration card. **The result file is the
contract** — without it, an agent claiming completion is treated
as inconclusive (and verifier fires automatically if the parent
opted into auto-verify).

#### 10g. Failure + budget policies

**Failure defaults** (configurable per fan-out / spawn):

- Single agent fails → **surface to parent**, parent decides
  (retry / skip / abandon).
- Fan-out: by default, *continue* the other phases (don't
  cancel siblings on one failure). Parent gets a card showing
  the dead phase and a one-click "retry with these adjustments"
  prompt.
- Hierarchical: mid-agent's default is **one retry then skip**;
  fail-fast available via `--on-fail abort`.
- Ensemble: failed members are dropped from synthesis;
  unanimous-only with any failure returns "no consensus".
- Verifier: failed verification respawns the original session
  with findings if `--rerun-on-fail`; otherwise just reports.

**Budget policies:**

- All commands accept `--budget $X` as a total cap including
  children + verifier passes.
- `mc fanout` divides budget across phases proportional to phase
  size (heuristic: word count of phase body) with a 10 % parent
  reserve.
- `mc ensemble` divides budget equally across members, with a
  separate `--judge-budget` / `--synthesize-budget` for the
  aggregation step.
- A child hitting its budget cap pauses and asks the parent for
  more (push event: `budget_request`). Parent can approve
  inline or auto-approve up to a configurable multiplier.

#### 10h. Cost guardrails (non-negotiable)

Multi-agent operations multiply LLM costs in non-obvious ways.
mc surfaces this proactively:

- **Up-front estimate.** Before fanout/ensemble runs, mc prints
  estimated cost based on phase sizes × model rates × number of
  agents. Refuses to start if `--budget` is below the estimate,
  unless `--force`.
- **Live cost meter.** `mc list --tree --cost` shows running
  cost per agent. Parent card in chat shows aggregate.
- **Per-user monthly soft caps.** Configurable. Hard cap not
  imposed by default (the user is the one paying), but warning
  card at 80 % of cap.
- **Ensemble special warning.** N-way ensemble with frontier
  models prints an explicit "this is N × normal cost" prompt
  before first run in a session.

#### 10i. UI surfaces

- **CLI:** `mc list --tree`, `mc list --tree --cost`, per-pattern
  status commands (`mc fanout status <plan>`, `mc ensemble
  show <id>`).
- **Chat:** the existing `chat-coordinator-coding.md` status-card
  pattern, extended:
  - Fan-out card: progress bar per phase, links to PRs as they
    open, "gather" button when all done.
  - Ensemble card: row per model with latency + cost + one-line
    summary; synthesis/winner expanded.
  - Verifier card: VERDICT badge with evidence excerpt; click to
    see full report.
  - Tree card: collapsible hierarchy, click any node to drill
    into that sub-session's card.
- **Browser terminal (§8):** each agent in the tree is a tab,
  with the orchestration card pinned as a separate "overview"
  tab.

#### 10j. Phasing

1. **MVP** — `mc fanout` over a flat plan (no hierarchy yet),
   plus `mc gather`. Parent stays responsive while children
   work. *Goal: prove "ship a plan as N PRs in parallel" path.*
   ~1.5 weeks solo.
2. **Verifier** — `mc verify` and `mc spawn --verify` opt-in
   auto-verify after completion. *Goal: trust agent claims.*
   ~1 week.
3. **Ensemble** — all four strategies, with cost guardrails
   front-and-centre. *Goal: cover hard debugging + risky-diff
   review.* ~1.5 weeks.
4. **Hierarchical** — recursive spawn with tree visualisation,
   budget propagation, bubble-up status. *Goal: scale to
   refactors that touch multiple sub-areas.* ~2 weeks.
5. **Chat integration polish** — full status-card surface for
   each pattern in Memoro chat (per
   `chat-coordinator-coding.md`). *Goal: the user named pattern
   ships end-to-end.* ~1 week.

Total: ~7 weeks for the full orchestration surface. The MVP
(phase 1 above) alone delivers the user's stated "plan-driven
parallel agents" use case and is the de-risk point.

#### 10k. Open questions specific to orchestration

- **Plan format.** Markdown phase parsing is brittle (heading
  conventions vary). YAML frontmatter declaring `phases:` is
  more robust but less natural to write. Probably: support both,
  prefer YAML when present, fall back to heading-based parse.
- **Cross-phase context.** Should each phase agent see the
  *other* phases' bodies as context? Pro: prevents contradictions.
  Con: 4× context cost, may dilute focus. Lean: by default
  share only the plan intro + their own phase; opt-in
  `--share-siblings` for tightly-coupled plans.
- **Conflict detection in `mc gather`.** Simple: diff overlap
  on file:line ranges. Sophisticated: semantic conflicts (one
  phase removes an import, another uses it). MVP does file:line;
  upgrade later.
- **Ensemble determinism.** Same inputs, different models — runs
  aren't deterministic across providers. Should we cache the
  ensemble result for replay? Probably yes for cost reasons;
  cache key = task hash + model set + strategy.
- **When does an ensemble "trigger automatically"?** The user
  hinted at "verkar svårlöst" — a session retrying the same file
  >3 times. Should mc proactively suggest `mc ensemble`? Probably
  yes via a soft prompt: "I've been stuck on this for 3 retries
  — want me to ensemble against gpt-5-mini and gemini?".

## Open questions

- **Cross-machine session handling.** Today's `mc sessions list` shows
  sessions from multiple hosts. Worktrees are per-machine. Does `mc
  list` show only this-machine worktrees, or merge in remote
  worktrees as informational rows? Probably the former with a
  separate `mc remote list`.
- **Model-switch transcript trimming heuristic.** First-message + last
  N turns is the simple default. Should we offer a summarisation
  pre-pass (let the target tool's cheap model condense the middle)?
- **Bootstrap branch for `mc new` inside an already-checked-out
  branch.** Today cs uses `sess/<name>` regardless. Should `mc new
  <name> --from feature/foo` keep the prefix, or branch off and reuse
  the name?
- **What does `mc switch` do if the target tool isn't installed?** Hard
  fail with install instructions, or warn + dry-run?

## Acceptance check (against the original bar)

`mc` is strictly better than `cs` if all of these hold:

- Every `cs` command has an `mc` equivalent that is at least as fast.
- `mc list` gives information `cs list` doesn't (open question, last
  activity, session live state, transient parent).
- Subagent isolation worktrees no longer leak into the repo.
- Model switching works at least Claude → Codex and back.
- `mc spawn` runs parent + workers on different models with a single
  command per worker; results land in a path the parent can read.
- One command rename (branch + dir), no manual `git branch -m`.
- A `mc list --rich` covers the cross-reference workflow that today
  requires bash + jq + `gh pr view` (per §9a).
- `mc end` recognises squash-merge phantoms without manual
  intervention (per §9b).
- Bulk `mc end a b c` and `mc end --dry-run` available (per §9c).
- `mc list --awaiting / --idle / --safe-to-end` filters available
  (per §9d).
- A user can pass a plan to `mc fanout` and ship N PRs in parallel
  while still planning the next step in the parent session (§10a).
- `mc ensemble "<hard problem>" --models a,b,c` returns a synthesis
  from three models with up-front cost estimate and a budget cap
  (§10c, §10h).
- `mc verify <session>` runs an adversarial check that can re-spawn
  the original session with findings on FAILED (§10d).
- `mc list --tree` shows hierarchical orchestration with per-agent
  status, model, and cost (§10b, §10i).
