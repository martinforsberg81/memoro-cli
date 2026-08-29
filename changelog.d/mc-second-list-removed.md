section: Removed

- **The second and third lists.** `mc list`, `mc sessions list` and bare `mc
  status` say where they went and exit 2; `src/cli/list.js` and
  `src/mc/session-v1-list.js` are gone with them. So is the old status board —
  `mc status --sessions|--watch|--wait|--timeout`, `commands/status-board.js`,
  `signature()` in `work-status.js`, and `renderLines` in `status-render.js`,
  whose `painter`/`width`/`pad`/`clip` half every other page borrows and
  stays. `mc status <name>` and `mc work <name> …` are unchanged, and so is
  the work model the board drew: `mc repo status` and the lease liveness check
  still read it.
