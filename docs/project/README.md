# docs/project — active plan work in memoro-cli

Same convention as memoro's `docs/project/README.md`: `docs/project/<programme>/<project>/`,
where `<project>` is the mc workarea name and each project directory holds a
`PLAN.md` the runner can act on. `PLAN.md` frontmatter: `status`
(ready | waiting-decision | blocked | done), `next` (one line with its own
"done when"), `budget`, `needs`. Sections: Goal · Success criteria · Contract ·
Steps · What the code taught us · Documents.

There is one programme here, `mc`. mc is built only for memoro me (D-0205);
projects that do not serve that do not belong under it.

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
