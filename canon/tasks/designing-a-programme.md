---
name: designing-a-programme
description: Designing a programme in mc — its README, decisions, phases and build-ready goals. Use before first goals, phase changes or README rewrites.
---
# Designing a programme

A programme is thought through once, before its goals are written. Its design
is read from one page, `~/mc/programs/<programme>/README.md`; a session that must stop and ask
about an unplanned decision means the programme was not designed.

## Files

- `README.md` — [the programme page](references/programme-readme.md): aim,
  status, phases, Martin-only choices and pointers. Read first; update *Now* at
  every plan session's end.
- `goals/<goal>/` — goal briefs written with [writing-a-goal](writing-a-goal.md);
  the README does not repeat them.
- `proposals/` and `proposals/archive/` — findings and dispositions
  ([proposals](proposals.md)).
- `docs/project/<programme>/rulings.md` — programme-only decisions. Cross-
  programme standards go in `docs/technical/`; the README points to them.
- `evidence/<date>-<slug>/` — measured evidence, linked from the README.
  No `PLAN.md`, `decisions/` or second plan format.

## Design, in order

1. Define the aim and measurable meaning of better/done.
2. Read the affected code, technical standards, rulings and proposals; design
   claims cite files actually opened.
3. Resolve every product/policy choice and exception with Martin (2–4 options,
   tradeoffs, recommendation). Record the answer in the ruling or technical
   standard, then in affected goals. Add a needed technical standard within the
   app's direction. No goal is written with its decision still open.
4. Cut work into goals buildable start to finish by headless sessions. Do
   investigation, measurement and design before the cut, not as the goal's first
   task ([goal design](references/goal-design.md)).
5. Order by prerequisites and shared files. Independent goals share a phase;
   dependent goals go later. A prerequisite is a phase dependency, never a note.
6. Move every complete goal to `build` immediately in its assigned phase,
   including goals waiting for earlier phases. `draft` means an unfinished brief,
   never a parking queue.
7. Write/read back the README as a headless session will; each goal stands on
   a decision and prerequisite the design holds.

## Faithful scope correction and handoff

Investigate until relevant facts and remaining uncertainty are established.
Separate facts/technical gaps planning can resolve from product or policy
choices only Martin decides. Ask only a remaining concrete design choice, with
evidence, alternatives/tradeoffs and a recommendation. On clarification, amend
the affected README/design, standards, goal briefs and criteria consistently;
change only clarified scope and preserve other requirements/prerequisites unless
Martin changes them. Deferring consumer features does not imply deferring
provider, data or DPA prerequisites. Before handoff reconcile README, briefs,
phases and actual stages; name remaining gaps. Do not hand unresolved planning
prerequisites to build with a ceremonial LOG.md hold.

A runner-assigned plan completes only its selected draft under the same rules;
see [the plan role](../roles/plan-session.md) and mc-goals.md, Next draft planning.
