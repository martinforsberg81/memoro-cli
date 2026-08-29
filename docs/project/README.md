# docs/project — active plan work in memoro-cli

Same convention as memoro's `docs/project/README.md`: `docs/project/<programme>/<project>/`,
where `<project>` is the mc workarea name and each project directory holds a
`PLAN.md` the runner can act on. `PLAN.md` frontmatter: `status`
(ready | waiting-decision | blocked | done), `next` (one line with its own
"done when"), `budget`, `needs`. Sections: Goal · Success criteria · Contract ·
Steps · What the code taught us · Documents.

There is one programme here, `mc`. mc is built only for memoro me (D-0205);
projects that do not serve that do not belong under it.

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
