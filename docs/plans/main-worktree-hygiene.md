# Main/worktree hygiene

**Status:** active · 2026-06-08 · serves G2, G3

`mc` must be stricter than `cs` about the boring git lifecycle. The primary
worktree's `main` should be a clean baseline, while all agent/session work lives
in named mc sessions with their own worktree and branch.

## Problem

Live use still produces too much manual git housekeeping:

- local `main` can collect uncommitted instruction/config drift
- session branches can remain after squash-merge
- the user has to reason about local `main`, `origin/main`, session branches,
  dirty worktrees, PR state, and `mc` registry state separately
- after PR merge, the right cleanup path is still too manual

This undermines the continuity promise. A user should not need to become the
session janitor just because multiple AI tools are involved.

## Product contract

1. **Primary `main` is baseline, not workspace.**
   `mc` should make it obvious when the primary worktree is dirty, behind, ahead,
   or on the wrong branch. Ordinary session work should not start there unless
   the user explicitly asks for a local/wrap mode.

2. **Sessions are the unit of work.**
   `mc new` / `mc spawn` create isolated worktrees and branches. `mc resume`
   returns to those worktrees. `mc list` and `mc status` show branch, PR, dirty,
   merge, and cleanup state in one place.

3. **Landing is a guided transition.**
   After a PR is merged, `mc` should detect the squash-merge relationship,
   fast-forward primary `main` when safe, and mark the session as ready to end.
   It should never silently discard local changes.

4. **Cleanup is explicit but low-friction.**
   `mc end <name>` should remove the worktree and stale session registry entry
   only when the branch is merged/equivalent or the user forces it. Squash-merged
   branches should not look like unmerged work forever.

5. **Diagnostics beat cleverness.**
   When state is messy, `mc status` should say what is dirty, where it is dirty,
   what can be safely fast-forwarded, and which exact command fixes the next
   step. Avoid hidden git mutations.

## Command shape

First implementation should strengthen existing surfaces before adding new
verbs:

- `mc status`:
  - show primary worktree state: branch, dirty count, ahead/behind vs upstream
  - show whether current cwd is primary or an mc session worktree
  - warn when primary `main` has local changes
- `mc list`:
  - add compact branch/worktree cleanliness indicators
  - mark squash-merged/equivalent sessions as `ready-to-end`
  - keep active sessions and local dead sessions separate
- `mc end`:
  - treat squash-equivalent branches as merged for safe cleanup
  - refuse dirty worktrees unless forced
- `mc reconcile`:
  - stay optional, but become the bulk cleanup/status helper for old sessions
  - no PM behavior, no map editing, no hidden branch deletion

Only add a dedicated `mc sync-main` / `mc land` command if repeated live use
shows the existing surfaces cannot stay clear enough.

## Implementation slices

### Slice 1 — state model

Build one shared git/session state probe used by `status`, `list`, `end`, and
`reconcile`:

- primary worktree path
- current worktree kind: primary/session/unknown
- current branch and upstream
- dirty count and changed filenames, without reading secret values
- ahead/behind
- session branch merge state:
  - merged by ancestry
  - squash-equivalent to `origin/main`
  - open PR / recently merged PR when GitHub is available

### Slice 2 — primary-main guardrails

Make `mc status` and bare `mc` surface primary `main` dirt clearly. Starting a
new managed session from dirty primary should be allowed only if the dirty files
are unrelated to session creation, but the warning must be hard to miss.

### Slice 3 — safe post-merge cleanup

Teach `mc end` and `mc reconcile --apply --only-safe` that squash-equivalent
branches are safe to end. Preserve dirty worktrees and unmerged branches.

### Slice 4 — release-gate habit

Before npm publish or a roadmap handoff, run one command that verifies:

- primary `main` equals `origin/main`
- no uncommitted primary drift except explicitly acknowledged local files
- no ended sessions with dirty worktrees
- no session branch that is both merged/equivalent and still listed as active

This can initially be `mc status --strict` or a documented use of `mc reconcile`;
choose the smallest surface after slices 1-3 land.

## Non-goals

- Do not replace git or GitHub.
- Do not hide conflicts or auto-reset user changes.
- Do not make `MEMORO.md` reconciliation part of branch cleanup.
- Do not require users to understand internal registry files.

## Acceptance

- A merged PR can be followed by one clear `mc` path that fast-forwards primary
  `main` when safe and identifies the session as safe to end.
- Dirty primary `main` is visible immediately in `mc status`.
- Squash-merged session branches do not remain scary forever.
- `mc list` gives enough branch/session hygiene information that the user does
  not need to compare `git status`, `gh pr list`, and registry files by hand.
