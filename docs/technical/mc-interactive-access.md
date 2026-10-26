# Interactive session filesystem access

`mc plan`, `mc work`, and the other interactive role sessions use
`src/mc/work-open.js` for foreground, background, resumed and replaced
conversations. All those paths render their arguments through the tool's
`launchSpec().args()`; they must not spawn the raw model/session arguments
and bypass the adapter.

For Codex, `src/mc/interactive-workspace.js` resolves the existing directories
an mc session operates on: its area, `workRoot(env)`, `mcHome(env)`, the known
repositories' shared Git directories, and the current worktree's Git common
directory. This supports both the legacy checkout layout and bare repositories,
including a planning directory that is not itself a Git repository and contains
both repository worktrees. Environment overrides are honored; no path is fixed
to a particular user's home.

The Codex adapter renders these as `--add-dir` options before the opening
prompt or resumed session id. The grants include mc's operational state outside
the session's cwd: plans, proposals, runner registers, gate and merger state.
They do not grant the whole home or filesystem, change approval policy, disable
the sandbox, or edit the user's Codex configuration. An explicit read-only
sandbox remains read-only. Claude's arguments remain unchanged: that adapter
adds no Codex-style filesystem sandbox. Headless runner launches are unchanged
and retain their separate contract in `mc-run.md`.

A running session cannot enlarge its own inherited permissions. Once this change
is installed, reopening through mc applies it to an existing conversation as
well as a new one; manual `--add-dir` flags are not required.

Regression coverage: `tests/mc/interactive-workspace.test.js` exercises both
repository layouts, a real linked worktree, adapter option placement, and each
interactive launch path. `tests/mc/work-open.test.js` retains Claude launch and
resume coverage. These are launch-contract tests, not a claim that a live Codex
child has exercised Git and mc writes through its sandbox.
