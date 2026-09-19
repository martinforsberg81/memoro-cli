section: Changed

- **The page is in a new order, and shorter.** PROGRAMMES, WORK, HELPER,
  BRIEF, NEXT, RUNNER, MERGES, DEPLOY, and one line for mc itself. INTAKE is
  gone as a section: a digest is one row under HELPER — new errors, how many
  loud, how old, and the loudest message — and the proposals are one line under
  BRIEF, with the blocked rollup and the finished-blocker fault that stood
  under NEXT. DEPLOY is the production line that stood under RUNNER's day.
- **NEXT is one list.** Repository, project, `step n/m`, the step's title; four
  rows per repository at the most, so a repository with one runnable project
  keeps its row. The heading is how many are runnable and nothing else — what
  was skipped and why is in `mc --json`.
- **RUNNER's lanes are `lane 1` … `lane N`**, as many as the runner can fill
  (`mc run lanes`' total), not one per repository lane. A running row is the
  step's repository, the project, `step 4/6`, the clock, then tool, model,
  advisor and check-ins.
- **The last line is MC**: the version, whether `origin/main` has code the
  runner is not running (`update available … mc run --update`), whether an
  update has been asked for and since when, how long the runner has been up and
  on which commit. `mc run` writes that commit into `runner.json`. The line
  about the PR cache's age is gone from the page; `--json` has it.

section: Fixed

- **A project's status changed and its row did not.** On a page taller than
  the terminal PROGRAMMES scrolls off the top, where the live loop cannot
  write, so a row said `running` until a key was pressed. A frame whose
  project facts differ from the last one's is now printed again whole when the
  top of the page is out of reach.
