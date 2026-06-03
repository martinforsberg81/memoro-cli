# mc is a continuity layer

**Status:** settled · 2026-06-03 · serves G1, G2 (see `MEMORO.md`)

Records where the "fanout" thinking landed. (Filename kept because the MEMORO.md
node still points here; the conclusion is that there is no "spine" to build.)

## What mc is

The engine — agents, spawn, worktree isolation, parallelism, task-tracking —
comes **free** from the underlying model/tool (Claude Code / Opus, codex). mc does
**not** reimplement it. mc adds exactly two things:

- **Grounding** — map + role + lens injected at session start. *(Shipped: the
  grounding MVP.)*
- **MEMORO.md as living project state** — kept current as work lands.

The payoff is the whole point: **resume a piece of work in a new mc session**
(another day, machine, or tool) because it grounds in the map.

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

## The only real next build

Make MEMORO.md's **in-flight state** reliable, so resuming a *specific* half-done
thread is frictionless. The map holds where each project stands; grounding's
`focus` pointer + the git branch/PR hold the rest. Keep the map's in-flight state
current (lightly, perhaps semi-automatic) — that is the work, not a spine.

## Open (resolve by trying, not by designing)

- How much in-flight state belongs in the map vs git/`focus`? Resume a real
  half-done thread in a fresh session and fix whatever was missing.
