section: Changed

- **The role instructions are shorter, and say when work goes to the runner.**
  `_common.md`, `_plan-writing.md`, `plan.md`, `brief.md` and `step.md` keep
  their rules and lose their prose: a step session's instructions go from
  10.2k to 4.4k characters, the brief's from 9.5k to 7.1k with the new passage
  included. A new shared passage, `canon/roles/_session-work.md`, included by the
  planning session and the brief, says what the runner gets — only work a
  headless session can build start to finish, with nothing for Martin to look
  at between steps — and that review of code, structure, UI or design,
  investigation, and anything gated on Martin's act is done in the session
  instead. It also gives that in-session work a fixed route: a branch from
  `origin/main` not named after a project, review points shown to Martin
  before building past them, `mc gate` / `mc publish` / `mc merge`, one open
  PR carrying work that spans sessions, and no `PLAN.json` for it (Martin,
  2026-10-06: "Det som läggs till runner ska vara färdigt och klart att kunna
  köras autonomt.").
