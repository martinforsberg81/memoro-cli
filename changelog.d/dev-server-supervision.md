section: Fixed

- **mc records dead dev servers and replaces hung ones.** A registration whose
  process is gone was swept by `listServers` without a word — 141 of 571
  memoro dev-server starts died unexpectedly 12–26 Sep 2026 and no log mc
  keeps recorded one. Each sweep now logs `dev-server-gone` (instance id,
  service, worktree, `server_pid`, `started_at`, `age_s`). And `mc test dev`
  (and `mc shot`, through the same reuse) no longer takes a live pid for an
  answer: a registered server that does not answer its health URL twice in a
  row, five seconds each, is logged as `dev-server-hung`, stopped through its
  own `control.stop.argv`, and replaced — `mc: <old> was alive but not
  answering — started a fresh one, <url> (<new>)`. `docs/dev-server-protocol.md`
  now lists every occasion mc stops a server.
