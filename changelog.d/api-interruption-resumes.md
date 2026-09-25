section: Fixed

- **A step session the API ended is resumed where it stopped, not failed.**
  2026-09-13..25, ten step sessions ended on the API's word instead of their
  own: `Not logged in · Please run /login` (four, the same morning, after 44
  to 293 turns), the spend and rate limits (four), `API Error: 500` and
  `529 Overloaded` (two). claude marks every one `terminal_reason:
  "api_error"` under `subtype: "success"`, and the runner read none of them:
  the limit counted as a quota only in a session of one or two turns, and the
  rest were `failed` steps with their work left uncommitted in the worktree —
  which the next pick then refused as dirty. `apiInterruption` now reads the
  mark into `quota`, `login` or `server`; the lane waits it out (the quota's
  pause, the same pause for a lost login, five minutes for a server error) and
  launches `claude -p --resume <id>` in the same workarea with a message
  naming what the API said. The halves are one row, one stream and one
  register entry. Three resumes in a row, STOP or UPDATE during the wait, or a
  step the session already ended stop it, and the failed step's reason now
  carries the API's words.
