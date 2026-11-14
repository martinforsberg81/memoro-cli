---
name: designing-a-programme
description: Designing a programme in mc — its README, decisions, phases and build-ready goals. Use before first goals, phase changes or README rewrites.
---
# Designing a programme

A programme is thought through once, before its goals are written. Its design is read from one
page, `~/mc/programs/<programme>/README.md`; a session that must ask about an unplanned decision
means the programme was not designed.

## Files

- `README.md` — [the programme page](references/programme-readme.md): aim, measures, gap, next
  horizon, phases, Martin-only choices and pointers. Read first; keep its gap current each session.
- `goals/<goal>/` — goal briefs written with [writing-a-goal](writing-a-goal.md); README does not
  repeat them.
- `proposals/` and `proposals/archive/` — findings and dispositions ([proposals](proposals.md)).
- `docs/technical/` (memoro, memoro-cli) — what runs; README points to it. No session writes
  `docs/project/`.
- `evidence/<date>-<slug>/` — measured evidence linked from README. No `PLAN.md`, `decisions/` or
  second plan format.

## Design, in order

1. Define the aim as the enduring state the area strives toward for its user: what they can do and
   rely on when it is as good as it can be. It is not work, has no end when goals land, and changes
   only with Martin. Define three to five observable or countable progress measures, each with its
   first reading and date, or say what would give a reading.
2. Read affected code, technical standards, programme README and proposals; design claims cite files actually opened.
3. Resolve questions through [asking-martin](asking-martin.md): technical by the session,
   product/reserved by Martin. Record decisions in the README or goal, or in the technical standard
   if it reaches beyond the programme, then in affected goals. Add needed standards within the app's
   direction. No goal is written with a decision still open.
4. Cut work into goals buildable start to finish by headless sessions. Investigate, measure and design before the cut, not as
   the goal's first task ([goal design](references/goal-design.md)).
5. Order by prerequisites and shared files: independent goals share a phase; dependent goals go later. A prerequisite is a phase dependency, never a note.
6. Move every complete goal to `build` in its assigned phase, including those waiting for earlier
   phases. `draft` means an unfinished brief, never a parking queue.
7. Write/read back the README as a headless session will; each goal stands on the design's decisions and prerequisites, and landed sections leave it.

## When a goal lands

The plan session (or session that takes the landing) rereads measures, rewrites the dated Gap largest-first, and writes a new
horizon when the current one is reached. Landed work is in `mc goal list` and `docs/technical/`, not Gap. Archive only when
Martin says the aim is over or has moved to another programme, never because its goals are done.

## Faithful scope correction and handoff

Investigate until facts and remaining uncertainty are established. Separate technical gaps planning
can resolve from product or policy choices only Martin decides. Ask Martin only a remaining product
choice or reserved act, with evidence, alternatives/tradeoffs and a recommendation. On clarification,
amend the README/design, standards, briefs and criteria consistently; change only clarified scope
and preserve other requirements/prerequisites unless Martin changes them. Deferring consumer features
does not imply deferring provider, data or DPA prerequisites. Before handoff reconcile README,
briefs, phases and actual stages; name remaining gaps. Do not hand unresolved prerequisites to build
with a ceremonial LOG.md hold.

A runner-assigned plan completes only its selected draft under the same rules;
see [the plan role](../roles/plan-session.md) and mc-goals.md, Next draft planning.
