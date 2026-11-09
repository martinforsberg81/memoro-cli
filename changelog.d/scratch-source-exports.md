section: Added

- **Source exports: `mc scratch export` writes a commit's files, not the working tree.** A session that needed a
  commit's files, or a whole tree per commit, wrote them into its scratch directory with nothing to say what they
  were or when they could go. `mc scratch export --repo <repo> --ref <ref> --path <path>…` now writes the committed
  bytes and modes of the literal paths from Git objects into `<scratch>/<stem>/exports/<id>/`, with a reconstruction
  receipt beside it and the source kept as `refs/mc/retained-export/<sha>`. The same request in the same session
  reuses the export after checking it. `mc scratch release <id>` previews, and `--apply` removes only what that
  preview still describes. Symlinks and submodules are refused, and `--attach-deps <dir>` links `node_modules` to a
  prepared tree that is recorded and never removed. Tidy lists an ended session's verified export as rule S, and the
  runner removes its own session's exports once the session's end and logs are recorded (`mc scratch sweep`). A
  refused removal says why, and nothing else changes. Filename/id binding and fresh per-candidate checks prevent
  a forged receipt or stale inventory from deleting another export or newly changed evidence. Documented in `mc-tidy.md` (Registered source exports).
