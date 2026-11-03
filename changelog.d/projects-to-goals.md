section: Changed

- **Projects become goals.** `mc goal from-project <programme>/<project>`
  turns a live project's steps that are not done into goals, `<project>-<n>`,
  each one phase after the one before, from the phase the programme is in; a
  built step with its pull request is `review · ready`, a blocked one `build ·
  blocked`, the rest `build · ready`. A branch-flow project becomes one goal on
  the project's branch. A finished project is refused, and so is a second run.
- **`mc project` and `mc step` are gone.** Both answer that projects are goals
  now and name `mc goal from-project`; the runner starts no project step.
- **Canon says goal.** The project and step verb files, the project and worker
  parts of the build and review roles, and the `writing-a-plan` skill are
  removed; a `writing-a-goal` skill replaces it. The hook guards `GOAL.json`
  instead of the plan files, and `mc plan`'s picker no longer counts projects.
- **No step at the merge door.** `mc merge`, `mc merge --docs`, `mc merge
  --admin` and `mc publish` no longer check or book a project step: the
  criteria door for a plan's last step, the branch flow's `built` booking and
  the gate's plan-file refusal (`plan-in-repo`) are removed. The runner lock
  moved to `runner-lock.js`.
- **The page draws goals only.** PROGRAMMES has no project rows, counts or
  blocked rollup; SESSIONS no queued count; MERGES no `fix` row; the grid's
  palette has no `project`, `step` or `fix` kind. A goal's pull request is
  found by `goal/<goal>` or by the ones GOAL.json says carry it, and the live
  page redraws when a goal's stage changes.
