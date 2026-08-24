section: Changed

- **`mc suite run` refuses a worktree without its dependency tree
  (D-0152).** A suite without `node_modules` does not fail — it runs the
  files that happen to need nothing and reports fewer failures: greener
  than the truth, and green is the one direction nobody reviews. Four of
  twenty-seven worktrees stood like that for nine days, and the session
  that found its own tree missing called its escape "luck, not a
  guardrail" (2026-08-24). The gate has refused this since D-0152 (its
  `dependencies` stop); `mc suite run` — the door everyone was told to
  use (D-0176) — now applies the same rule to every repo and every
  caller: a working directory that declares dependencies and has no
  `node_modules` is refused before the right is taken or anything runs,
  with exit 2 (never a test's exit), REFUSED as the first word, and "the
  suite never ran" on the first line so it cannot be read as a red run.
  The way forward is in the message: `npm ci`, or link from a sibling
  worktree with the same lockfile. Presence only, by choice: a lockfile
  staleness check is not cheap to make honest, and presence takes the
  observed damage.
