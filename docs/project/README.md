# docs/project — active plan work in memoro-cli

Plan work here is handled exactly as it is in memoro: `docs/project/<programme>/<project>/`,
where each project directory holds a `PLAN.json` the runner can act on. The
`<project>` name is what `mc run` will call that project's branch and its
workarea; the planning session chooses it and creates neither. The section
below is the same text as memoro's `docs/project/README.md` — one shape, both
repositories, no local dialect.

There is one programme here, `mc`. mc is built only for memoro me (D-0205);
projects that do not serve that do not belong under it.

## What a PLAN.json is

A plan is instructions for a headless session that has read nothing else, with
nobody watching. `mc run` hands it the step it is to do, and it opens a PR. That
is the whole test of a plan: can that session do this step, and know when it is
finished?

It is **one file**, `PLAN.json`, in the project directory — an overall part
first, then one entry per step carrying that step's instruction *and* its state.
It used to be prose with frontmatter, and the parts the runner depended on were
conventions nothing checked: a plan could be missing them and still be handed a
ninety-minute session, which then guessed. The shape is a schema now
(`src/mc/plan-schema.js` in memoro-cli), so a plan that cannot be run says so at
the door.

### The overall part

- `goal` — what is true when the project is done.
- `contract` — what may not change without Martin.
- `out_of_scope` — what this project does not do, named. A boundary nobody
  wrote down is one every session redraws.
- `success_criteria` — `{ met, criterion, check }`. The `check` is the half a
  criterion is usually missing: the assertion, the query, the measurement — and
  for anything with a surface, the measurement *in the running app*. "Done" is
  never the session's judgement of its own work.
- `documents` — `{ label, path }`.
- `runner` — optional: `tool`, `model`, `budget_minutes`. Only what the runner
  actually reads; there is no field here that nothing enforces.

### The steps

`steps[]` is an order, and it is written **before** the work — a step session
may not write one, so a step nobody specified is a step nobody can run. Each
carries:

- `title`, and `done_when` — the sentence the runner calls the session's success
  criterion for its own PR. Every step has one, finished ones included.
- `instruction` — an array of paragraphs. Length follows the work: a step
  needing three pages of interface, order and edge cases gets three pages,
  because the under-specified step is the expensive one. Paragraphs rather than
  one string so a diff stays line-oriented for whoever reads the PR.
- `status` — `ready`, `done`, `blocked` — with `pr` and `blocked_by`
  (`{ kind: "decision" | "project", name }`, required when stopped).
- `comments` — an array of paragraphs, possibly empty: whatever that step's
  session needs the next reader to know that the code in front of them does not
  show. This is where a session writes, and it is on the step rather than at the
  top of the plan on purpose. It was `what_the_code_taught_us`, a shared list of
  `{ title, body }` objects; on 2026-09-02 three sessions wrote the wrong shape
  into it, and because the shape is validated, one bad paragraph made the whole
  plan unreadable — `new-user`'s stayed unreadable on `origin/main` for a day,
  and the runner logged a skip line for it every round that nobody read
  (Martin, 2026-09-02: "Flytta in i steget: `steps[i].learned`", and the same
  evening: "den ska bli bara en 'comments' … det behövs någonstans att skriva
  kommentarer"). The name is plain on purpose: a field whose name is a doctrine
  is either left empty or filled with what it is not.

The plan has **no status of its own**: it is the state of the first step that is
not done, and a plan whose steps are all done is done. The runner looks at that
first unfinished step and no other — steps are an order, and skipping a stopped
one to reach a later `ready` step is how a plan gets half-built in an order
nobody chose.

In full, small:

```json
{
  "schema": "mc-plan",
  "version": 1,
  "goal": ["Project detail answers where a project stands."],
  "contract": ["Läget replaces project-timeline rather than joining it."],
  "out_of_scope": ["Trip detail, and every other entity detail surface."],
  "success_criteria": [
    { "met": false, "criterion": "The hero draws a visual object.",
      "check": "Seen on a project page in the running app, light and dark." }
  ],
  "documents": [{ "label": "Superseded", "path": "../../../plans/project-briefing-redesign.md" }],
  "steps": [
    { "title": "The purpose line", "status": "done",
      "done_when": "The description is edited in the hero.",
      "instruction": [], "comments": ["The hero hydrates twice: once on mount, once on theme."],
      "pr": 11085, "blocked_by": null },
    { "title": "The hero object", "status": "ready",
      "done_when": "A project page draws the object in light and in dark.",
      "instruction": ["Generate the light and dark siblings, register the token, wire the hero.",
                      "No entity hero draws one today: the render path swaps the icon ref, the entity path hydrates by writing it."],
      "pr": null, "blocked_by": null }
  ]
}
```

### What earns space

What the next session cannot see from the code in front of it: the trap, the
missing mechanism, the cost that is not in the diff, the order that matters.
Link rather than copy. What does not earn space is the case for the plan —
nobody reads a plan to be convinced of it; they read it to do the work.

Every claim in a plan is acted on without being checked, so name the file that
carries it, and only if you opened that file. A plausible-sounding claim from a
grep costs more than saying nothing, because it becomes the next session's
premise.

### Who writes what

A plan is written by a planning session: `mc plan <programme>`, Martin at the
terminal. It opens on a **programme**, not on one project — how many projects
come out of it, under what names, and by what route they reach `main` is worked
out in the session, not decided by the command that opens it.

**The brief writes plans too**, under exactly these rules, for the proposals
Martin decides there (`canon/roles/brief.md`). A decision taken at the brief
already carries the reading the plan needs, and opening a planning session to
retype it is a second session's worth of cost for nothing. What stays the
planning session's is thinking a programme through, and reading a plan a step
has asked for a review of — `plan-review` is not the brief's.

**A proposal that becomes a project is deleted when the project is created.**
Most projects start as a file in `~/mc/proposals/` — the helper's reading of a
digest, or a session's of the code — decided with Martin at the brief. The
session that writes the `PLAN.json` deletes the proposals it consumed, in the
same move, and names them in the pull request: they are not in this repository,
so the PR body is the only place that record can live. Whatever a proposal held
that the plan needs — the measurement, the file and line, the reason the fix is
that one — has to be **in the plan first**, because afterwards there is no other
copy. `~/mc/proposals/` holds what nobody has decided yet and only that; a file
left there after its project exists is a decision that gets taken twice.

**That session has no workarea and makes none.** It lives at
`~/mc/plan/<programme>/`, with a checkout of each repository on branch
`plan/<programme>` — mc's own directory, which `mc run` cannot see. What a
planning session and the runner share is a `PLAN.json` on `main`, and nothing
else; the `<project>` directory name is what the runner will call that
project's branch and its workarea when it first steps it.

A step session edits its own step's `status`, `pr` and `comments`, and `met` on
the criteria it actually met — the criterion and its check are Martin's words.
It **never writes the plan's steps** — not a new one, not a rewrite of one that
has not run, not a deletion — and never `goal`, `contract`, `out_of_scope`, or
the criteria themselves. This is checked rather than asked: the runner compares
the file before and after, and a session that touched anything else fails on the
way back in. Everything a session may write is inside `steps[index]` and `met`,
which is why that comparison is one skipped index and no shared field.

When the code says a coming step is wrong, that is not a revision the step
makes: the step goes `blocked` with `blocked_by` saying what the answer has to
be about, the question goes in the pull request with one recommendation, and
the session stops. A plan comes back to the runner by its first unfinished step
being `ready`, and by nothing else.

## Citing a decision

Decisions are raised as files under a `decisions/` directory at the root of the
session that raised them: `~/mc/<workarea>/decisions/` for a step session,
`~/mc/plan/<programme>/decisions/` for a planning one. Neither directory is
part of this repository and neither survives its session, so a document here
cites a decision **by name, never by path** — `` [`mc-1`](mc/rulings.md) ``,
not `` `~/mc/mc-utredning/decisions/mc-1.md` ``. A path out of the repository
is a citation no reader with a checkout can follow.

When a question is answered, carry the ruling into [`mc/rulings.md`](mc/rulings.md):
the question, the options, Martin's answer quoted verbatim, and the plan that
builds it. mc keeps no record of an answer — there is no decision file and no
answer line — so the plan and the ruling are the only two places it survives.
Carry it at the moment it is given.

The same rule covers any other working material a plan leans on. The programme's
design source, [`mc/utredning-2026-08-24.md`](mc/utredning-2026-08-24.md), was
cited by section number from four plans while living only in a workarea; that is
why it is in the repository.

This mirrors memoro's `docs/project/README.md` § *Citing a decision*.

Close-out: add a row to `project_log.md` and update the technical
documentation to describe what now exists. Removing the directory is not
yours to do — a plan that says `status: done` is archived by `mc run` in the
round it reads it: the directory goes, and the row is written for it if the
close-out step did not write one (`src/mc/archive-plan.js`).

Nor is removing the workarea. At the end of the round that archived the
plan, `mc run` closes every workarea whose plan said `done`, whose worktree
has no uncommitted change and whose last row in `runs.tsv` ends `merged`:
the worktree is handed back, the local branch deleted, and whatever the
folder kept beside its checkout moved to `~/mc/runner/log/closed/<name>/`
(`src/mc/close-workarea.js`). A workarea with no plan on main is never
removed by a machine — it is listed in `~/mc/runner/unplanned-workareas.md`
and on the page, for Martin.

None of that reaches a planning session. `~/mc/plan/<programme>/` holds no
top-level checkout, so neither `mc run`'s `workareas()` nor `mc status`'s
`areasWithCheckout()` can see what is under it: a planning session is never
archived, never closed, and never listed as a workarea without a plan.
