# Session runtime hardening

**Status:** active · 2026-06-20 · serves G2, G3

`mc` must make a named work session feel durable. A session is not just a
worktree: it is the tuple of registry entry, worktree/branch, broker-owned PTY,
tool session, source, policy, grounding state, and transcript/status sidecars.
The current high-risk bug is resume: when the live broker PTY is not found,
`mc resume <name>` can fall through to a new launch in the same worktree. That
looks like continuity but loses the existing Codex/Claude screen and history.

## Product contract

1. **`mc new <name>` creates a durable work session.**
   It creates a branch/worktree, records the session, starts the selected tool
   through the broker, and sends fresh startup grounding.

2. **`mc resume <name>` is re-entry, not creation.**
   It must first attach to the exact live broker PTY for the stored session. If
   the live PTY cannot be found, it must not silently create a new tool session
   in the same worktree.

3. **Idle tracked sessions start fresh.**
   A session created by `mc spawn` / fanout may have a worktree and brief but no
   prior tool session. Its first `mc resume <name>` is a fresh grounded start,
   not a native tool resume.

4. **Cold restart is confirmed.**
   If the live PTY is gone, interactive `mc resume <name>` must ask whether to
   start a new grounded tool session in the same worktree. Non-interactive
   callers stop with an explicit diagnostic.

5. **Tool switching does not affect live sessions.**
   `mc resume <name> --codex/--claude` may change the stored restart tool only
   when no live broker PTY is attachable and the user confirms a new session.
   If a live PTY exists, resume attaches to it as-is.

6. **Cloud follows the same model.**
   A cloud session is a source-scoped mc session with a broker-owned PTY in a
   sandbox worktree. It is not a free terminal and not a parallel launcher.

## Runtime model

- **Registry entry:** durable local record keyed by mc session name.
- **Worktree:** filesystem checkout where the work happens.
- **Broker PTY:** live terminal process owned by the local/cloud broker.
- **Tool session:** Claude/Codex internal conversation state, when the tool
  exposes one.
- **Source:** local machine broker or Memoro Cloud sandbox.
- **Resume:** attach to the same live broker PTY, or explicitly ask before
  starting a new session in the same worktree.

The registry name and worktree path are not enough to prove continuity. They can
identify the workspace, but only a live broker PTY or a stable native tool
session identity proves the user is entering the same session.

## Non-negotiable invariants

- True resume of a prior tool session never sends startup grounding.
- True resume of a prior tool session never sends the missing-map first prompt.
- Resume never starts a new broker PTY silently.
- A never-launched tracked session is not a resume; it starts with fresh
  grounding on first `mc resume`.
- A failed live attach must be visible as a prompt/diagnostic, not hidden behind
  a silent relaunch.
- Live attach matching prefers `coding_session_id`, then exact worktree path,
  then session name/source only as a fallback.
- A live session with a different tool than the requested flag still wins; tool
  flags only apply to a confirmed restart when no live PTY can be attached.
- Terminal commands (`mc new`, `mc resume`, `mc end`, `mc broker`, `mc vault`)
  remain separate from in-session habits (`/mc map`).
- Runtime grounding is delivered through adapters without dirtying repo-owned
  instruction files.

## Work slices

### Slice 1 — contract tests

Add failing tests that lock the visible behavior before changing runtime code:

- direct `mc resume <name>` attaches to the stored live broker PTY and does not
  call launch
- picker resume behaves the same as direct resume
- tool flags do not override an attachable live PTY
- when no broker PTY is attachable, resume does not silently relaunch by default
- never-launched tracked sessions fresh-start with startup grounding
- interactive missing-live resume asks before starting a new session in the same
  worktree
- non-interactive missing-live resume fails with a diagnostic
- cloud session launch keeps using the same session-intent seam

### Slice 2 — broker/session audit

Audit and harden the full broker chain:

- `launch-client` writes the right registry identity after launch
- `BrokerRuntime.listSessions()` exposes enough stable fields for matching
- `BrokerSessionManager.status()` includes `id`, `name`, `cwd`, `tool`, and
  live/dead/attachable status
- attach uses the same id that launch registered
- broker restart/death is distinguishable from an ended tool session

### Slice 3 — live resume fix

Make live attach the only automatic resume behavior. If no attachable broker PTY
is found, ask an interactive user whether to start a new grounded tool session
in the same worktree. Non-interactive callers get a clear diagnostic with the
stored session name, worktree, expected coding session id, and next step.

Do not add native cold resume until the relevant tool identity can be stored and
verified. A loud stop is safer than a fake resume.

### Slice 4 — interactive restart prompt

Add the deliberate y/n path for starting over in the same worktree. Confirmed
restart gets fresh grounding because it is a new tool session. It must update
registry state so future resume attaches to the new PTY.

### Slice 5 — intro/help/status cleanup

The user-facing surfaces must say which path fired:

- attached existing live session
- live session missing; restart declined or unavailable
- confirmed restart started in the same worktree
- cloud/local source identity

`mc --help` should describe resume as re-entry, not relaunch. The launch intro
should remain compact but expose mode/source when useful.

### Slice 6 — cloud parity

Verify that cloud sessions obey the same contract with one active cloud
worktree/session per user for the MVP. Cloud create may return the existing
active session or require stop/confirmed restart, but it must not spawn hidden
duplicates.

## Acceptance

- A real `mc resume <name>` returns to the same Codex/Claude screen when the
  broker PTY is alive.
- If the live PTY is gone, `mc resume <name>` asks before starting anew or fails
  non-interactively.
- Tests prove no startup prompt/grounding is sent on resume.
- Tool flags on resume cannot fork a live session by accident.
- Help, intro, and diagnostics match the actual control flow.
- Cloud and local launch paths use the same session-intent contract.
