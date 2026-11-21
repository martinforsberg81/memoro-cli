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
Finish active work where it stands; archive it even if the enduring direction continues.
Use the supported manual route without a record, or the valid-record route when already established.

## Files

- `README.md` — the working document; read first. The document reference owns its headings and part entries.
- `goals/<goal>/` — goal briefs written with [writing-a-goal](writing-a-goal.md); README does not repeat them.
- No `proposals/`: findings wait in their area, and the document names those it takes in ([proposals](proposals.md)).
- `docs/technical/` (memoro, memoro-cli) — what runs; README points to it. No session writes `docs/project/`.
- `evidence/<date>-<slug>/` — measured evidence linked from README. No `PLAN.md`, `decisions/` or second plan format.

## Programme design

1. Define what the implementation plan delivers and its end; point to its
   area's enduring direction and, where applicable, the horizon it serves.
2. Read affected code, technical standards, programme README and the areas' proposals; design claims cite files actually opened.
3. Resolve questions through [asking-martin](asking-martin.md). Record decisions in the README or goal. Put shared decisions in the technical standard and then in affected goals. Add needed standards within the app's direction.
4. Read the README against [the document structure](references/programme-document.md) (repairs use their short page). Follow [writing a programme document](writing-a-programme-document.md) through the desk's release of the ready order.

## Goal design

1. For a recorded desk order, start the cut once the desk sets it ready. Cut fully investigated, measured and designed work into [goals](references/goal-design.md) headless sessions can build to the end. Settle decisions before writing the goal.
2. Order by prerequisites and shared files. A programme whose record states its phases runs independent phases side by side: state a prerequisite, shared files included, with `mc programs after`. Elsewhere independent goals share a phase and dependent goals go later. In both a prerequisite is a phase dependency, never a note.
3. Move every complete goal to `build`; a draft is never started. A consumer needing a producer
   goes to `build` in a dependent phase, as [the plan role](../roles/plan-session.md) says.

## When a goal lands

Write landed functionality to `docs/technical/`. Each goal writes what it made true as it
lands. The runner archives a programme with a valid record once every goal is
merged or dropped; otherwise use the supported manual archive route.
Landed sections leave the README.

## Faithful scope correction and handoff

Investigate until facts and remaining uncertainty are established. Separate technical gaps planning can resolve from what [asking-martin](asking-martin.md) names as his; the rest is decided and recorded. On clarification, amend the README/design, standards, briefs and criteria consistently; change only clarified scope and preserve other requirements/prerequisites unless Martin changes them. Deferring consumer features does not imply deferring provider, data or DPA prerequisites. Before handoff reconcile README, briefs, phases and actual stages; name remaining gaps. Do not hand unresolved prerequisites to build with a ceremonial LOG.md hold.

The runner's programme planning turn cuts a ready order into goals in build under the same rules; see [the plan role](../roles/plan-session.md) and mc-run.md, Programme planning turn.
