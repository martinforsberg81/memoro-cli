# Fanout spine: execute → verify → gather

**Status:** proposed · 2026-06-03 · serves G1 (see `MEMORO.md`)

Detailed plan for the MEMORO.md node *"Fanout spine"*. The map node stays terse;
depth lives here. Decomposes `worktree-lifecycle.md` §10s into reviewable drev.

## Problem

`mc fanout` *stages* phases today (branch + worktree + brief + registry entry)
but never *runs* them — no agent executes. `mc gather` merges **every open phase
PR regardless of outcome**: there is no trust gate (the explicit §10s gap). The
execute primitives exist as parked WIP on `feat/fanout-run` (`runHeadless`,
`result-capture.js`) but are orphaned — no caller, no reaper, no registry wiring.

## Goal

One human fans a plan out to a fleet, stays high-altitude, and ships **only work
that proved itself** — automatically for the routine case, escalating to the
orchestrator only for genuine ambiguity. The organizing principle is **trust**,
and the design rule is **simplicity**: a spine you can predict in your head is a
spine you can rely on.

## The trust model — one rule

> A phase merges **iff it proved itself**: `completed` with a `.mc-result.json`
> result-file (self-report via the contract) **or** `verified`. Everything else
> — `inconclusive`, `failed`, exit-code-without-file, `rejected-by-verifier` —
> does **not** auto-merge; it surfaces to the orchestrator as a *seam*.

One rule, two outcomes: **proven → auto, unproven → escalate.** No multi-bucket
grading. `mc verify` is the on-demand tool the orchestrator reaches for to
*promote* an unproven phase to proven — not a mandatory step on every phase.

**Silence ≠ done.** A finished agent that never wrote its contract file proved
nothing → `inconclusive` (per §10f), never `completed`. This one line is the
whole reliability foundation: it makes masked failures (exit 0 but broken, e.g.
`claude -p` exits clean without solving the task) impossible to mistake for
success.

## Roles — verify vs gather

The two stages mirror two different kinds of correctness:

- **verify** = *per-phase trust.* Does this phase's diff do what its brief asked,
  is it correct **on its own**? Adversarial, read-only, **agent-run**, forbidden
  to write code. Sets `verified | rejected-by-verifier`. This is where code
  detail is adjudicated.
- **gather** = *integration trust.* Do the proven phases form a coherent
  **whole**? Verify-per-phase is structurally blind to cross-phase failure
  (textual conflict, semantic incompatibility, an integrated branch that fails
  its own suite). Gather is a **two-layer gate**:
  1. **Mechanics (no intelligence):** merge the proven phases that merge cleanly
     into `wip/<slug>`, then **run the test suite on the integrated branch**.
     Deterministic CLI — the happy path needs no LLM and no orchestrator labor.
  2. **Seam (judgment):** on a conflict or a red integration suite, **stop and
     surface the seam to the orchestrator** — which phases, which file, what
     kind. Never silent auto-resolve.

**The orchestrator owns the gather *decision*, not the gather *work*.** Gather is
the convergence point — the one place all phases meet — so holding it is the
orchestrator's reason to exist. But it does not merge by hand or read every
phase's diff (verify already certified each phase); it sees only the *seam*
(cheap context) and decides: resolve, drop a phase, or re-fan. The code-level
resolution is delegated to a small focused **resolution agent** given the two
affected phase briefs. A standing "gather session" adds no layer — it would just
be the orchestrator, or an agent it already spawns on demand.

## Reliability decisions (load-bearing, kept simple)

- **The reaper owns all post-spawn registry writes.** The registry is
  read-modify-write without locks; N parallel agents writing it would race. So
  agents write **only** their own `.mc-result.json` (filesystem, no race); a
  single reaper sweep reads pid + result-file and patches the registry. The
  spawning `fanout` process sets `running`/`live`/`pid` serially in its loop.
- **Stall gets a deadline.** A hung headless agent stays alive (pid present) but
  produces nothing — we saw exactly this stall in the grounding work. Each phase
  gets a wall-clock deadline (`--phase-timeout`, config default); the reaper
  SIGTERMs over-runners → `failed`, reason `stalled`. An explicit sweep, **no
  long-running daemon** (avoids a new orphan source); reuse the orphan-daemon
  liveness helpers.
- **Partial failure continues.** One phase falling does not fail the fanout (per
  §10g); the others proceed. Gather merges the proven ones and **explicitly lists
  the excluded** with reasons — never silently skips.
- **Integration suite on `wip/`.** Even all-phases-proven does not guarantee the
  merged whole passes; running the existing suite on the integrated branch is one
  cheap deterministic command that catches emergent cross-phase breakage.

## Deliberately kept simple (deferred complexity)

- **`mc fanout status`** = a readable table + `--json`. **Not** §10i's four-branch
  render-surface detection — deferred until a real need.
- **Registry vocabulary grows per drev:** `running | completed | failed |
  inconclusive` now; `verified | rejected-by-verifier` arrive **with** verify. No
  unused states sitting in the contract.
- **Idempotent resume** (`--resume`, skip proven phases) is a later drev, not MVP.
- **Plan format** stays markdown (YAML frontmatter deferred); cross-phase context
  sharing deferred; conflict detection stays file:line (not semantic).

## Phasing (drev sequence — small, reviewable, risk-axed)

1. **Land WIP primitives** — `low`. Rebase `feat/fanout-run` onto post-grounding
   main; land `runHeadless`/`headlessArgs`/`HEADLESS_SUPPORTED` + codex fail-loud
   stub + `result-capture.js` with unit tests. Fix `classifyOutcome`: missing
   file → `inconclusive` (not `completed`). No caller yet. Risk: rebase conflicts
   in the adapter files (grounding added `writeGrounding`/`launchSpec` there).
2. **Registry vocabulary + state** — `low`. Add `result_status`
   (`running|completed|failed|inconclusive`), `pid`, `result_path`, `started_at`
   to the registry contract. No behaviour change.
3. **`mc fanout --run` (execute-leg)** — `medium`. Spawn `runHeadless` per phase
   via adapter capability-routing; set `live`/`running`/`pid`; update the brief so
   the agent writes `.mc-result.json`. Risk: detached-spawn in prod, PATH
   resolution, serial registry writes by the spawning process.
4. **Completion-reaper + stall-watchdog** — `medium-high`. Sweep: poll pid → read
   result-file → `classifyOutcome` → registry patch; SIGTERM stalls past deadline.
   The reliability core (crash + stall). Risk: stall detection without false
   positives.
5. **`mc fanout status`** — `low-medium`. Readable table + `--json`. The human's
   high-altitude overview without reading logs.
6. **gather trust-gate (two-layer)** — `medium`. Layer 1: merge proven phases +
   run integration suite on `wip/`. Layer 2: surface conflicts / red suite to the
   orchestrator with the seam; never auto-resolve. Exclude + list unproven phases
   with reasons; `--force` override. **►► functional spine.**
7. **`mc verify <session>`** — `high`. Adversarial read-only verifier per §10d
   (diff + original prompt + read-only sandbox, forbidden to write code) → sets
   `verified | rejected-by-verifier`. Closes the loop. Risk: new agent
   orchestration, read-only guarantee, cost.
8. **(later) resolution-agent affordance + `--resume`** — the orchestrator spawns
   a focused agent to resolve a specific seam; idempotent re-entry skips proven
   phases.

The spine is **functional** after drev 6 (fanout runs; gather gates on
self-report + integration suite) and **reliable** (adversarial trust) after
drev 7.

## Reuse (don't reinvent)

Dep-portal pattern (fanout/gather), `plan-parser.js`/`brief-template.js`, registry
API, `git.js` helpers, `mc gc`/orphan-daemon liveness helpers (for the stall
sweep), `worktreePath`/`paths.js`, gather's `gh` portal, the reconcile pattern for
PR status. The adapter contract (claude-code/codex) gains a headless capability —
mirroring the grounding-MVP adapter routing.

## Open questions (resolve per drev — don't guess)

- **Verify trigger:** auto after PR vs explicit `mc verify` (§10d leans "default
  off (cost)"). The one-rule trust model makes explicit-on-demand the natural fit.
- **Phase-timeout default:** what wall-clock is long enough to avoid false stalls
  but short enough to matter? Config-driven; pick a default in drev 4.
- **Cost guardrails (§10h):** upfront estimate + refuse under `--budget` without
  `--force` — fold into drev 3 or a follow-up?
