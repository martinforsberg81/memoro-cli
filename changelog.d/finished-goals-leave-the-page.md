section: Changed

- **Finished goals leave the page, and the runner archives them at its next
  pass.** A done or dropped goal is no longer held for 24 hours before it is
  archived (`ARCHIVE_HOLD_MS` is gone): the runner archives it at its next pass,
  by the same safety checks, and leaves a goal a live session owns for the pass
  after the session ends. The page's PROGRAMMES draws no finished goal but one
  still at work; a programme heading says `· n done`, a phase with nothing
  drawn is not drawn, and a programme with nothing to draw is its heading
  alone. A malformed goal, a finished goal the runner refused to archive
  (`not archived — <why>`) and a finished goal with an open pull request go
  under NEEDS ATTENTION, in both views. `mc goal archive --all` and the page
  key `c` (or `clear`) archive every safe finished goal and name each refusal;
  every form of the verb refuses a goal a live session owns. `mc --json` keeps
  every key and adds `finished` to a programme and `archive_refused` to a goal.
