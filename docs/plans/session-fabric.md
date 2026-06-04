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
status, and MEMORO.md obligations.

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
- optional `memoro_node`
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

## Phase 4 — Reconciliation handoff

Project sessions must report whether their MEMORO.md node changed. The
coordinator gathers those reports and proposes one concrete map patch. mc can
surface tripwires, but the LLM session still writes and reviews the actual patch
with user approval.

## Acceptance

- A coordinator can spawn four project sessions and see them in one tree.
- Each project session has a worktree/branch and can be resumed under Claude or
  Codex.
- Each project session receives a brief artefact and a focus/node pointer.
- `mc end`, `mc status`, `mc gc`, and existing registry operations continue to
  work because spawned projects are ordinary sessions with extra metadata.
