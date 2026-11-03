section: Changed

- **The runner archives a finished goal after 24 hours.** A goal that has been
  `done` or `dropped` for 24 hours leaves `mc goal list` in the runner's chore,
  as a project under `~/mc/programs/` does, on the same hold (`ARCHIVE_HOLD_MS`).
  The time counts from the log entry that set the status. It goes by the road
  `mc goal archive` takes, and a refusal of that verb (an open pull request,
  uncommitted changes, a goal that starts after it, a dropped branch's unpushed
  commits) keeps the goal in place and is written once into its LOG.md.
- **`mc goal after <programme>/<goal> none` clears what a goal waits on**, as
  the help has always said; it was refused as a goal name.
