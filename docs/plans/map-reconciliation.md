# Map Reconciliation Guard

**Status:** active · 2026-06-07 · serves G1, G3

Reading `MEMORO.md` at session start does not make an LLM remember to update it.
The product needs a reconciliation habit: the coordinator asks the map question
at the right moments, without turning mc into a PM system or a roadmap editor.

## Locked Product Decision

`mc map` is primarily an **in-session coordinator habit**, not a terminal CRUD
surface. The normal user flow is:

1. The user is inside a coordinator session.
2. The user writes `/mc map`.
3. The LLM receives a concise prompt: update `MEMORO.md` if needed.
4. The LLM uses its existing session grounding plus normal repo inspection to
   decide whether `MEMORO.md` needs a focused patch.
5. If yes, the coordinator edits `MEMORO.md` deliberately and commits it as
   cross-session project state.

There is no terminal `mc map` requirement in the MVP. Terminal surfaces can come
later for debugging, evidence preview, or dispatch to a live session, but the
first product must work from inside the coordinator session. It should never
become a family of map-mutating commands.

## Product Rule

`MEMORO.md` is coordinator-owned committed project state. After non-trivial
work, the session must decide whether the map changed; if yes, it should draft
and apply a focused patch as part of the coordinator loop. mc itself should
avoid hidden background edits and should never turn map maintenance into a PM
CRUD subsystem.

The right answer is often **No map change**. Roadmap edits should track durable
project state, not every implementation detail, commit, transcript, or release
note.

## Map Discipline

Keep the map brutal:

- max 10-14 active nodes
- `active · now` should be rare and meaningful
- every active node needs a track: plan file, branch/worktree, PR, or next action
- shipped/archived-recently should hold recent exits so stale active nodes do not
  linger
- prefer updating an existing node over adding a new one
- detail belongs in `docs/plans/`, not in `MEMORO.md`

## Repo And User Fit

`MEMORO.md` is optional continuity infrastructure. It should appear where a repo
has coordination cost: multiple workstreams, releases, team handoff, infra risk,
customer delivery, or long-lived research. Small scripts, docs-only repos, and
throwaway experiments should not get noisy prompts by default.

For monorepos, start with one root map. Add sub-maps only when a package/domain
has its own lifecycle, owner, release cadence, or coordination boundary.

For open source, consulting, and privacy-sensitive repos, map content must stay
commit-safe. Do not copy private discussion, customer detail, PII, secrets,
transcripts, or internal tactical notes into `MEMORO.md`.

mc must never replace repo-owned instructions such as `AGENTS.md`, `CLAUDE.md`,
README, or project docs. Configuration controls mc behavior; the map controls
roadmap continuity.

## Prompt Shape

The managed prompt should be short. The LLM already has coordinator grounding
and is capable of inspecting the repo when needed.

```text
Update MEMORO.md if needed.
```

The detail discipline still comes from `MEMORO.md` itself: sparse nodes, durable
project state, and plan detail in `docs/plans/*`.

## Command Semantics

### Session Habit

`/mc map` is the one habit. Do not add `/mc end` with overlapping
map-reconciliation behavior.

Claude can get a managed slash command if the native command surface supports
it. The command body should stay concise and rely on the session's coordinator
grounding.

Codex has no stable native slash-command surface today. For Codex, grounding
should teach the coordinator that when the user writes `/mc map`, it should
follow the same short instruction directly.

### Terminal Surface

No terminal `mc map` command is required for MVP. Do not add `mc map --prompt`
as the first slice; it would move the habit out of the session and re-create the
terminal handoff problem this feature is meant to solve.

Later optional terminal surfaces:

- `mc map --preview`: print the reconciliation prompt/evidence for debugging.
- `mc map <session>`: dispatch the prompt to one live/reachable session when the
  target is unambiguous.
- `mc map <session> --dry-run`: show target and prompt metadata without sending.

Do not self-dispatch from inside a managed session. Writing back into the same
PTY while a shell command is running is brittle.

If a session is dead, terminal `mc map <session>` should not edit the map. It
should say to resume the session and run `/mc map`.

## Tripwires

Tripwires come after the prompt habit works. Start with hints, not a command
family:

- `mc status <name>` can show `map: likely-stale` when a session has shipped work
  or new plan files but `MEMORO.md` did not move.
- `mc list --rich` / `mc list --tree` can surface project sessions without a map
  node.
- `mc end <name>` can warn when a dirty/shipped session did not reconcile the
  map, but it must not become a second reconciliation workflow.

Tripwire labels are heuristics:

- `map: missing`
- `map: ok`
- `map: likely-stale`

Reasons should be concrete, such as:

- `shipped-work-no-map-change`
- `plan-file-changed`
- `changelog-changed`
- `project-session-without-node`

Never phrase tripwires as authority. mc can say "likely stale"; it cannot decide
which node changed.

## Non-Goals

Do not build:

- silent writes or auto-commits
- `mc map set-status`, `mc map add-node`, `mc map archive`, or similar CRUD
- map reconciliation inside `mc end`
- broadcast prompts to many sessions
- auto-resume or auto-start sessions for map work
- transcript reading by default
- full-project summarisation from history
- scans of `.env`, `.dev.vars`, vault materialisation files, or other secret
  runtime files
- conflict resolution between branches' map edits
- CI/hooks that update `MEMORO.md` in the background

## Implementation Slices

### Slice 1 - Managed Session Affordance

Status: shipped after 0.7.6.

Install the session habit before any terminal command.

- Claude: install a managed `/mc` command so `/mc map` works as the same
  user-facing session habit.
- Codex: update grounding/canon so `/mc map` is understood as a session
  instruction.

The command/canon body should contain only the short prompt. It should not bake
in a command list, safety checklist, fallback taxonomy, or procedure.

### Slice 2 - Live-Use Polish

Use the command in real coordinator sessions and tune only what proves useful in
practice:

- whether the prompt is short enough to feel natural
- whether the LLM edits too much or too little
- whether the banner/help text points users at the habit without overexplaining

### Slice 3 - Optional Prompt Helper

Only after the session habit proves itself, consider a pure helper
module/command for debugging or preview.

- possible command: `mc map --preview`
- possible JSON metadata for tooling

This is not MVP unless real use shows the session prompt is insufficient.

### Slice 4 - Optional Dispatch

Only after the in-session habit is proven, add `mc map <session>`:

- resolve exactly one registry/live session
- refuse ambiguous labels
- prefer local dispatch socket when reachable
- fall back to existing Memoro dispatch only if the target is clearly reachable
- do not broadcast

Human success:

```text
mc map: dispatched MEMORO.md reconciliation prompt to dev (sess_abc123) via local-socket
```

Dead-session refusal:

```text
mc: session "dev" is not active.
Run `mc resume dev`, then `/mc map`.
```

### Slice 5 - Tripwires

Add `map_status` and `map_reasons` to `mc status` / `mc list --rich` once the
session habit exists. Keep it deterministic and advisory.

## Test Plan

- Managed command/canon: contains only a concise `/mc map` prompt.
- Managed command/canon: does not contain shell commands, safety checklists, or
  procedure text.
- Compatibility: Claude command installation is idempotent and managed.
- Compatibility: Codex grounding/canon includes the `/mc map` convention without
  editing repo-owned instructions unexpectedly.
- Later helper: CLI preview emits parseable metadata if that surface is added.
- Dispatch later: fake Unix socket receives `{ "message": "..." }`.
- Full `npm test`.
