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
6. Graceful migration: existing `cs` worktrees keep working until cut
   over; nothing breaks under foot.

## Non-goals

- Not building our own Claude-Code-style TUI. We still launch the
  underlying coding tools (Claude Code, Codex, etc.) — `mc` orchestrates.
- Not replacing git. Branches remain pure git; `mc` only owns the
  *conventions* (naming, where worktrees live).
- Not cross-repo session graphs. One repo at a time.

## Design

### 1. Worktree placement — centralised under `~/.mc/`

Drop both `.claude/worktrees/<name>` (leaks into repo working tree) AND
the cs-style sibling-dir `<repo>--<name>` (clutters the parent
directory; the user explicitly called this out as a pain point — having
~20 `memoro--sess-*` siblings next to the repo is too messy to scan).

**Default:** `~/.mc/worktrees/<repo-slug>/<name>`

- `<repo-slug>` = the basename of the primary worktree (`memoro`,
  `memoro-cli`, etc.). Collisions across different repos with the same
  basename are resolved by appending a short hash of the absolute
  primary-worktree path.
- The directory is hidden (`.mc`) so it doesn't visually compete with
  user dirs in `~`.
- Editors handle longer paths fine; project-root detection still works
  (each worktree has a `.git` file pointing back at the primary
  worktree's `.git/worktrees/<name>` — git tooling stays happy).

Overridable per-machine via `mc config worktree.root <path>` for users
who want sibling-dir or an XDG location (`~/.local/share/memoro-cli/...`).

The shell wrapper (§2b) makes the long path irrelevant in practice —
users navigate by name (`mc cd <name>`), not by typing the path.

### 2. First-class lifecycle commands

```
mc new <name> [--from <ref>] [--tool claude|codex|gemini]
   create worktree, create bootstrap branch sess/<name>, launch tool

mc list
   default: only user-created work-sessions. Table: name · branch ·
   dirty/clean · session live? · last activity · open question (derived
   from last assistant message, see §4). Transient isolation worktrees
   from subagents are hidden — they are infrastructure noise, not work.

mc list --all
   include transient isolation worktrees (from subagent spawns) and dead
   sessions still pending gc. Same columns plus a `kind` flag
   (work | isolation | spawn).

mc resume <name>
   cd to worktree, claude --resume (or codex resume, etc., per stored
   tool); same picker behaviour the user already knows

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
shows as "1 commit ahead" and looks unsafe. The fix:

For each branch whose `mc end` is invoked with non-zero ahead count:

1. Look up `gh pr list --head <branch> --state merged` — if there's
   a recent merged PR for this branch, mark as candidate phantom.
2. Compare the branch's changeset to main: `git diff <branch> origin/main
   -- <files-from-branch-commits>` — if empty, confirmed phantom.
3. Surface as `IS_SQUASH_PHANTOM` in `mc status`; `mc end` proceeds
   without prompting (the work *is* on main, the branch is just an
   alternate hash).

Without this, the user has to manually run `gh pr view`, grep for
files on main, and *decide* — every time. With this, end-of-cycle
cleanup is one command.

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

**Priority order**

Of these, **9a, 9b, 9c, 9d** were the friction points that hit during
*every* session in the 2026-05-26 run — they should land in the same
release as the §2 base commands, not as a follow-up. The rest (9e–9i)
are still wins but have narrower trigger conditions.

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
