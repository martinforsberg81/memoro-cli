section: Added

- **`mc shot dev <target> --compare <ref>`** pictures and measures the same
  surface on this worktree and on `<ref>` in one call. The ref gets its own
  detached worktree under `~/.memoro/mc/compare/` and its own server; both
  captures use this tree's request and script. It prints both PNG paths, then
  one `diff` line per measured value that moved (`<ref> → <here>`), or that the
  numbers are the same; `--json` carries both results and the diff.
