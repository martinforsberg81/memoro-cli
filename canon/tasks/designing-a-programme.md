---
name: designing-a-programme
description: Designing a programme in mc — its README, decisions, phases and build-ready goals. Use before first goals, phase changes or README rewrites.
---
# Designing a programme

A programme is thought through once, before its goals are written. Its design is read from one
page, `~/mc/programs/<programme>/README.md`; a session that must ask about an unplanned decision
means the programme was not designed. A recorded programme's document is written with
[writing a programme document](writing-a-programme-document.md): it binds what the user gets, how it looks and how one sees that it works; the construction is the builder's.

Every programme is a bounded implementation plan; enduring direction belongs to area pages.
A recorded programme uses [the programme document](references/programme-document.md);
a repair uses [the repair page](references/repair-page.md);
a programme without a record uses [the programme page](references/programme-readme.md).
Preserve a legacy page's held Aim in its area without changing its meaning. Finish active
work where it stands; archive as described below even if the enduring direction continues.

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
   A part that rests on a data layer (a dictionary, a reference table, an imported corpus, a
   catalogue) first shows that the layer carries it in production: the part's own lookups, at
   production size and in every language or tenant it serves, read with a sanctioned read-only
   tool and kept as evidence. A dev slice or fixture shows that the code works, not that the
   data does. A layer that does not yet carry the part is a prerequisite part or programme, not
   a risk note (Martin, 2026-11-23: French chapters were built against a dev slice of a few
   hundred words; production's French forms carried their pronouns, so no chapter could pass).
3. Resolve questions through [asking-martin](asking-martin.md). Record decisions in the README or goal. Put shared decisions in the technical standard and then in affected goals. Add needed standards within the app's direction.
4. Read the README against [the document structure](references/programme-document.md) (repairs use their short page). Follow [writing a programme document](writing-a-programme-document.md) through the desk's release of the ready order.

## Goal design

1. Once the desk sets a recorded order ready, the [runner](../../docs/technical/mc-run.md#the-cut-of-a-ready-order) cuts a build goal for each part that has none, from the part as it stands, with no session.
   Elsewhere settle decisions first, then cut fully investigated, measured and designed work into [goals](references/goal-design.md) headless sessions can build to the end.
2. Order by prerequisites and shared files. In an order a part waits for the part before it unless it holds the line `In parallel with the previous part.`, and ready writes the record from that. A programme whose record states its phases and has no order runs independent phases side by side: state a prerequisite with `mc programs after`. Elsewhere independent goals share a phase and dependent goals go later. In both a prerequisite is a phase dependency, never a note.
3. Move every complete goal to `build`; a draft is never started. A consumer needing a producer
   goes to `build` in a dependent phase. A goal that would consume what its own change lands is two goals ([writing a goal](writing-a-goal.md)).

## When a goal lands

The programme's last goal, Documentation, writes landed functionality to `docs/technical/`.
Remove landed sections from README. The runner archives a programme with a valid record once
every goal is merged or dropped; otherwise use the supported manual archive route.

## Faithful scope correction and handoff

Investigate until facts and remaining uncertainty are established. Separate technical gaps planning can resolve from what [asking-martin](asking-martin.md) names as his; the rest is decided and recorded. On clarification, amend the README/design, standards, briefs and criteria consistently; change only clarified scope and preserve other requirements/prerequisites unless Martin changes them. Deferring consumer features does not imply deferring provider, data or DPA prerequisites. Before handoff reconcile README, briefs, phases and actual stages; name remaining gaps. Do not hand unresolved prerequisites to build with a ceremonial LOG.md hold.
