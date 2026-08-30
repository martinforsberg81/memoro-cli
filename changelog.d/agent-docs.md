section: Changed

- **The coding-agent protocol describes the product that exists.** It opened
  with "`mc` is a minimal grounded coordinator runtime, not a project-management
  system and not an agent runner" — written before `mc plan`, `mc run` and
  `mc brief`, and false in every clause. It now says what mc is, names the
  71 % of `src/` that no verb reaches and the plan removing it, and carries a
  *How work is organized* section: plans at
  `docs/project/<programme>/<project>/PLAN.md`, decisions answered in
  `mc brief`, workareas owned by mc. The normative section "Validation is
  suspended" — *"do not run `npm test` … as a condition of merging"* — is
  replaced by *Validation*: the suite is the merge gate, `mc merge` cannot land
  a red one, and the one place that is still ungated (`mc run`'s own
  `mergePr`) is named rather than left to be discovered.
