# docs/project — active plan work in memoro-cli

Plan work here is handled exactly as it is in memoro: `docs/project/<programme>/<project>/`,
where `<project>` is the mc workarea name and each project directory holds a
`PLAN.md` the runner can act on. The section below is the same text as memoro's
`docs/project/README.md` — one shape, both repositories, no local dialect.

There is one programme here, `mc`. mc is built only for memoro me (D-0205);
projects that do not serve that do not belong under it.

## What a PLAN.md is

A plan is instructions for a headless session that has read nothing else, with
nobody watching. `mc run` hands it the whole file, it does the one step named in
`next:`, and it opens a PR. That is the whole test of a plan: can that session
do this step, and know when it is finished?

It follows that the plan is written *before* the work and holds every step, not
just the next one. A step session never writes a coming step (see *Who writes
what* below), so a step nobody has specified is a step nobody can run.

### The shape

Frontmatter — `status` (`ready` | `waiting-decision` | `blocked` | `done`),
`next`, `budget`, `needs` — is the runner's contract, and `next` is one line
naming the step *and its "done when"*, because that sentence is the session's
success criterion for its own PR.

Then, in this order:

- **Goal** — what is true when the project is done.
- **Success criteria** — the checklist that closes the project, each with how it
  is checked.
- **Contract** — the boundary: what may not change without Martin, and what is
  **out of scope**, named. A boundary nobody wrote down is a boundary every
  session redraws.
- **Steps** — done, current, remaining. Every remaining step carries its own
  one-line "done when".
- **What the code taught us** — what turned out to be different from what the
  plan assumed. A step session writes here.
- **Documents** — links.

### How long, and what earns space

Length follows the work. A step whose instruction needs three pages of
interface, order and edge cases gets three pages — the under-specified step is
the expensive one, because the session fills the gap with a guess and the plan
cannot tell it not to. What earns space is what the next session cannot see from
the code in front of it: the trap, the missing mechanism, the cost that is not
in the diff, the order that matters. Link rather than copy.

What does not earn space is the case for the plan. Nobody reads a plan to be
convinced of it; they read it to do the work.

Every claim in a plan is acted on without being checked, so name the file that
carries it, and only if you opened that file. A plausible-sounding claim from a
grep costs more than saying nothing, because it becomes the next session's
premise.

### A criterion says how it is checked

"Done" is not a judgement the session makes about its own work. Each criterion
names the check: the assertion, the query, the measurement — and, for anything
with a surface, the measurement *in the running app*, because a green gate is
not evidence that a user can see the change. A criterion no session can check
the same way twice is not a criterion.

### Who writes what

The planning session (`mc plan`, Martin at the terminal) writes the plan.

A step session edits four things and nothing else: the marker on the step it
just ran, `next:`, the success criteria it actually met, and *What the code
taught us*. It **never rewrites a coming step, adds one, or removes one**, and
it never touches Goal, Contract, scope or the criteria themselves — the plan it
was handed is the plan Martin agreed to. When the code says a coming step is
wrong, that is not a revision the step makes: it sets `status:
waiting-decision`, writes the decision at the workarea root with one
recommendation, opens its PR and stops.

A plan comes back to the runner by being `ready`, and by nothing else.

## Citing a decision

Decisions are raised as files under a `decisions/` directory at the **`mc`
workarea root**. That directory is not part of this repository and does not
survive the workarea, so a document here cites a decision **by name, never by
path** — `` [`mc-1`](mc/rulings.md) ``, not
`` `~/mc/mc-utredning/decisions/mc-1.md` ``. A path out of the repository is a
citation no reader with a checkout can follow.

When a decision is answered, carry the ruling into [`mc/rulings.md`](mc/rulings.md)
before the file is retired: the question, the options, Martin's answer quoted
verbatim, and the plan that builds it. `mc brief --collect` deletes an answered
file once every plan that owns it has left `waiting-decision`, and
`~/mc/*/decisions/` is outside git — so the carry happens first, not after.

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
removed by a machine — it is listed in `~/mc/intake/unplanned-workareas.md`
and on the page, for Martin.
