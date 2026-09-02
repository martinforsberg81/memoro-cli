section: Fixed

- **The gate no longer claims memoro-cli's suite runs without its dependencies.**
  `repo-gate-table.js` shipped `prepare: null` for this repository, with the
  evidence "the suite is node:test over source only". It is not:
  `src/runtime/session-host/` imports `@xterm/addon-serialize`, `@xterm/headless`
  and `node-pty`, so on a clean `origin/main` worktree
  `owned-resource-cleanup`, `session-runtime-v1`, `runtime-host`, `socket-e2e`
  and `terminal-screen` fail with `ERR_MODULE_NOT_FOUND` — five files unrun and
  uncounted in every gate round, while the round printed the line vouching for
  them. Measured 2026-09-02: `npm ci` there is exit 0 in 17 s, and the same five
  files are 27 pass, 1 skip, 0 fail. The entry now declares that command, and
  `repo-gate-table.test.js` holds the claim against `package.json` instead of
  against a sentence inside the entry: a shipped `prepare: null` beside declared
  dependencies fails the test.
