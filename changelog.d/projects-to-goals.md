section: Changed

- **Projects become goals.** `mc goal from-project <programme>/<project>`
  turns a live project's steps that are not done into goals, `<project>-<n>`,
  each after the one before; a branch-flow project becomes one goal on the
  project's branch. A finished project is refused, and so is a second run.
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
