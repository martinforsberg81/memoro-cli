section: Changed

- **A project's state lives in the register, not in the plan on main.** One
  file per project under `~/mc/runner/projects/`, holding per step where it
  stands — `ready`, `running` (with the session's pid), `done` (with its
  pull request and the commit main stands at), `failed` (with the reason)
  or `blocked` — written by the runner and by `mc step`, never through a
  pull request (ruling 21). The plan on `main` still says what a step *is*;
  readers lay the register over it (`overlayPlans`), so the picker, the
  page, the brief and `mc status` read the same plan record with the
  register's word for its state. A plan the register has never seen is
  seeded from its own file once. A step the runner could not start is
  `blocked` in the register rather than in a docs-only pull request the
  runner opened and landed; a step whose session ended without landing is
  `failed` with the gate's reason, or its exit, and is never picked again
  until `mc step ready`. A `running` step whose session is gone is failed on
  the next reading of the world. The session gets `MC_STEP=<project>:<index>`
  in its environment, so `mc step` inside it needs no argument.
- **`mc step`** — where each step of a project stands, and the four moves:
  `failed --reason`, `blocked --on`, `ready`, `done`. `ready` is refused while
  the step's pull request is open.
