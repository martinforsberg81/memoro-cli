section: Changed

- **A goal is done when its work has landed, from any branch.** `mc publish`
  writes the pull request it opens into the goal's new `prs` front-matter line
  (`--goal`, `MC_GOAL`, the goal worktree it stands in, or a `goal/<g>`
  branch), and `mc goal pr` adds one by hand. The merger answers a landed or
  red pull request in the goal whose `prs` name it, whoever queued it, and
  sets `done` only when the goal carries no other pull request; the runner
  sets `done` within five minutes once every one is merged or closed, however
  it landed. Until now only the goal's own `goal/<g>` pull request, queued by
  its review, set `done`, and `ios-release/mc-asc` — six pull requests in two
  repositories — waited for a person to close it.
- **`mc goal drop` and the `dropped` status.** A goal let go is no longer set
  `done`, which read as landed and would have started a goal after it.
- **`mc goal archive`** moves a done or dropped goal to `goals/.archive/`,
  removes its worktrees and branch through git, and writes a row in
  `goals/goal_log.md`; it refuses open pull requests, uncommitted changes,
  unpushed commits of a dropped goal, and a goal another still starts after.
- `mc goal list` no longer shows the last `Nästa:` of a finished goal.
