section: Added

- **`mc shot dev|prod <target>` — a PNG of the running app from one verb.**
  The picture is a page, one element (`--el <css>`) or one shell
  (`--shell base|immersive|window`). It comes from a local dev server, started
  the way `mc test dev` starts one, or from https://meetmemoro.app, and the
  file's path is the first line printed. mc finds the worktree, the server
  and the sign-in, then hands memoro's declared capture script
  (`.mc/shot.json`) one request file. That file is mode 0600, removed
  afterwards, and the only place a token or cookie is ever written. mc reads
  back one result line. On a dev server the shot signs in as the seeded
  account through `/dev/login`. On production it uses the test account, or
  your own session with `--me`, after one `mc shot login prod`. `--paste` is
  the fallback when Google refuses the automated browser. `mc shot logout
  prod` forgets the session. `--list` shows the declared targets and
  viewports. See `docs/technical/mc-shot.md`.
