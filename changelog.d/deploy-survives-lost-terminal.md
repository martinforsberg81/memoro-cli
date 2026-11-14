section: Fixed

- **A deploy survives a lost terminal.** `mc deploy` runs everything before its
  question — the full run and the suites — in a detached, recorded preparation
  (`~/mc/runner/deploy-prepare.json`); the terminal and the page only watch it.
  Running `mc deploy` again, or choosing deploy on the page, joins the
  preparation of the same sha (follows it, or goes straight to the question
  when it finished green; a moved main starts a new one, said in one line).
  A full run of a sha is never started twice: `mc deploy`, `mc test <repo>
  --full` and the daily run claim it first and follow one in flight, and
  `mc test <repo> --full` no longer stops at `lease` when the merger holds the
  repository. The page shows a preparation in flight with its stage, and a gate
  round whose process died without an end record as interrupted.
