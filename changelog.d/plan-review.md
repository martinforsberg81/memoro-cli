section: Added

- **A goal is read by a fresh session before it reaches build.** `mc goal
  stage … build` (and `log --stage`) now refuses a draft goal that is not
  complete — an empty outcome, no change item, no criterion, a rule area
  without a stand, a stand whose standard is not on main — and one nobody has
  read. `mc goal plan-review <p>/<g> [--avoid <tool>:<model>]` has a session on
  another model read it against seven questions and write `PLAN-REVIEW.md`;
  after two readings the plan decides with `--reason`. `mc goal show` says
  where the review stands, `mc goal areas` proposes a stand, and `mc goal new
  --stage build` is refused.
