---
name: designing-a-programme
description: Designing a programme in mc — its README and files, the decisions settled with Martin before its goals are written, and how the goals are cut into phases and set in build. Use before a programme's first goals, when reordering goals by phase, and when a programme's README is written or rewritten.
---
# Designing a programme

A programme is thought through once, before its goals are written: a goal
session that has to stop and ask is a programme that was not designed. The
design is read back from one page, `~/mc/programs/<programme>/README.md`.

## The files

- `README.md` — [the programme page](references/programme-readme.md): aim,
  where it stands, phases, what in it only Martin decides, and pointers.
  Read first by every session in the programme; *Now* is brought up to date
  at the end of each plan session.
- `goals/<goal>/` — the goals, written with the `mc goal` verbs
  ([writing-a-goal](writing-a-goal.md)); the README never repeats them.
- `proposals/` and `proposals/archive/` — findings waiting for the plan
  session, and what became of each ([proposals](proposals.md)).
- Rulings live in the repository the programme changes,
  `docs/project/<programme>/rulings.md`: programme-local decisions, cited by
  name. A decision that reaches other programmes goes to `docs/technical/`
  (all-sessions, Decided standards). The README points, and holds no copy.
- `evidence/<date>-<slug>/` when a design rests on measurements, pointed at
  from the page. Nothing else: no PLAN.md, no `decisions/`, no second format.

## Designing, in order

1. **The aim.** One paragraph, and what *better* or *done* means in lines a
   session can measure its work against. Not a feature list.
2. **Read before deciding.** The code the programme will change, the
   `docs/technical/` standards it touches, its rulings and its proposals.
   Every claim in the design names a file that was opened.
3. **Collect the decisions.** Every product or policy choice the work will
   meet (what users see or are promised, cost, privacy, the test strategy)
   and every exception to a decided standard, each with 2–4 options, costs
   and a recommendation. Put the whole list to Martin in one sitting
   ([asking-martin](asking-martin.md)); write each answer into the rulings
   or `docs/technical/`, then into the goals that act on it. A technical
   standard the programme needs and none holds is written into
   `docs/technical/` here. No goal is written while one of its decisions is open.
4. **Cut the work into goals**, each buildable start to finish by a headless
   session ([goal design](references/goal-design.md)). Investigation,
   measurement and design happen here, before the cut, never as a goal's
   first task.
5. **Order the goals in phases.** Goals that can run side by side, with no
   shared files and no result one needs from another, share a phase. A goal
   that needs another's result, or edits what another edits, is in the phase
   after it. Phases are the only ordering; a prerequisite is never a note.
6. **Set every finished goal in `build` at once**, in its phase: the phase
   holds it until the one before is done, and the runner takes it the moment
   the phase opens. `draft` is a brief still being written, never a parking
   place for a finished one.
7. **Write the README**, then read the programme back as a headless session
   will: every goal stands on an answer the design holds.

A changed aim, a moved phase or a decision found missing mid-build goes to
this page and the rulings first, then into the goals with the verbs.
