# One execution boundary for interactive mc sessions

`mc plan`, `mc work`, and other interactive roles use `src/mc/work-open.js`
for foreground, background, resumed and replaced conversations. All paths pass
through `interactiveAccessOptions` in `src/mc/interactive-access.js` and the
tool's `launchSpec().args()`.

## Tool-neutral contract

An mc coding session runs on the host, with access to the repository, mc state
and the processes its normal tools require, including `mc shot` and `mc dev`.
The adapter must declare `executionAccess: 'host'` and implement that contract.
An adapter that cannot honor it is refused before launch, not silently run with
a different access boundary. Planned, unimplemented tools remain unsupported.

Codex renders the common contract as `--sandbox danger-full-access`. Claude
already runs on the host and needs no additional execution flag. Approval
policies remain independent: mc adds neither approval bypass nor an automatic
escalation after failure. Headless runner access is unchanged.

Normal commands suffice: `mc plan haptic-feedback`. The temporary
`MC_CODEX_WORKSPACE` switch introduced in #1152 is removed and has no effect.
This replaces that per-tool opt-in design, following
`mc-tool-neutral-execution-access`. It does not edit user configuration or widen
the current session. External managed-launcher restrictions remain authoritative.
New or resumed sessions launched by the updated mc receive the contract.

`src/mc/interactive-workspace.js` still resolves the operational directories:
area, workRoot, mcHome, known repositories' shared Git directories and current
worktree Git common directory. The Codex adapter renders these as `--add-dir`
options before the prompt or resumed session ID.

## Evidence

`tests/mc/interactive-workspace.test.js` covers both repository layouts, a real
linked worktree, adapter contract admission, and new/resumed/replaced launches.
`tests/mc/work-open.test.js` retains Claude launch coverage. These tests intercept
launches; they do not claim browser execution.

Browser validation uses `mc shot dev` / `mc dev open`, including kept-session
next/close. The haptic proof measures requests and timing through mc shot. A Mac
browser does not prove physical iPhone vibration or sensation.
