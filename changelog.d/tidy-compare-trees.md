section: Added

- **`mc tidy` removes stale `mc shot --compare` trees (rule C).** A tree
  under `~/.memoro/mc/compare/` goes once it has been unused for a day and
  no dev server stands in it. It is removed with `git worktree remove`
  (no `--force`) in the repository that owns it, following tidy's list,
  re-check and `--apply` steps. `compareTree` now touches a tree's directory
  when it reuses it, so the directory's mtime records its last use. Before,
  only `mc shot --compare` itself pruned these trees, by creation time, and
  only when it made a new one.
