section: Added

- **A session that finds its goal wrong reports it, and the goal stops.**
  `mc goal defect --part "…" --found "…"` lets a build, review or finish
  session, in its own stage, append one entry with status `Martin` and the
  first line `goal defect: <part> — <found>`; it asks nobody and offers no
  options. The runner starts no further session on the goal, and the desk
  opens one item labelled by that line (`deskItemQuestion` now takes the
  `Martin` entry of the minute, so another entry in the same minute no longer
  hides it). A build that makes no progress — a log entry, status unchanged,
  no criterion met, every head unchanged — three sessions in a row is
  stopped by the runner with one `Martin` entry beginning `no progress:`;
  a commit, a criterion met or any stage or status change starts the count
  again, and three silent sessions still go to `finish`. The build, review,
  finish, plan, decision and desk-prepare roles, `canon/verbs/goal.md` and the
  technical pages say what a goal defect is and how it is decided. Before, such
  a session set Martin directly or asked with options, and a goal whose text was
  wrong started session after session that could not make progress.
