section: Added

- **`mc plan <programme> --archive` ends a programme.** `mc run` archived a
  project the round its plan said done, and nothing ever removed the
  programme above it: `docs/project/<programme>/` stayed on main and
  `~/mc/plan/<programme>/` kept its worktrees on `plan/<programme>`. Now,
  typed and never triggered: refused with every reason while a plan under the
  programme is on main or releasing its planning session would keep anything;
  otherwise the directory leaves main in a docs-only PR landed through
  `mc merge --docs`, with one `project_log.md` row for the programme (project
  `-`, outcome `closed`), and only then is the planning session released.
  `docs/project/README.md`, `project_log.md` and `docs/technical/mc-plan.md`
  say so; the README no longer says a planning session is never archived.
