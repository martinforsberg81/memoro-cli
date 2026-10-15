section: Added

- **`mc shot` measures a layout, not only pictures it.** `--safe-area`
  (a declared phone viewport carries its own, so `--viewport iphone` has a
  notch and a home indicator), `--wait-for <css>`, `--scroll <css>[@end]` and
  `--measure <css>`, which prints every match's box, padding, position, scroll
  state and visibility as one JSON line after the path. `--account seeded|new`
  and `--onboarding` (reseeded, so the onboarding shows the same every time)
  on dev. Inside a memoro worktree `mc shot dev` now serves that worktree by
  default, and says which branch and commit it served.
- **A dev server is started over when the worktree was edited after it
  started**, not only when HEAD moved — an uncommitted fix is what a session
  measures. `mc shot dev` and `mc test dev` both get it.
- **`mc hook session-start` and `mc hook pre-tool`** for Claude Code hooks. At
  session start: each mc worktree at the session's directory with its branch,
  behind and ahead of origin/main, changed files and dev server, warnings for
  a merged or stale branch, `main`, and a session started outside the
  repository, and the mc toolbox. Before a tool: `gh pr create` and `git push`
  are turned to `mc publish`, `gh pr merge` to `mc merge`, `npm run ci` to
  `mc gate`, `npm run dev*` to `mc test dev --here --url`, and a scratch
  Playwright script to `mc shot`; `MC_HOOK_ALLOW=1` lets a command through.
  See `docs/technical/mc-hooks.md`.
