section: Changed

- **PROJECTS is PROGRAMMES: one heading per programme, with room for its
  planning session.** The grouping was by repository, and a repository is not a
  unit of work — it is where the code happens to live. `msr-core` spans both
  and read as two unrelated blocks under two headings; `mc` and
  `docx-editing-surface` sat interleaved under one. A programme is the unit
  `mc plan` opens on and the thing several projects add up to, so it is the
  heading now, and the repository is a column on the project's own row.
  Each heading carries its **planning session**, open or not — that is the room
  `mc plan <programme>` fills, and a programme with none is one nobody is
  thinking about right now. A programme with no runnable plan under it is drawn
  all the same, and so is one that exists *only* as an open planning session:
  that is work on its way to having projects, and it was the one thing the page
  could not show.
- **A project's `●` means the runner has a step in flight on it, and nothing
  else.** It used to mean a live tmux area — somebody sitting in the folder —
  so one mark answered two questions at once. `mc work` and `mc run` know
  nothing about each other, and neither do their marks; sessions are WORK's.
- The name column loses the `programme/` prefix, which the heading above it now
  carries, and the status column loses ten of its seventeen columns: they were
  sized when `waiting-decision` existed, and `blocked` is seven. Both go to
  `next`, the one cell whose whole value is how much of the sentence survives.
- `--json` follows: `projects` is `programmes`, and a group is
  `{ programme, projects, repos, planning }`.
