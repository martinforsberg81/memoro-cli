section: Removed

- **`mc plan` is gone: no plan session, no plan role.** The runner cuts a
  ready order into goals by code, so no session writes a goal any more, and
  the interactive entrance that was left is removed (Martin, 2026-11-21).
  `mc plan` is answered as an unknown command; `canon/roles/plan-session.md`,
  the `plan` role and its place in the server entrances are removed, and the
  page and `mc programs list` draw no plan session. What the plan role did with
  the `mc goal` and `mc programs` verbs a person and interactive Martin still
  do. The archive by hand moved: `mc plan <programme> --archive` is
  `mc programs archive <programme>`, for a person or interactive Martin on his
  word, with the same checks and the same output. A plan session still open,
  and a `plan/<programme>` worktree it left, are kept visible: the session is
  a stray under MAINTENANCE, and `mc tidy` releases the worktree by the rules
  it had. Old `runs.tsv` rows of kind `plan` are read as before.
