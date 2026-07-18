# Session Fabric

**Status:** active · 2026-06-04 · serves G2, G3

mc should support a durable fleet shape without becoming an agent runner:

```text
coord
  i18n
  automations
  courses
  data
```

The human talks mostly to the coordinator. The coordinator talks to project
sessions through mc. Each project session is a real mc session with its own
worktree, branch, registry entry, grounding, vault/policy context, transcript
status, and scoped brief.

## Boundary

Tool-internal agents are disposable execution helpers. mc project sessions are
durable work units.

Do not build a scheduler, queue, autonomous PM loop, or agent runtime. Build the
fabric that makes sessions visible, resumable, and governable.

## Phase 1 — Spawn tracked project sessions

Add a small `mc spawn <name> "<brief>"` surface that creates a normal session
worktree and records fabric metadata:

- `kind: "project"`
- `parent: <current mc session when known>`
- `role: "project"`
- `focus`
- optional `scope`
- brief written to `.mc/brief.md`

The spawned session can be launched immediately or resumed later. It should show
up in existing `mc list`, `mc status`, and `mc resume` flows because it is just a
registry-backed session.

## Phase 2 — Tree visibility

Add a tree view over the registry:

```text
coord
  i18n        idle   codex   sess/i18n
  courses     live   claude  sess/courses
```

This is display, not orchestration. It helps the coordinator see which project
sessions exist, who owns them, and which ones are stale or awaiting input.

## Phase 3 — Messaging loop

Harden coordinator-to-project communication:

- `mc sessions send <name> <msg>` resolves local session names reliably.
- `mc sessions read <name>` reads the right transcript.
- Add a conservative `mc sessions nudge <name>` later only if live work shows it
  is needed.

Auto-pinging every session by default is deferred; it risks noise and loops. The
first useful version is manual nudge plus stale visibility.

## Phase 4 — Status handoff

Project sessions should report their goal, status, decisions, blockers, branch,
commits/PR when relevant, and next steps back to the coordinator. That work
record lives in session metadata/transcripts, not in a user profile and not in a
repo-local MEMORO.md obligation.

## Phase 5 — Supervisor control prompt

`mc supervisor` is the terminal client for one online-synced supervisor
conversation, shared later with CodingApp. It is not a coding session and must
not use the primary Memoro auth token. It gets a separate scoped device token
(`mc.supervisor`) stored under its own keychain account, accepted only after the
server proves matching scope and audience, and client-side calls are allowlisted
to supervisor API paths.

The supervisor can summarize local broker sessions and dispatch explicit user
commands (`read`, `send`, `stop`, `remove`). Broader memory access is out of
scope except a deliberately small user-context payload designed for this
surface.

## Acceptance

- A coordinator can spawn four project sessions and see them in one tree.
- Each project session has a worktree/branch and can be resumed under Claude or
  Codex.
- Each project session receives a brief artefact and a focus/scope pointer.
- `mc end`, `mc status`, `mc gc`, and existing registry operations continue to
  work because spawned projects are ordinary sessions with extra metadata.
- `mc supervisor` cannot call non-supervisor Memoro endpoints with its scoped
  token, the primary Memoro auth token is never stored or used as supervisor
  auth, and `mc supervisor logout` can revoke/remove the supervisor token.
