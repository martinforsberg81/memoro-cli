section: Fixed

- **A checkout the merger restores is under the work root, where the
  dependencies are.** Since #1434 the merger restores a checkout for a branch
  nobody holds, and it put that checkout under mc home
  (`~/.memoro/mc/checkouts/…`). The shared dependency tree is
  `~/mc/node_modules`, found by walking up from the worktree, so the restored
  checkout resolved none of it. memoro-cli#1441 stopped at `dependencies`
  (4 of 4 unresolved) on a change that does not touch `package.json`. A
  restored checkout now goes to `~/mc/checkouts/<repository>/<branch>`, and
  the gate passes it the round's own work root.
