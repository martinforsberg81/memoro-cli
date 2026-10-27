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
Directory grants alone do not grant the whole home or filesystem, change approval
policy, disable the sandbox, or edit the user's Codex configuration. An explicit read-only
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

## Explicit execution profile

`MC_CODEX_WORKSPACE=full mc plan haptic-feedback` explicitly selects full execution
for a newly launched or resumed interactive Codex session. It renders
`--sandbox danger-full-access`, not an approval-bypass flag, and prints the scope
before launch. This is broader than browser access. Approval policy is unchanged.
`MC_CODEX_WORKSPACE=worktree` selects `workspace-write`; `read-only` selects
`read-only`. Unknown nonempty values fail before launch. With the variable unset,
mc passes no sandbox override and preserves the tool's configured default. Claude
and headless runner launches are unchanged. No failure automatically selects full
access, and mc does not edit user configuration or change a running session.
External managed-launcher restrictions still apply.

Browser validation uses `mc shot dev` / `mc dev open`, including kept-session
`next` and `close`, after an authorized session is reopened. The card-menu proof
checks semantic/native requests and their timing through `mc shot`; a Mac browser
does not verify physical vibration or sensation on an iPhone. Launch-contract
tests do not claim that browser validation has run.
