section: Fixed

- **Steps no longer strand themselves.** A blocked session opens no PR for
  its question (`canon/roles/step.md`), and `mc step ready` closes an open PR
  on the step's branch that changes no file, refusing by number one that
  does: such a placeholder kept the runner from starting settings-polish
  step 6 twice after its decision was ruled (#13442, #13599). `mc merge`
  books a PR on a step by name only for `<project>` or `<project>-<n>`, never
  on a `blocked` step, and says so when a branch named after a project is no
  step's (#13549 had closed photo-analysis's blocked close-out). The plan
  boundary judges the step the register names, not the plan's first
  unfinished one. A close-out — the last step, or one whose `done_when` asks
  for the steps `done` — waits for the steps before it to land instead of
  stacking on them.
