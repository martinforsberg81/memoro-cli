section: Changed

- **`mc gate` settles a red before it calls it the change's.** When a session's
  gate is red only in failed files, they run once more alone (one at a time, the
  same per-test limit), and those still red that the change does not touch run
  alone at the frozen base. Files green alone, or red the same way on main, are
  named on a `SETTLED` line and do not make the gate red. On 2026-11-07
  text/shared-content-pipeline's gate was red for about 126 load timeouts and
  then for 12 files that failed the same way on main; neither was the change's.
