---
name: designing-a-programme
description: Designing a programme in mc — its README, decisions, phases and build-ready goals. Use before first goals, phase changes or README rewrites.
---
# Designing a programme

A programme is thought through once, before its goals are written. Its design is read from one
page, `~/mc/programs/<programme>/README.md`; a session that must ask about an unplanned decision
means the programme was not designed. A recorded programme's document is written with
[writing a programme document](writing-a-programme-document.md): it binds what the user gets, how it looks and how one sees that it works; the construction is the planner's and the builder's.

Every programme is a bounded implementation plan; enduring direction belongs to area pages.
A recorded programme uses [the programme document](references/programme-document.md);
a repair uses [the repair page](references/repair-page.md);
a programme without a record uses [the programme page](references/programme-readme.md).
For legacy pages, preserve the held Aim in the appropriate area without changing its meaning.
Finish active work where it stands; archive after write-back even if the enduring direction continues.
Use the supported manual route without a record, or the valid-record route when already established.

## Files

- `README.md` — the working document; read first. The document reference owns its headings and part entries.
- `goals/<goal>/` — goal briefs written with [writing-a-goal](writing-a-goal.md); README does not repeat them.
- No `proposals/`: findings wait in their area, and the document names those it takes in ([proposals](proposals.md)).
- `docs/technical/` (memoro, memoro-cli) — what runs; README points to it. No session writes
  `docs/project/`.
- `evidence/<date>-<slug>/` — measured evidence linked from README. No `PLAN.md`, `decisions/` or
  second plan format.

## Design, in order

1. Define what the implementation plan delivers and its end; point to its
   area's enduring direction and, where applicable, the horizon it serves.
2. Read affected code, technical standards, programme README and the areas' proposals; design claims cite files actually opened.
3. Resolve questions through [asking-martin](asking-martin.md). Record decisions in the README or goal, or in the technical standard
   if it reaches beyond the programme, then in affected goals. Add needed standards within the app's
   direction. No goal is written with a decision still open.
4. Cut work into goals buildable start to finish by headless sessions. Investigate, measure and design before the cut, not as
   the goal's first task ([goal design](references/goal-design.md)).
5. Order by prerequisites and shared files. A programme whose record states its phases runs independent phases side by side: state a prerequisite, shared files included, with `mc programs after`. Elsewhere independent goals share a phase and dependent goals go later. In both a prerequisite is a phase dependency, never a note.
6. Move a complete goal to `build` only with its acceptance procedure and setup verified.
   Keep a consumer needing a producer in draft in a dependent phase; use the plan role's
   next-draft procedure when evidence is missing or a relevant premise has changed.
7. Write and read back the README against [the document structure](references/programme-document.md)
   (repairs use their short page). A programme is written with Martin in a session, when he says it is ready the desk sets it ready, and the planner cuts goals from its README.
   Landed sections leave the README.

## When a goal lands

Write landed functionality to `docs/technical/`. When the work is finished,
archive the programme after write-back. Automatic archive requires a valid record
and the runner's safety checks; otherwise use the supported manual archive route.

## Faithful scope correction and handoff

Investigate until facts and remaining uncertainty are established. Separate technical gaps planning can resolve from what [asking-martin](asking-martin.md) names as his; the rest is decided and recorded. On clarification, amend the README/design, standards, briefs and criteria consistently; change only clarified scope and preserve other requirements/prerequisites unless Martin changes them. Deferring consumer features does not imply deferring provider, data or DPA prerequisites. Before handoff reconcile README, briefs, phases and actual stages; name remaining gaps. Do not hand unresolved prerequisites to build with a ceremonial LOG.md hold.

A runner-assigned plan completes only its selected draft under the same rules; see [the plan role](../roles/plan-session.md) and mc-goals.md, Next draft planning.
