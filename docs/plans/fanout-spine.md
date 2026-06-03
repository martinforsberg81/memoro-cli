# The orchestrator loop (fanout)

**Status:** proposed · 2026-06-03 · serves G1 (see `MEMORO.md`)

Detailed plan for the MEMORO.md node *"Fanout spine"*. Supersedes the earlier,
over-engineered version of this file — the loop below is what we actually want,
and it is the loop we already ran by hand to ship the entire grounding MVP this
session (6 PRs, one stall handled in a minute). It is not speculative.

## The model

One orchestrator LLM session holds the whole. It does four things, in a loop:

```
1. SEE the whole          — hold the goal, the map, the bird's-eye view
2. WRITE a strong brief    — goal + scope + what NOT to build, per unit of work
3. SEND an agent           — it builds, returns a PR
4. REVIEW (2nd opinion)    — a SEPARATE review agent, prompted from the goal,
                             judges the work against intent
   → finished work returns to the orchestrator → MERGE (the human's go)
```

That is the system. The overarching session **is** the product — the loop above
is not scaffolding around fanout, it *is* fanout.

## The orchestrator's leverage: two prompts

Everything good comes from the orchestrator writing two prompts well, both
derived from the goal it holds:

- **The build brief** — what to build, what's out of scope, when to escalate.
  (The act of writing it is the quality mechanism: it forces intent explicit.)
- **The review brief** — what "correct against the goal" means for this work.

The key discipline the human added: **review is a separate agent, not the
orchestrator marking its own homework.** The build eye and the judge eye must be
different eyes. The orchestrator stays high-altitude through both — it writes the
prompts and reads the verdicts; it does not build and does not self-review.

## What we are NOT building (and why)

The earlier plan grew a reaper, a `verify` state machine, trust-buckets, a
stall-watchdog, a two-layer gather gate. **All deferred.** They were solutions to
failure modes we have not actually hit. We ran ~8 agents this session with one
stall, handled by hand. Add machinery only when a real failure forces it — not
before. Simpler is more reliable because it is more predictable.

If "review = a 2nd-opinion agent" feels insufficient later (e.g. we want an
adversarial read-only sandbox, or automatic merge-gating), that is a *future*
refinement of step 4 — added on evidence, not anticipation.

## Minimal build

Today `mc fanout` *stages* phases (branch + worktree + brief + registry) but
never *runs* them, and the orchestrator reviews by hand. Two small steps close
the loop:

1. **`mc fanout --run`** — wire the already-parked launcher (`runHeadless` on
   `feat/fanout-run`) so staged phases actually launch as headless agents. Rebase
   the WIP onto current main; land the primitives with unit tests. This is the
   one genuinely missing piece of plumbing.
2. **Review pass** — when a phase returns a PR, the orchestrator spawns a review
   agent with a review brief written from the goal, and reads its verdict before
   the merge decision. Start as orchestrator behaviour (spawn + review brief); a
   thin `mc` helper can follow if it earns its place. `mc gather` already merges
   the approved PRs.

Nothing else until we feel a real need.

## Open (resolve when we hit it, not now)

- Does the review pass want a reusable review-brief template, or is it bespoke
  per goal each time? (Lean: bespoke first; templatise only if a pattern repeats.)
- Does `mc fanout --run` need cost/limit guardrails before it's safe to fan out
  many agents at once? (Revisit when we actually fan out at scale.)
