# docs/project — active plan work in memoro-cli

Same convention as memoro's `docs/project/README.md`: `docs/project/<programme>/<project>/`,
where `<project>` is the mc workarea name and each project directory holds a
`PLAN.md` the runner can act on. `PLAN.md` frontmatter: `status`
(ready | waiting-decision | blocked | done), `next` (one line with its own
"done when"), `budget`, `needs`. Sections: Goal · Success criteria · Contract ·
Steps · What the code taught us · Documents.

There is one programme here, `mc`. mc is built only for memoro me (D-0205);
projects that do not serve that do not belong under it.

Close-out: remove the project directory, add a row to `project_log.md`, and
update the technical documentation to describe what now exists.
