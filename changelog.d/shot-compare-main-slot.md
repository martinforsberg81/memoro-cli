section: Changed

- `mc shot dev --compare` now compares against the shared checkout's MAIN server
  by default, or an existing registered memoro worktree by path or name. Other
  values are refused before starting a server; comparisons no longer create
  compare worktrees, and `mc tidy` no longer has rule C.
