# mc is a continuity layer

**Status:** settled · 2026-06-03 · serves G2, G3 (see `MEMORO.md`)

Records where the "fanout" thinking landed. (Filename kept because the MEMORO.md
node still points here; the conclusion is that there is no "spine" to build.)

2026-06-04 update: this conclusion is stronger after live use. The coordinator
session can write its own brief and send agents through whatever tool surface is
available. mc should make that session wake grounded; it should not encode a
PM workflow around it.

## What mc is

The engine — agents, spawn, worktree isolation, parallelism, task-tracking —
comes **free** from the underlying model/tool (Claude Code / Opus, codex). mc does
**not** reimplement it. mc adds exactly two things:

- **Grounding** — map + role + lens injected at session start. *(Shipped: the
  grounding MVP.)*
- **MEMORO.md as living project state** — committed in the repo and kept current
  as work lands.

The payoff is the whole point: **resume a piece of work in a new mc session**
(another day, machine, or tool) because it grounds in the map.

## What mc is not

Do not build these until live work proves a concrete gap that the coordinator
session cannot solve by writing a better prompt:

- A project-management UI or command family around the map.
- `mc map status/update/review` verbs.
- Resume-by-intent search.
- A fanout/verify/gather state machine.
- Ensemble or hierarchy machinery.
- Automatic MEMORO.md rewriting.

Those are LLM-cruft risks. The thinner product is better: make the session see
the whole, then let the model coordinate.

## Why there is no "fanout spine" to build

We designed an execute → verify → gather spine (reaper, trust state-machine,
parallel phase decomposition) and **rejected it as premature** — it reinvents a
worse Agent-tool, and the work we actually do is mostly *dependent, sequential,
and decided adaptively* (the grounding MVP was a pipeline, not a fan-out). Agents
are the tool's job. If genuinely independent parallel work appears, spawn
tool-agents and record the units as map nodes — no special machine.

## How we operate (the loop, with borrowed agents)

```
see the whole → write a strong build brief → send a tool-agent (one PR)
   → a SEPARATE review agent (2nd opinion, prompt written from the goal)
   → merge (the human's go)
```

Proven by hand this session: grounding MVP, 6 PRs, one stall handled in a minute.
The orchestrator's leverage is writing **two good prompts** per unit of work
(build + review); it never builds and never self-reviews.

## The real next build

Make the **first minute** of a coordinator session reliable:

1. It sees the map, role, repo, selected tool, and current worktree/session.
2. It understands the boundary: high-altitude coordinator, not heads-down builder
   unless the user explicitly asks or the task is tiny.
3. It can write a brief and use available agent tools without new mc commands.
4. If `MEMORO.md` is created in a repo, it is committed so every worktree/session
   can inherit it.
5. As work lands, the session offers a concrete map patch for user approval; no
   silent map edits.

The map holds where each project stands; git branch/PR/session state holds the
rest. Fix concrete resume gaps as they appear in live work.

## Open (resolve by trying, not by designing)

- How much in-flight state belongs in the map vs git/`focus`? Resume a real
  half-done thread in a fresh session and fix whatever was missing.
- Does the current coordinator grounding make the model delegate early enough,
  or does it still drift into implementation detail? Test by running real work,
  not by inventing new CLI features.
