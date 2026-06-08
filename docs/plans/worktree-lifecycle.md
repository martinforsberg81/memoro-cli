# mc — the AI-agent orchestration substrate

**Status:** proposed • 2026-05-25 (mission-first reframe 2026-06-02)

## Mission (north star)

memoro-cli (`mc`) exists to make **one human able to orchestrate a fleet
of AI coding agents** — across any tool (Claude Code, Codex, Cursor,
Gemini…), model, repo, user, and machine — from a single **high-altitude
coordinator session**. That overarching session is not a way of working
*in* this repo; it **is the product** mc builds.

The bottleneck in AI-assisted coding is not model coding ability — it is
the human's capacity to direct many agents while keeping critical
oversight. mc removes that bottleneck: intent is externalised into
per-agent briefs (the brief is the quality mechanism), the coordinator's
context is kept clean (it stays high-altitude), work is verified before
merge, nothing leaks, and — via **Memoro** — nothing is forgotten.

**Memoro** is the user's personal knowledge base. mc is the on-machine
bridge to it, and the two form a **bidirectional loop**: sessions emit
observations (decisions, loose-ends, practices) *into* Memoro; Memoro
feeds **user_state context** (a personal "lens") *back into* sessions —
so orchestration is not just parallel, it is **personalised**, and the
user's own development is a first-class goal. (Memoro-side detail lives in
the memoro repo; mc owns the bridge — see §15 + §16.)

The sections below were written origin-first (mc subsuming `cs`). Read
§ Motivation as the **first milestone**, not the goal — the goal is the
mission above, and every section serves it.

## Motivation (origin — the first milestone)

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

**Update 2026-06-07:** the build-ready model for this section lives in
`docs/plans/hosted-live-session-workspace.md`. The important refinement:
this is a hosted live-session workspace, not a prompt router and not a cloud
shell. The cloud exposes only a constrained `mc` orchestration surface; `attach`
is a real live PTY viewport into a local `mc broker` session.

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
   tmux. One broker per machine; auto-starts when normal session commands need
   it (`mc new`, `mc resume`, `mc attach`, and `mc broker connect`).
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

#### 10s. The spine: fanout → verify → gather (priority order, added 2026-06-02)

Of the patterns in this section, three form the **core loop** that makes
the mission real end-to-end — the spine. The rest (ensemble §10c,
hierarchy §10b) are *enhancements* layered on it, not peers:

```
mc fanout <plan>  →  agents execute (one PR/phase)  →  mc verify  →  mc gather
   stage phases         the build                       the gate       merge
```

Build-priority order and the gaps between "shipped" and "works":

1. **fanout** stages phases (worktrees + briefs) — **shipped (PR #60),
   but it only STAGES; it does not yet run the agents** (sessions land
   `no-session-yet`). Wiring execution is the first spine step.
   *(gap — not yet an explicit plan step)*
2. **mc verify** — the adversarial trust gate before merge — **not
   built** (§10d; Phase 2 of the 10j phasing).
3. **mc gather** — **shipped**, but does **not yet respect the verifier
   verdict**; it must refuse to merge `rejected-by-verifier` phases per
   the §10e registry contract. *(gap)*

`mc spawn` (§5b — heterogeneous *single* subagent) is **not built**; the
spine does not require it. Heterogeneous models per worker (Goal 5) and
cost guardrails (§10h) are the depth pass *after* the spine works.
Everything from 10a onward is the detail of these primitives.

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

#### 10i.1. Relationship with the host TUI's agent rendering

Claude Code (and similar TUIs) already render parallel-agent
lifecycles natively when the model invokes their `Agent` tool —
folded status lines per agent, live progress, expand-on-click.
Example from a Claude Code session:

```
2 agents finished (ctrl+o to expand)
   ├ Architecture grounding review · 81 tool uses · 76.2k tokens
   └ Operational risk + rollout review · 6 tool uses · 35.7k tokens
```

That rendering is **owned by the host TUI**, not by mc. mc cannot
modify it, inject elements into it, or reach across the boundary.
It can only choose whether to compete with it or piggyback.

Three scenarios with three different surfaces:

**A. `mc spawn` invoked from inside a host TUI session.** Three
implementation options, ranked by ergonomic match:

1. **Piggyback via the host's Agent tool.** The parent model
   invokes `Agent`, gets native fold-summary + expand. *But*
   blocked today because no TUI exposes its Agent tool to
   external CLIs — `mc spawn` from a Bash invocation can't
   trigger Claude Code's Agent rendering. Possibly addressed by
   future TUI APIs; not a v1 dependency.
2. **mc's own rendering, side-channel.** mc writes its own live
   status to a known location (top-of-pane via ANSI escape, or
   a bottom status line, or a separate terminal pane via
   `tmux`/`screen` split). Owns full control of cost/budget/
   model-chain display the host TUI doesn't know about. Doesn't
   compete visually with the host's chat area.
3. **Hybrid.** When invoked from a host TUI we can detect (env
   var sniff or PTY check), prefer option 2 but match the
   host's visual language so the two surfaces feel coherent.
   When invoked outside a host TUI, go full-screen (§10i CLI).

Default for v1: option 2 with a copy of Claude Code's visual
grammar (`└─`, `▶`, `✓`, monospace progress lines). Detect host
TUI via `process.env.CLAUDE_CODE_SESSION` (or whatever the host
exposes) and adjust placement only.

**B. `mc fanout` from a plain terminal (no host TUI).** mc owns
the entire display. Render per §10i's CLI section — `mc list
--tree` is the canonical format. Live updates via ANSI
overwrite.

**C. Memoro browser-terminal (§8) or chat status-cards
(`chat-coordinator-coding.md`).** mc emits push events to the
Memoro session DO; the browser / chat renders. xterm.js for
PTY streams, React-style status cards for the orchestration
tree. We own the entire stack here.

Design principle: **never ship a half-rendering of the host
TUI's territory.** If we can't render as well as the host
inside its window, we render *adjacent* (status line, separate
pane) and let the host own its area. The worst outcome is a
mediocre mc UI competing with a polished host UI in the same
visual space.

**Detection mechanics** (for §10 implementation):

- `process.env.CLAUDE_CODE_SESSION` (or equivalent) → host TUI
  present → use side-channel placement
- `process.stdout.isTTY === false` → script / pipe → emit
  machine-readable status (`--json`-equivalent stdout) and skip
  ANSI altogether
- `process.env.MEMORO_CHAT_SESSION` (future) → emit push events
  to the DO instead of rendering locally
- Otherwise → full-screen mc-owned terminal rendering

**Tests should cover all four detection branches** so
detection changes don't silently degrade one surface while
fixing another. The CI matrix is small (env-var permutations)
but valuable.

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

### 11. Onboarding — first-run path for new users

§2 + §9 assume mc is already authenticated and the user knows where
to point it. For an early-adopter friend or a fresh machine, that's a
silent friction wall. The onboarding surface makes the first 10
minutes obvious: log in to Memoro, verify LLM tools, install the
shell wrapper, ready to `mc new`.

Non-goal: re-implementing each tool's auth. Claude Code, Codex CLI,
and Gemini CLI each own their own login flows. mc orchestrates
*around* them — points at the right install command, runs the right
verification, never stores third-party tokens.

#### 11a. `mc auth status` — single-screen health check

```
mc auth status
```

Output:

```
Memoro account:
  ✓ Authenticated as martinforsberg@me.com
  Token expires: 2026-08-15

LLM tools on this machine:
  ✓ claude        2.1.152      authenticated (Claude Max)
  ✗ codex         not installed
  ✗ gemini        not installed

Shell wrapper:
  ✓ Installed in ~/.zshrc, active in this shell

Workspace:
  ✓ MC_HOME = ~/.memoro/mc
  ✓ Registry has 0 sessions, 14 cs-managed worktrees (unmanaged)
```

`mc auth status --json` for scripting. Designed to be the **single
command** to answer "is mc ready to use here?".

Detection rules per tool (adapter responsibility — `src/adapters/<tool>.js`
exports `getStatus({ binPath?: string })`):

- `which <bin>` — installed? Bail with install hint if not.
- `<bin> --version` — version capture, error if it fails.
- Tool-specific auth probe — for Claude, a quick `claude --help` plus
  reading `~/.claude/config.json` if present; for Codex, similar; for
  Gemini, the SDK's status command.

The probe must never spawn an interactive TUI — `mc auth status`
should complete in <500ms.

#### 11b. `mc setup` — interactive first-run wizard

```
mc setup [--non-interactive]
```

Walks the user through onboarding in order:

1. **Memoro account.**
   - If keychain has a token, validate it (HEAD `/api/me`); skip if OK.
   - Else: open browser at `meetmemoro.app/login?source=mc-setup&device=<hostname>`
     and poll for token via the existing `memoro-cli login` flow.
2. **Primary LLM tool.**
   - Default: Claude Code.
   - Detect installation; if missing, print exact install command
     (`npm install -g @anthropic-ai/claude-code` or equivalent) and
     wait for retry.
   - Verify auth by running `claude --help` and inspecting
     `~/.claude/config.json` for an active subscription.
3. **Optional secondary tools.** Yes/no prompts for Codex / Gemini.
   Same install + verify pattern.
4. **Shell wrapper.** Run `mc install-shell` (idempotent).
5. **Verification.** Run `mc auth status` and show its output.

Each step is independently re-runnable — `mc setup` resumes from the
first unticked checkbox so the user can quit and come back.

`--non-interactive` mode skips browser flows and prompts; useful for
CI / scripted bootstraps. Fails on first missing dependency with
exit code and machine-readable error.

#### 11c. `mc auth memoro` and `mc auth <tool>` — per-target helpers

```
mc auth memoro              # explicit Memoro login (alias for `memoro-cli login`)
mc auth memoro --logout
mc auth claude              # verify Claude Code; print fix hint if broken
mc auth codex
mc auth gemini
```

Lets users re-auth one piece without re-running the full wizard.
Each subcommand has `--status` to print just that target's section
from `mc auth status`.

#### 11d. First-run friendliness in existing commands

Today `mc new` and `mc list` assume auth is in place; they fail with
opaque errors otherwise. Wrap each command's first call with a
"have we run setup?" check:

- If the registry hasn't been touched and Memoro keychain is empty,
  print: *"Looks like a fresh install. Run `mc setup` to get
  started, or `mc setup --help` for the long version."* and exit 1.
- Once setup has been completed once (sentinel file at
  `${MC_HOME}/.setup-done`), commands skip the check.

#### 11e. README + docs/onboarding.md

The README's current "Requirements" section assumes the reader is
already running multiple LLM CLIs. Replace with:

1. One-liner install of mc itself.
2. `mc setup` — single command bootstrap.
3. First-day flow: `mc new my-experiment` → claude opens → work →
   `/exit` → `mc end my-experiment`.

A separate `docs/onboarding.md` covers the long story (per-tool
install commands, Memoro account creation, shell-wrapper quirks per
zsh/bash/fish, machine identity for multi-machine users).

#### 11f. Decided

- **`mc setup` does not auto-install Claude Code.** Surprise
  npm-installs from a verb named "setup" are hostile — users expect
  setup to *configure*, not to mutate global packages. Setup prints
  the exact install command (`npm install -g
  @anthropic-ai/claude-code`) and leaves the run to the human. Same
  policy for Codex / Gemini. (Decided 2026-05-28 with drev 2.)

- **`mc setup` is non-interactive.** No prompts, no `--non-interactive`
  flag (that would be redundant). The verb is: read auth status,
  print only the missing steps with exact commands, write the
  `${MC_HOME}/.setup-done-v1` sentinel when everything is green.
  Idempotent + self-verifying. (Decided 2026-05-28 with drev 2.)

#### 11f.5. Deferred from drev 2

- **`mc reconcile` category 3 — file-overlap heuristic.** The plan §9e
  third category ("sessions whose dirty files match files modified by
  a recently-merged PR") is deferred. It would need a stable
  dirty-file capture per session plus a PR-file-diff fetcher; both
  are doable but the false-positive cost is real. Drev 2 ships
  categories 1 + 2 only — squash-phantoms and PR look-ups by branch
  match + transcript mention. Revisit in v2.

#### 11g. Open onboarding-specific questions

- **Token format and rotation.** Memoro tokens currently live in
  keychain under `ACCOUNTS.TOKEN`. Multi-machine users today log in
  separately on each. Should `mc setup` offer a QR code or short
  code link from an already-authed machine ("trust this machine
  from your phone")? Probably not in v1 — defer.
- **Should `mc setup` install Claude Code automatically?** npm
  installs surprise users. Default: detect-and-instruct only;
  `mc setup --install-tools` opts in to running the installer.
- **Fish shell support in `mc install-shell`.** Currently zsh/bash
  only. Fish users get a clear "unsupported, paste this manually"
  message. Promote to first-class when first fish user asks.
- **What about Windows / WSL?** Out of scope for v1 onboarding; the
  whole mc stack assumes POSIX shells today.

### 12. Token vault — provider-independent secret management

The recurring real-world failure that motivates this section: the
user has had to figure out, multiple times, that an LLM running
inside a coding tool (Claude Code, Codex CLI) ended up *reading a
token in cleartext* via Read / Bash. Once a token enters model
context, it's gone — logs, training corpora, provider servers,
potentially leaked. Existing `block-secret-reads.sh` catches
known-shaped paths (`.env`, `.zshrc`, `~/.aws/credentials`, etc.)
but the regex misses anything novel.

The vision: log into mc once, all your tokens available on every
machine, change in one place propagates everywhere, **and the LLM
never sees a single byte of cleartext**.

The insight that makes this tractable: **the tool needs the token,
the model doesn't.** Claude Code reads `~/.claude/.credentials.json`
to authenticate against Anthropic. The *model* running inside
Claude Code never needs that file — only the tool process does.
mc's job is to materialise tokens where the tool expects them,
block model reads of those paths, and shred on session end.

#### 12a. Why this is a high-priority section

- **Stops a concrete, repeating leak vector.** The user has lost
  tokens this way more than once. Every leaked token is a rotation
  cost minimum, a credential-compromise risk maximum.
- **Differentiator for "Memoro for coders".** Other secret
  managers (1Password CLI, Doppler, Infisical, HashiCorp Vault)
  are not designed for the LLM-blindness hot path. They store
  ciphertext at rest, materialise plaintext for the *app*, and
  trust the app's host process. None install hooks that block the
  app's children. mc is unique here.
- **Cross-machine UX is the multi-device pitch.** "Open mc on a
  fresh machine, all your tokens are there" is the polish that
  makes mc feel like a managed product rather than a CLI tool.

#### 12b. Existing Memoro vault infrastructure (what we leverage)

Memoro already ships a **production zero-knowledge vault**. Phase 1
of this section is mostly a port + JIT layer, not net-new
cryptography:

| Component | Lives at | What it gives us |
|---|---|---|
| Schema | `~/memoro/migrations/0027_vault.sql` | `vault_config` + `vault_secrets` tables, per-user encrypted blob storage with arbitrary `secret_type` |
| Server crypto | `~/memoro/src/crypto/vault-crypto.js` | auth-hash verification, salt generation, hash-of-hash storage so DB leak ≠ auth-hash leak |
| Server API | `~/memoro/src/routes/vault/index.js` | `/api/vault/setup`, `/unlock`, `/lock`, `/status`, `/secrets` (GET/POST/PUT/DELETE), `/change-password`, `DELETE /api/vault` |
| Client crypto | `~/memoro/public/js/crypto/vault-client-crypto.js` | PBKDF2 600k → 512-bit key split (vault-key + auth-key), AES-GCM encrypt/decrypt, in-memory key cache with 15-min TTL |
| Client API | `~/memoro/public/js/api/vault.js` | Browser wrapper around server endpoints |
| UI | `~/memoro/public/js/ui/canvas/embedded/Vault.js` | Canvas-embedded vault view; today shows passwords |
| Autofill | `~/memoro/public/js/vault/autofill.js` | Filters by `secret_type === 'password'`; pattern reusable for `'api_token'` |

The cryptographic design (zero-knowledge, vault-key never leaves
the client, hash-of-hash on the server, PBKDF2 600k, AES-GCM,
per-secret IVs, rate-limited unlock with 15-min session TTL) is
already battle-tested and used in production for passwords. mc
inherits it wholesale.

#### 12c. mc vault commands

```
mc vault setup
   Create vault for this Memoro account (prompts for master password).
   Generates salt server-side via /api/vault/setup; derives keys
   client-side; stores hash(authHash) on server.

mc vault unlock
   Prompts for master password, derives keys, validates against
   /api/vault/unlock, caches vault-key in OS keychain with 15-min
   TTL so subsequent mc commands don't re-prompt.

mc vault lock
   Clears the keychain-cached vault-key and notifies the server
   (calls /api/vault/lock).

mc vault status [--json]
   Shows: vault setup yes/no, locked/unlocked, time until
   auto-lock, number of secrets stored.

mc vault list [--type api_token|password|...] [--json]
   Lists secret labels (decrypted client-side). Never echoes
   secret values to stdout.

mc vault get <label> [--field token|account|...] [--json]
   Decrypts and prints a single secret's data. Hard prompt:
   "About to print a secret to your terminal. Continue?" unless
   --no-confirm. Used rarely — JIT materialisation (§12d) is the
   preferred read path.

mc vault set <provider> [--account x] [--label y]
   Interactive prompt for the token value (or read from --stdin).
   Encrypts client-side, POSTs ciphertext + IV to
   /api/vault/secrets. `secret_type='api_token'` with structured
   metadata (provider, account, scopes, expires_at).

mc vault rm <label>
   DELETE /api/vault/secrets/:id after confirm.

mc vault rotate <label>
   Sets new value, keeps old as `<label>-prev` for 24h then
   auto-purges. Lets the user verify the new token works before
   losing the old.

mc vault change-password
   Re-encrypts auth-hash with new master; all stored secrets
   stay encrypted with the same vault-key (the design lets us
   rotate the auth-hash without re-encrypting every blob —
   coordinator-spec read of vault-client-crypto.js says this is
   possible; verify during implementation).
```

#### 12d. JIT materialisation protocol

Extends the §11a adapter contract with two methods per tool:

```js
// src/adapters/<tool>.js — added in this section
export function tokenLocations() {
  return [
    { type: 'file', path: '~/.claude/.credentials.json', format: 'json', shape: 'anthropic-credentials-v1' },
    { type: 'env',  name: 'ANTHROPIC_API_KEY' },
  ];
}
export async function materializeToken({ token, location, sessionId }) { /* write or set env */ }
export async function shredToken({ location, sessionId }) { /* unlink or unset */ }
```

Lifecycle:

1. `mc new` / `mc resume` resolves "which token(s) for which adapter(s)" via session metadata
2. Pulls decrypted tokens from vault (vault-key cached in keychain)
3. Calls `materializeToken()` per adapter
4. Installs PreToolUse hook (§12e) covering each materialised path
5. Launches the tool
6. On `mc end` / session termination: uninstalls hook, calls `shredToken()` per adapter

**Invariant: a token is in cleartext on disk only for the
lifetime of the session that needs it.** Never longer. Never
elsewhere. mc owns the lifecycle.

#### 12e. PreToolUse hook integration

A dynamic hook (in contrast to the static-regex
`block-secret-reads.sh`) installed per session:

```
~/.memoro/mc/hooks/active/<session-id>-vault-block.sh
```

The hook reads `~/.memoro/mc/state/<session-id>-paths.json`
(written by `materializeToken()`) and denies any Read/Bash that
targets one of those paths. Auto-installed at session start,
auto-removed at session end. The user's existing
`block-secret-reads.sh` stays as a fallback for paths mc didn't
know to register.

The hook activation mechanism uses Claude Code's per-session
hook-install (or whatever the host TUI exposes). Verified
detection per §10i.1 — if the host doesn't support session-scoped
hooks, fall back to user-global hook with a session-token check.

#### 12f. OS-keychain session cache

After `mc vault unlock`, the vault-key is held in OS keychain
under `mc-vault:<user-id>:active-key`, scoped to expire 15 min
after the last `mc <verb>` call. Each mc command:

1. Checks keychain for active-key
2. If present and not expired: use it, touch its TTL
3. If expired: prompt for master password (silent if `MC_VAULT_PASSPHRASE` env set, for CI)
4. If absent: error with hint to run `mc vault unlock`

Why OS keychain rather than process memory: mc commands are
short-lived. Each `mc list` / `mc new` is a fresh process. Without
keychain caching, every command would prompt for the master
password. Keychain TTL gives us the same in-memory-with-timeout
UX without coupling to a long-running daemon.

#### 12g. `.env` triage at session start (optional, v1.5)

A separate flow that scans `.env` files in the target worktree
on `mc new`, asks the user once per file ("which of these are
secrets vs config?"), then:

- **Secrets**: imported into vault under `env:<repo>:<key>`,
  removed from materialised `.env`
- **Config**: kept in `.env` as-is

The session sees a `.env` with only config; secrets that the
project genuinely needs (DATABASE_URL, OPENAI_API_KEY for prod
code that calls OpenAI) are materialised separately into env or
files the LLM hook blocks.

Deferred to v1.5 — phase 1 ships without this; manual `mc vault
set` covers the use case until the UX is worth it.

#### 12h. Multi-account / per-session selection

Session metadata in the registry (§2 + §10e extension) carries
an optional `vault_account` field. `mc new mc-thing --account work`
sets it; subsequent `mc resume mc-thing` uses the same account
without re-specifying.

Lookup precedence for "which token to materialise":

1. Session's `vault_account` field, if set
2. Repo-level default at `${repo}/.mc/vault.json` (gitignored)
3. User-level default at `${MC_HOME}/vault-defaults.json`
4. First account found of the right provider, with warning

#### 12i. CI / non-interactive token loading

For CI: `MC_VAULT_PASSPHRASE` env unlocks without prompt;
session loads tokens as usual. mc never echoes the passphrase or
any token to stdout/stderr. Designed-in: tests under
`tests/mc/vault/` assert no token bytes appear in subprocess
captured output across the lifecycle.

Alternative for stricter CI: `MC_VAULT_BYPASS=1` + per-token
envs (`MC_VAULT_TOKEN_ANTHROPIC=...`) skips the vault entirely
and loads from env. Both supported; `MC_VAULT_BYPASS` is for
"my CI already has secrets via the platform's own secret store
and I don't want to introduce vault here".

#### 12j. Cryptographic review scope

We are **not** designing new cryptography in this section.
Phase 1 ports an existing battle-tested client to Node. Phase 2
adds session-cache + hook integration. Review scope:

- **Port verification**: confirm `crypto.subtle` in Node 22 produces
  byte-identical outputs vs the browser implementation for the
  same inputs (especially PBKDF2 + AES-GCM). Implementation test:
  encrypt a fixed plaintext+IV+key in both, assert ciphertexts
  match.
- **Keychain cache risk**: holding the vault-key in OS keychain for
  15 min is a tradeoff against re-prompt-every-command friction.
  Risk surface: anything that can read the keychain (TouchID-
  protected on macOS, password-protected on Linux Secret Service).
  Document the tradeoff, offer `--no-cache` for paranoid mode.
- **Hook bypass risk**: a malicious or buggy LLM could try to
  bypass the PreToolUse hook (e.g., by spawning a process the
  hook doesn't intercept). Mitigation: hook covers Read and Bash;
  shell out via Bash is the primary vector and is covered. Other
  vectors (network exfiltration of env, prompt-injection-driven
  leaks via response text) are *not* covered — flag in user-facing
  docs.

External review recommended for phase 2 (hook integration). Phase
1 (port) is review-light because the design is unchanged.

#### 12k. Phasing

1. **Phase 1 — mc vault client + basic CRUD (~1 week solo).**
   Port `vault-client-crypto.js` to Node. `mc vault setup /
   unlock / list / get / set / rm / status`. Talks to existing
   `/api/vault/*` endpoints. No JIT, no hook, no keychain cache
   yet — every command prompts for master password. Validates
   the port; useful standalone for "I just want to manage
   secrets across machines".

2. **Phase 2 — OS-keychain cache + JIT materialisation
   (~1 week).** Vault-key cached in keychain with 15-min TTL.
   Adapter contract gains `tokenLocations()` /
   `materializeToken()` / `shredToken()`. `mc new` /
   `mc resume` pull and materialise; `mc end` shreds.
   *Without* the hook yet — the LLM-safety story is incomplete
   but the multi-machine token-sync story is done.

3. **Phase 3 — PreToolUse hook integration (~1 week).** Dynamic
   per-session hook that reads mc-known paths. Auto-install on
   session start, auto-remove on end. Tests assert hook
   actually blocks. This closes the LLM-blindness invariant.

4. **Phase 4 — Multi-account + .env triage + audit log (~1
   week).** Polish: per-session account selection, `.env`
   scanning + redaction, structured audit log of who-read-what-
   when at `${MC_HOME}/vault-audit.log`.

5. **Phase 5 — `mc auth status` integration (~2 days).** The
   `auth status` surface from §11a learns about the vault:
   shows "Vault: unlocked (4 secrets, 13 min until lock)" or
   "Vault: locked — run mc vault unlock". Stays out of every
   other mc command (no surprise prompts).

Total: ~4 weeks solo for the whole vision. Phase 1 alone
delivers cross-machine secret-sync standalone (no LLM context
needed); phase 3 delivers the LLM-blindness invariant; phases
4–5 are polish.

#### 12l. Acceptance check

- A user can run `mc vault set anthropic` once on machine A,
  `mc vault list` on machine B (after `mc vault unlock`), and see
  the same secret.
- Starting a session via `mc new` materialises the right token
  for the right tool without the user typing it.
- Running `cat ~/.claude/.credentials.json` inside the session
  (via the Bash tool the LLM uses) returns a hook denial — not
  the cleartext.
- `mc end` removes the materialised file; checking the path
  after end returns "no such file".
- Master password change via `mc vault change-password` rotates
  the auth-hash; all stored secrets stay decryptable with the
  same vault-key (verify with `mc vault list` succeeding
  after change).
- CI mode: `MC_VAULT_PASSPHRASE=... mc new ci-job --no-launch`
  succeeds without prompts.
- Tests verify: no token bytes appear in subprocess-captured
  stdout/stderr across any tested code path.

#### 12m. Open questions specific to the vault

- **Master password recovery.** Currently no recovery: lose the
  master, lose the vault (the cryptography won't let it be
  otherwise without a backdoor). UX must be glass-clear at
  setup. Consider: optional encrypted backup blob the user
  prints + stores physically? Defer to v2 design.
- **Vault sync across mc instances on the same machine.** Two
  shells, two `mc` invocations, both want the vault-key. First
  one prompts, second one finds it in keychain. Race condition
  during the prompt? Probably mutex via keychain itself; verify
  during implementation.
- **Secret-type schema evolution.** Today `secret_type` is free
  text. mc introduces `api_token`, `oauth_token`. Should mc
  publish a typed schema (JSON Schema?) for each so other clients
  reading the vault know the data shape? Probably yes; lands
  in phase 2.
- **Hook bypass for legitimate cases.** What if the user
  *intentionally* wants to debug their materialised token (run
  `cat ~/.claude/.credentials.json` themselves outside the LLM)?
  The hook denies that too. Either: a `mc vault inspect <label>`
  command that bypasses, or document that the hook is
  session-scoped and inspect-from-outside-the-worktree always
  works. Lean: latter.
- **What happens when the vault server is down.** Phase 2's
  keychain cache provides 15-min offline tolerance, but a longer
  outage means new sessions can't unlock fresh tokens. Document
  + acceptable for v1; offline-first re-design is phase-6
  territory.

### 13. Tool-portability — instructions, hooks, commands per adapter

Switching from Claude Code to Codex / GPT / Cursor / Aider /
future tools must not strand the user. Today the project's
operating instructions, agent skill, slash command, and hooks
all live under Claude-Code-specific conventions
(`CLAUDE.md`, `.claude/skills/`, `.claude/commands/`,
`.claude/hooks/`). Other tools read different files:

| Tool | Native instructions | Skills / scripts | Hooks |
|---|---|---|---|
| Claude Code | `CLAUDE.md` | `.claude/skills/*.md` + `.claude/commands/*.md` | `.claude/hooks/*.sh` + `.claude/settings.json` |
| Codex / GPT | `AGENTS.md` (per agents.md spec) | markdown read manually | tool-specific (TBD per Codex release) |
| Cursor | `.cursor/rules/*.mdc` | none | none |
| Aider | `CONVENTIONS.md` | none | repo-level config |
| Future | TBD | TBD | TBD |

The phase-1 step (PR #44) added a canonical
`docs/coding-agent-protocol.md` plus thin wrappers (CLAUDE.md +
AGENTS.md). That gets us instruction-file parity manually. §13
specifies the mc-driven mechanism that does the rest
automatically.

#### 13a. Adapter contract extension

Each `src/adapters/<tool>.js` gains four optional methods that
describe the tool's native filesystem footprint for project-level
configuration:

```js
// src/adapters/<tool>.js — added in this section
export function instructionsFile() {
  return { path: 'CLAUDE.md', renderer: 'markdown-wrapper' };
  // or { path: 'AGENTS.md', renderer: 'markdown-wrapper' }
  // or { path: '.cursor/rules/project.mdc', renderer: 'cursor-mdc' }
}

export function commandsDir() {
  return '.claude/commands';  // null for tools without slash commands
}

export function hooksDir() {
  return '.claude/hooks';      // null for tools without hooks
}

export function settingsFile() {
  return '.claude/settings.json';  // null if not applicable
}
```

`renderer` is the format converter — most are markdown-wrapper
(thin file pointing at canonical), but Cursor needs MDC
frontmatter, Aider needs YAML config, etc.

#### 13b. Canonical source layout

All tool-portable content lives in a single place per concern:

```
docs/
  coding-agent-protocol.md           # canonical instructions (active today)
  agent-skills/                      # canonical skill source (planned)
    agent-coordination.md
  agent-commands/                    # canonical command source (planned)
    be-coordinator.md
  agent-hooks/                       # canonical hook source (planned)
    block-secret-reads.sh
```

Today everything still lives under `.claude/` because Claude
Code reads it there directly. §13 introduces the
canonical-source pattern incrementally: new content goes under
`docs/agent-*/`; existing content gets migrated when an adapter
needs it.

#### 13b.1. Two layers of canon — project vs tool-universal (amended 2026-06-02)

The layout above conflates two kinds of canon that have
different *homes* and different *audiences*:

- **Project canon.** This repo's stack, critical paths,
  conventions, and plan (`docs/coding-agent-protocol.md`, this
  file). True only for memoro-cli. Lives in the repo's `docs/`;
  `mc adapter sync` reads it *from the repo* and writes the
  repo's tool-native files. This is what 13b describes.
- **Tool-universal canon.** The orchestrator role and the
  coordinator ↔ agent protocol (`be-coordinator`,
  `agent-coordination`). These describe how to work *with mc* —
  true for every user in every project, regardless of codebase.
  They must NOT be stranded in one repo's `docs/`.

Tool-universal canon **ships inside the mc package** — bundled
with the binary (via `package.json` `files`, alongside `src/`),
so it travels everywhere mc is installed. `mc setup` /
`mc adapter sync` materialise it into the current repo's
tool-native paths *from mc's own bundled copy*, even in a repo
that has never seen these files. That is what makes the
overarching orchestrator session a property of `mc` rather than
of memoro-cli: a developer who installs mc in a fresh project
and runs `mc setup` gets `/be-coordinator` and the coordination
skill because mc shipped them, not because the repo did.

**Merge model.** In any repo, the materialised files =
tool-universal canon (from the package) layered with optional
project overrides (from the repo's `docs/agent-*/`). Project
canon extends or annotates tool canon; it never has to re-state
it. A repo with no overrides still gets the full orchestrator
session.

**Source resolution order** for a given asset, highest priority
first:

1. repo-local override (`docs/agent-commands/<name>.md`, etc.)
2. mc package-shipped universal canon
3. (nothing — asset absent)

This is the only structural change the universal vision
requires; the renderer + sync machinery in 13c is unchanged —
only the *source resolution* gains the package layer. The
distinction also resolves a latent ambiguity in 13b: the
coordination skill + command currently under this repo's
`.claude/` are tool-universal canon living in a project-specific
location. Phase 4 graduates them to the package, not to this
repo's `docs/`.

#### 13c. `mc adapter sync` — materialise per-tool files

```
mc adapter sync [--tool <name>] [--dry-run]
```

For each enabled adapter (per `mc auth status`), copy /
transform canonical sources into the adapter's native paths.
`--dry-run` lists what would change without writing. Run
automatically on `mc setup` and on `mc tool-switch`.

Example output:

```
mc adapter sync --dry-run

Claude Code:
  CLAUDE.md                              up to date
  .claude/skills/agent-coordination.md   up to date
  .claude/commands/be-coordinator.md     up to date

Codex:
  AGENTS.md                              up to date

Cursor:
  .cursor/rules/project.mdc              MISSING — would create
  .cursor/rules/skill-coord.mdc          MISSING — would create
```

Designed so the user can have multiple tools' files coexisting in
one repo — useful for projects with mixed-tool teams.

#### 13d. `mc tool-switch <tool>` — make a different tool the primary

```
mc tool-switch codex
```

What it does:

1. Verifies the target adapter's tool is installed + authed
   (per §11a `getStatus()`)
2. Updates registry: future `mc new` defaults to this tool
3. Runs `mc adapter sync` to make sure target tool's files
   exist
4. Leaves other tools' files intact (they may be co-active)
5. Reports any drift between canonical and per-tool files
   that the user should resolve

Doesn't touch existing sessions — they keep running their
spawned tool. Only affects new `mc new` / `mc resume` invocations.

#### 13e. Hook portability gap

Hooks are the hardest part. Each tool has its own hook syntax:

- Claude Code: `.claude/hooks/*.sh` + `settings.json` with
  PreToolUse / PostToolUse routing
- Codex: TBD per Codex release (likely JSON config)
- Cursor: no hook system today
- Aider: limited; commit-message templates and similar

Phase 1 of §13 ships only the **instructions** portability
(canonical + wrappers). Hook portability deferred until at
least two tools' hook systems are stable enough to design a
common abstraction. Until then, Claude Code is the only tool
with mc-managed hook integration; other tools' users get
docs telling them to install equivalents manually.

#### 13f. Phasing

1. **Phase 1 — Canonical instructions (shipped, PR #44).**
   `docs/coding-agent-protocol.md` exists; CLAUDE.md and
   AGENTS.md wrap it. Manual sync.

2. **Phase 2 — Adapter contract + `mc adapter sync` for
   instructions (~3 days solo).** `instructionsFile()` on the
   three adapters we have today (claude-code, codex, gemini —
   gemini gets a stub). `mc adapter sync` materialises
   wrappers from the canonical. Idempotent; safe to re-run.

3. **Phase 3 — `mc tool-switch <tool>` verb (~2 days).**
   Verifies target adapter health + switches default tool +
   syncs files. Mostly orchestration on top of phase 2.

4. **Phase 4 — Canonical skills + commands (~1 week).**
   Add per-adapter renderers (markdown-wrapper for most; Cursor
   gets MDC frontmatter) and extend `mc adapter sync` to cover
   skills + commands. **Amended (2026-06-02, per 13b.1):** the
   coordination skill + command (`agent-coordination`,
   `be-coordinator`) are *tool-universal* canon — they graduate
   to the **mc package** (bundled, shipped via `package.json`
   `files`), not to this repo's `docs/agent-*/`. `mc adapter
   sync` resolves a requested asset repo-override → package-canon
   → absent (13b.1 resolution order), so any repo — including one
   that has never carried these files — materialises the full
   orchestrator session from mc's own copy. Project-specific
   skills/commands still live in the repo's `docs/agent-*/` and
   layer on top. This is the phase that delivers "mc creates the
   overarching session, repo- and user-agnostic".

5. **Phase 5 — Cursor + Aider adapters (~3 days).** First
   non-Claude tools to land with full canonical-source-driven
   instruction files. Validates the adapter contract on
   tools that don't use agents.md convention.

6. **Phase 6 — Hook portability (deferred).** Re-evaluate
   when at least two tools have stable hook systems worth
   abstracting.

Total: ~3 weeks solo for phases 2–5. Phase 1 is already done.
Phase 6 is open-ended.

#### 13g. Acceptance check

- Running `mc adapter sync` from a fresh clone materialises every
  enabled tool's instruction file from the canonical source.
- Editing `docs/coding-agent-protocol.md` and re-running
  `mc adapter sync` updates all derived files.
- Running `mc tool-switch codex` on a Claude-default project
  switches `mc new`'s default tool without breaking existing
  sessions, and ensures AGENTS.md exists + is fresh.
- A user can clone a memoro-cli-like repo, run `mc setup` with
  Codex as their installed tool, and get AGENTS.md (not
  CLAUDE.md) as the primary on-disk instruction surface —
  with the protocol intact.
- **(amended 2026-06-02)** In a repo that has *never* carried
  coordination files — a fresh project, any language — running
  `mc setup` materialises the orchestrator session
  (`be-coordinator` + `agent-coordination`) from the mc package,
  for any user. Deleting the repo's copy and re-running restores
  it. A repo-local override in `docs/agent-commands/` wins over
  the package copy (13b.1 resolution order).

#### 13h. Open questions

- **Drift handling.** A user edits CLAUDE.md by hand; canonical
  source is now stale. `mc adapter sync` detects drift but does
  it overwrite (canonical wins) or surface a 3-way merge?
  Lean: surface drift, refuse to overwrite without `--force`,
  point user at the canonical to edit instead.
- **Multi-tool teams.** If a team has both Claude and Codex
  users, both CLAUDE.md and AGENTS.md need to coexist. mc
  should handle this transparently (sync both, don't choose).
  Phase 2 default.
- **Cursor's MDC frontmatter.** Each `.cursor/rules/*.mdc`
  file has YAML frontmatter with `description`, `globs`,
  `alwaysApply` fields. Need a renderer that maps canonical
  metadata to these. Defer details to phase 5.
- **What if a future tool wants markdown but in a different
  location?** The adapter declares its path; canonical is
  read-once; renderer is per-adapter. Adding a new tool is
  one adapter file + one entry in the adapter index. Designed
  to be cheap.
- **What about user-level instructions (not project-level)?**
  Users with `~/.claude/CLAUDE.md` for global preferences want
  the same portability. Out of scope for §13 (project-only);
  user-level portability gets its own section if it becomes a
  pain point.
- **(amended 2026-06-02) Upgrade semantics for package-shipped
  canon.** When mc upgrades, its bundled universal canon
  (`be-coordinator`, `agent-coordination`) changes — but repos
  already carry materialised copies. Does `mc adapter sync`
  re-materialise on version bump (canonical-wins, modulo the
  drift rule in 13h above), and how does it tell a stale
  package copy from a deliberate repo override? Lean: stamp the
  materialised file with the package version (cf. the existing
  `<!-- mc-adapter-sync:version=… -->` sentinel), re-sync when
  the package version is newer AND the file is unmodified;
  surface drift otherwise. Needs design before Phase 4 ships.
- **(amended 2026-06-02) Is `mc setup` enough, or is a thin
  entrypoint warranted?** 13b.1 makes the orchestrator session
  materialise on `mc setup` / `mc adapter sync`. Whether to also
  add an explicit verb (e.g. `mc coordinate`) that primes the
  session in one step is a UX question, deferred — the
  capability lands via sync regardless of the entrypoint.

### 14. Device-aware authentication via OAuth Device Flow

The user-facing goal: **new computer → install memoro-cli → run `mc`
→ browser opens → OAuth → done.** No manual `memoro-cli login`
ceremony, no copy-paste of tokens, no untracked credentials.

The architectural goal: **per-device tokens with fixed 90-day TTL
and per-device revocation,** so a lost laptop is a 30-second revoke
operation rather than an account-wide rotation, and every device
re-authenticates predictably four times a year.

#### 14a. The pain we're solving

Today's `memoro-cli login` flow is fine for the founder on the
primary dev machine — it's run once and forgotten. The first time
the user tried `mc` on a fresh machine (Vanja's MacBook Air during
the §12 integration probe on 2026-05-31), every command had to be
preceded by manual setup:

1. Run `memoro-cli login` on the machine (where the user has to
   remember this exists)
2. Wait for browser flow
3. Token lands in keychain
4. Now mc works

For external testers / future users this onboarding wall is the
difference between "I tried it" and "I gave up". Device-aware
auth folds steps 1–3 into a single `mc` invocation with a clean
browser handoff.

Per-device tokens also enable revocation hygiene that account-wide
tokens can't:

- **Lost laptop:** revoke just that device in Memoro UI; other
  devices keep working without rotation.
- **Audit trail:** "this commit was opened from device X on date Y"
  is queryable.
- **Per-device permissions (future):** read-only on this device,
  full on that one.

#### 14b. Reuse architecture — Memoro already has 90 % of this

Memoro already ships `src/auth/api-token.js` which gives us
everything we need *except* the Device Flow front door. The
bake-time was massively over-estimated before this audit:

| Component | Lives at | Status |
|---|---|---|
| Token format `mem_<64hex>` | `api-token.js:91-92` | ✓ reuse as-is |
| Hashed storage (SHA-256) | `api-token.js:99,116` | ✓ reuse |
| Default 90-day TTL, max 365 | `api-token.js:79,88` | ✓ reuse |
| `name` field for human label | `api-token.js:73` | ✓ stores `"Vanjas MacBook Air (darwin 25.4)"` directly |
| `lastUsedAt` for idle tracking | `api-token.js:112,168-183` | ✓ already throttled to 1/min; surfaces in `mc auth devices` list |
| Fixed 90-day expiry from creation | `api-token.js:79,88,166` | ✓ reuse; sliding TTL intentionally deferred (see §14d) |
| `tokenPrefix` (safe-to-show 4 chars) | `api-token.js:97` | ✓ surfaces in `mc auth devices` UI without revealing secret |
| Per-user enumeration | `api-token.js:127` (`api-tokens:${userId}`) | ✓ reuse — feeds `mc auth devices` list |
| `'device'` scope value | `api-token.js:46` | ✓ already exists ("Capacitor native-app auth exchange"); we share it |
| `validateApiToken` | `session-guard.js:18` | ✓ already wired into request auth |

So `device_tokens` is **not a new table.** It's `api-tokens` filtered
on `scope='device'`. No migration needed.

#### 14c. OAuth Device Flow per RFC 8628

Standard three-endpoint flow used by `gh`, `gcloud`, `docker login`,
`fly.io`. Three new routes on the server:

```
POST /api/auth/device/init       — start a device-authorization request
GET  /auth/device                — browser-facing OAuth + authorize page
POST /api/auth/device/poll       — CLI polls for completion
```

**Init** (called by mc):

```
POST /api/auth/device/init
Body: { device_name: "Vanjas MacBook Air", device_os: "darwin 25.4" }

Response:
{
  user_code: "ABCD-1234",          // human-typeable, 8 chars
  device_code: "<opaque-uuid>",    // CLI uses this to poll
  verification_url: "https://meetmemoro.app/auth/device",
  expires_in: 600,                 // 10 min
  interval: 5                      // poll every 5s
}
```

State stored in KV: `device-auth-pending:<device_code>` →
`{ user_code, device_name, device_os, created_at, status: 'pending' }`
with 10-min TTL.

**Browser page** (`GET /auth/device`):

1. User types or clicks pre-filled `user_code`
2. If not signed in: standard Memoro OAuth (Google/Apple)
3. After sign-in: render *device-authorization screen*

```
Authorize this device?

  Vanjas MacBook Air
  darwin 25.4
  Code: ABCD-1234
  Requested 30 seconds ago

  [Allow]    [Deny]
```

On Allow: server creates an api-token via existing
`createApiToken({ scope: 'device', name: '<device_name> (<device_os>)',
expiryDays: 90 })` and writes the token to
`device-auth-pending:<device_code>` with `status: 'authorized'`.

**Poll** (called by mc on a loop):

```
POST /api/auth/device/poll
Body: { device_code: "<opaque-uuid>" }

Responses:
{ status: 'pending' }
{ status: 'expired' }
{ status: 'denied' }
{ status: 'authorized', token: 'mem_...', token_prefix: 'mem_a1b2…', expires_at: '...' }
```

mc stops polling on any terminal status, stores the token in
keychain on `authorized`.

#### 14d. TTL policy — fixed 90 days, sliding deferred

Existing `validateApiToken` (rad 168-183) already throttles
`lastUsedAt` writes to ~1/min and refreshes the KV entry TTL to
match `expiresAt`. **Sliding TTL — extending `expiresAt` itself on
each use — is intentionally NOT in §14 v1.** A fixed 90-day cycle
from token creation is acceptable for the foreseeable user base
and gives predictable, hygienic re-auth.

Arguments considered:

- **For sliding** (gh / gcloud convention): daily users never
  re-auth as long as they're active. Lower friction.
- **For fixed** (Stripe / GitHub PAT / Slack convention): predictable
  expiry, forced periodic re-auth as a security hygiene practice,
  no ambiguity about "when does this die".

The 90-day fixed window means an active user re-auths ~4 times a
year. Memoro CLI users have not reported this as friction. If they
do, sliding is a ~7-line change in `api-token.js`'s validation path
— add it as a small follow-up amendment, don't pre-emptively design
for it.

#### 14e. `mc auth devices` verb

Three sub-verbs added to the `mc auth` surface (alongside the
`mc auth memoro` / `mc auth <tool>` from §11c):

```
mc auth devices [--json]
   List all device-tokens for this account: name, last_used,
   expires_at, token_prefix, current-device marker.

mc auth devices revoke <prefix-or-id> [--confirm]
   Revoke a specific device. Refuses to revoke the current device
   without --confirm-self to prevent accidentally locking
   yourself out.

mc auth devices rename <prefix-or-id> "<new-name>"
   Convenience — updates the api-token's name field. Useful when
   hostname.local is uninformative.
```

`mc auth devices` lives at `src/mc/commands/auth.js` alongside the
existing per-target helpers. Server-side: thin filter over existing
api-token list-and-delete endpoints — no new schema, no new model.

#### 14f. mc-side: detection + browser open + polling

`bin-mc.js` gets a fresh-install detection branch at the top of
`main()` (before any command dispatch):

```js
if (await needsDeviceAuth()) {
  return runDeviceFlow();
}
```

`needsDeviceAuth()`: returns true iff the keychain has no Memoro
token AND we're not in `--no-launch` / test mode AND we're attached
to a TTY (CI uses MEMORO_TOKEN env directly, like today).

`runDeviceFlow()`:

1. `POST /api/auth/device/init` with `hostname` + `os.release()`
2. Print `user_code` + `verification_url` to terminal
3. Try `open` (macOS) / `xdg-open` (Linux) / `start` (Windows) on
   the URL; fall back to "open this URL manually" hint if all fail
4. Poll every `interval` seconds; render a dot per poll to show
   liveness
5. On `authorized`: store token in keychain, print success line
   with token-prefix + expiry, continue with the original `mc`
   invocation
6. On `expired` / `denied`: clear error + exit 1
7. On Ctrl-C: cancel cleanly, no token created

Plus: `memoro-cli login` stays available as a CI-compatible
fallback (its existing browser-flow + manual token entry).

#### 14g. Integration with other sections

- **§11 onboarding:** `mc setup` becomes simpler — the Memoro auth
  step is no longer "run `memoro-cli login` then come back". It's
  just "auth is already done at first mc invocation; verify it's
  still active".
- **§12 vault:** vault session is per-device-token. Revoke device →
  vault inaccessible from that device. New device → vault visible
  after first `mc vault unlock` with master password (Memoro auth
  proves identity; master password proves vault ownership; both
  required).
- **§13 tool-portability:** device-token is Memoro-account-bound,
  not tool-bound. Switching from Claude to Codex on same device
  requires no re-auth. New device requires the device flow once.
- **Forgotten-master-password recovery** (parked from §12 discussion
  2026-05-31): the UI-only flow at `/vault/forgot-password` uses
  fresh OAuth re-authentication. The mechanism is the same as
  Device Flow — just initiated from the UI rather than CLI.

#### 14h. Acceptance check

- A user can `npm install -g memoro-cli` on a fresh machine, run
  `mc`, complete OAuth in the browser, and immediately use any
  `mc` command without further setup.
- `mc auth devices` lists this device alongside other machines the
  user has signed in from.
- Revoking a device in `mc auth devices revoke <prefix>` (or via
  Memoro UI when that ships) makes all `mc` commands on that
  device fail with a friendly "this device was revoked; re-auth
  to continue".
- A token expires 90 days from creation regardless of activity
  (sliding TTL deferred per §14d). Users are prompted to re-auth
  via Device Flow on the next `mc` invocation after expiry.
- `memoro-cli login` still works for CI / scripted environments
  where browser-open is not viable.
- No new database table. The `device_tokens` model is a filter
  on existing `api-tokens` with `scope='device'`.

#### 14i. Phasing

1. **Phase 1 — Server-side device flow (~2-3 hours).** Three new
   routes, KV state, the `/auth/device` UI page. Plus the
   `GET /api/auth/devices` + revoke endpoints (filtered list of
   existing api-tokens). No changes to `api-token.js` itself —
   sliding TTL deferred per §14d.
2. **Phase 2 — mc-side (~2-3 hours).** `needsDeviceAuth` detection,
   `runDeviceFlow` with browser-open + polling, `mc auth devices`
   verb. Existing `memoro-cli login` kept as CI fallback.
3. **Phase 3 — Memoro UI for device management (~2-3 hours,
   deferrable).** Settings page listing devices with revoke. Most
   users will manage devices from `mc auth devices` directly;
   UI is for the "I lost a laptop and can't get to a terminal"
   case.

Total phases 1+2: **~1 day solo.** Phase 3 is decoupled and can
ship later.

#### 14j. Open questions

- **Device-naming policy.** Default: `<hostname>.local (<os>)` per
  Node `os.hostname()` and `os.release()`. User can rename via
  `mc auth devices rename`. Open: should the auth page show the
  *user-claimed* name or the raw hostname? Probably the claimed
  one with the raw hostname underneath for verification.
- **What if the same device runs multiple Memoro accounts?**
  Today's keychain layout assumes one token per account
  prefix. Cross-account support is out of scope; document
  `MEMORO_ACCOUNT=<email>` as the future env-override.
- **Rate limiting on device init.** Probably reuse the existing
  rate-limit module with a new `deviceAuthInit` bucket — same
  pattern as vault unlock.
- **What about `cs`-style "I'm on Vanja's machine" trust?** A
  device-token issued to "Vanjas MacBook Air" is still
  technically the founder's account. If that machine is shared,
  the trust is on whoever physically owns it. Out of scope —
  shared machines are explicitly not supported in v1.
- **CI flow without a browser.** Document that CI environments
  should keep using `memoro-cli login` with `MEMORO_TOKEN` env
  (or a service-account-style token created by an authed
  admin). Device Flow is interactive-only.

### 15. Memoro-agent — remote MCP endpoint to the chat orchestrator

The strategic apex of the mc + Memoro architecture: a remote MCP server
served by the Memoro Worker that lets any MCP-compatible client (Claude
Code, Cursor, Codex, Claude.ai, …) ask the user's Memoro chat
orchestrator questions — *from inside the coding session*, without
context-switching to memoro.app.

This section integrates the standalone plan at
[`memoro/docs/plans/memoro-agent.md`](https://github.com/martinforsberg81/memoro/blob/main/docs/plans/memoro-agent.md)
(memoro-side spec) into the mc-side roadmap. **The memoro-side plan is
the source of truth for architecture, security, and server-side
implementation.** This section captures the mc-side concerns and the
integration points.

#### 15a. Why this is high-priority

Two earlier "deferred" assumptions stopped being true on 2026-06-01:

1. **mc became a real working surface** (§12 vault + §14 device flow
   shipped). "Switch from mc to Memoro chat to ask a question" is now
   a daily friction, not hypothetical.
2. **Strategic positioning of mc** (free + open source, backed by
   paid Memoro) makes memoro-agent the *primary conversion mechanism*
   from gratis-mc-user to Memoro-paying-user. Not a v2 convenience.

Plus the architecture got dramatically simpler when verified: Claude
Code, Cursor, and Codex all support **remote HTTPS MCP** with bearer
auth + OAuth. The originally-planned local stdio shim
(`memoro-cli mcp`) is unnecessary — the Worker serves MCP directly.
See the memoro-agent plan for the architecture diagram.

#### 15b. What mc owns vs what Memoro owns

| Concern | Lives at | Why there |
|---|---|---|
| `/mcp` Streamable HTTP endpoint | Memoro Worker | MCP server-side IS Memoro chat orchestrator; can't be local |
| `memoro.ask` tool dispatch | Memoro Worker | tool implementation calls chat orchestrator |
| Tool denylist + privacy curation | Memoro Worker | belongs with the data it gates |
| api-token with `scope='agent'` | Memoro Worker (existing api-token.js) | reuse, no new model |
| Token enrollment UI (`/settings/agent-access`) | Memoro Worker | matches existing settings pattern |
| `mc auth agent enroll` verb | memoro-cli | mc owns CLI ergonomics |
| OS keychain storage of agent token (Pattern B) | memoro-cli (`src/lib/keychain.js`) | existing local-secrets infra |
| `mc auth agent print-headers` helper | memoro-cli | wired as Claude Code's `headersHelper` so token never lands in `.claude.json` |

#### 15c. Two enrollment patterns

Per the memoro-agent plan §"Enrollment + token storage":

**Pattern A — bearer token in MCP config (simplest).** User runs
`mc auth agent enroll`, browser opens to enrollment page, token shown
once, user copies + pastes into:

```
claude mcp add --transport http --header "Authorization: Bearer mem_xxx" \
  memoro https://mcp.meetmemoro.app/mcp
```

Token lives in `~/.claude.json`. Acceptable security floor (Anthropic
encrypts it on disk), fastest user experience.

**Pattern B — `headersHelper` reads from OS keychain (most secure).**
User runs `mc auth agent enroll --to-keychain`, token stored in
OS keychain. Then:

```
claude mcp add-json memoro '{
  "type": "http",
  "url": "https://mcp.meetmemoro.app/mcp",
  "headersHelper": "mc auth agent print-headers"
}'
```

Token never lands in `.claude.json`. `mc auth agent print-headers`
emits `{"Authorization":"Bearer mem_xxx"}` from OS keychain on each
MCP connect. Rotation is `mc auth agent rotate` with no Claude Code
config change. Recommended for sophisticated users.

#### 15d. Reuse pattern with §11a / §11c / §14

The new `mc auth agent` verb slots into the existing `mc auth` family:

- `mc auth status` (§11a) — extends to show agent-token state per
  client ("agent.claude-code: ✓ token in keychain, last used 5 min ago")
- `mc auth memoro` (§11c) — unchanged
- `mc auth <tool>` (§11c) — unchanged
- `mc auth devices` (§14e) — peer verb
- `mc auth agent` (§15) — new peer verb

This keeps the mental model consistent: `mc auth <target>` for any
auth concern, target-specific subcommands underneath.

#### 15e. Server name reservation

Claude Code reserves `workspace` as a server name. Cursor and Codex
have no explicit reservations but `memoro` is the natural choice
across all clients. The `mc auth agent enroll` UX should pre-fill
this name in the example commands it generates.

#### 15f. Implementation order (cross-repo)

**Code-verified (2026-06-02): Phase 1 is NOT built on memoro.** No `/mcp`
endpoint, no `memoro.ask` tool, and no `agent` scope exist in memoro's code
(only full / sessions.write / lens.read / upload / read / device scopes;
`/api/agent` is admin-only run-approvals). So mc-side Phase 2 is
**genuinely gated** until memoro ships the server side — and memoro's
current focus is the App Store launch. Park §15 mc-side work until then.

Cross-repo drev. Per §10i.1's "single-repo lower risk" guidance, split:

1. **Phase 1 — Memoro server (~3-4 hours).** `/mcp` Streamable HTTP
   endpoint, `requireApiToken({ scope: 'agent' })` helper, `/api/agent/tokens`
   CRUD, `/settings/agent-access` UI. Merged + deployed before phase 2.
2. **Phase 2 — memoro-cli (~2-3 hours).** `mc auth agent enroll | list |
   revoke | print-headers` verbs. Token in keychain (Pattern B); enrollment
   browser-flow mirrors §14's Device Flow pattern.

Total: ~1 day solo across both repos. Pattern A enrollment works without
any mc-side changes (user just pastes the token themselves), so phase 1
is independently shippable.

#### 15g. Acceptance check (mc-side)

- `mc auth agent enroll --to-keychain` opens browser, stores token in
  keychain after user authorises in `/settings/agent-access`
- `mc auth agent print-headers` emits valid JSON
  `{"Authorization":"Bearer mem_xxx"}` to stdout from keychain
- `mc auth agent list` shows agent-scoped tokens with name + last-used
  + expires
- `mc auth agent revoke <prefix>` deletes the server-side token; next
  MCP call from a client using that token gets 401 → reconnect failure
- `mc auth status` includes an "Agent tokens" section listing clients
- A Claude Code instance configured with `headersHelper: "mc auth agent print-headers"`
  successfully calls `memoro.ask("test")` and gets a response from the
  chat orchestrator — verified via manual smoke after both phases land
- No token bytes appear in subprocess-captured stdout/stderr across
  the full lifecycle (no-leak invariant pattern from drev 3)

#### 15h. Open questions

- **MCP server name "memoro" vs "memoro-app"?** Probably just "memoro";
  matches the brand, is short, no collision.
- **OAuth for high-volume / multi-account users?** Pattern A and B
  both use api-tokens. Future tier-3 use cases (multi-account,
  team agents) might need OAuth. Defer until first user asks.
- **Tool surface beyond `memoro.ask`?** Per the memoro-agent plan,
  v1 is one tool. v2 might add `memoro.observe(file_path, kind)` for
  proactive "store this decision" writes. Out of scope here.

### 16. The memory loop — Memoro ↔ session, bidirectional (proposed 2026-06-02)

The mission (north star, top of file) names Memoro as the user's personal
knowledge base and mc as the on-machine bridge. The two form a
**bidirectional loop** that makes orchestration *personalised* and treats
the user's own development as a first-class goal. This loop is core to the
mission but, until now, had no home in this plan — its parts live in the
low-level `memoro-cli` binary (`src/bin.js`), not in the mc orchestration
surface.

#### 16a. The two directions

**Code-verified on the memoro side (2026-06-02): both endpoints this loop
needs are LIVE** — `POST /api/sessions/external`
(`src/routes/sessions/external.js`, scope `sessions.write`, accepts
`decisions`/`loose_ends`/`corrections` from claude-code/codex/cursor/
gemini-cli) and `GET /api/lens/portrait-coding` (`src/routes/lens/read.js`,
the only externally exposed lens). The earlier "planned / phase 8" doc tags
were stale. So this loop is **buildable now on the mc side; it is not gated
on memoro.**

- **Session → Memoro (observe).** A session emits what happened —
  decisions, loose-ends, practices, stack — for Memoro to store and learn
  from. **Partially built:** `src/commands/heartbeat-loop.js` streams
  heartbeats + transcript excerpts; Memoro derives the structured records
  (surfaced by the `memoro-*` skills). Not yet a first-class
  mc-orchestration output (a fanout phase's result should feed
  observations too).
- **Memoro → session (user_state / lens).** Memoro feeds context about
  *who the user is and where they are heading* back into the session's
  standing context. **Partially built:** `memoro-cli lens pull`
  (`src/commands/lens.js`) fetches a coding "portrait"
  (`/api/lens/portrait-coding`) and writes it as a managed block so it
  lands in the tool's standing context. Today it is manual / hook-driven,
  lives on the low-level binary, and is coding-scoped only.

#### 16b. Gaps toward the mission

1. **Automatic + first-class in the orchestrator flow.** The lens should
   flow into every mc-orchestrated session (coordinator and each fanned
   agent) at bootstrap, without a manual `lens pull`.
2. **Broaden beyond "coding portrait".** From "how this user codes" to
   "who this user is, what they're working toward" — the user_state the
   mission describes, supporting the person's development, not just the
   diff.
3. **Close the loop with §15.** The `memoro-agent` (MCP) gives agents
   *pull* access to the whole knowledge base on demand; the lens is the
   *push* of the most relevant slice into standing context. Complementary,
   not redundant.

#### 16c. Cross-repo boundary

The endpoints exist (16a), so mc owns the buildable parts now: the bridge
(fetch lens + emit sessions), the orchestration-flow integration, and
session bootstrap. The one part still memoro-gated is **Phase 3** — the
*broadening* of the lens from "coding portrait" to the full user_state /
user-development model, which depends on memoro-side learning not yet
exposed. That broadening, not the loop itself, is the standing
cross-product dependency.

#### 16d. Phasing

1. **Phase 1 — Surface today's loop (buildable now).** Document + test the
   existing `lens pull` + heartbeat / `sessions/external` paths as v0.
2. **Phase 2 — Auto-inject into orchestrated sessions (buildable now).**
   Lens flows into coordinator + fanout agents at bootstrap (no manual
   pull); emit observations on session/phase end to `/api/sessions/external`.
3. **Phase 3 — Broaden the lens to user_state / development (memoro-gated).**
   Depends on memoro-side learning not yet exposed via the lens.
4. **Phase 4 — Observations as a first-class orchestration output.** Each
   spine result (§10s) feeds structured observations back to Memoro.

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
