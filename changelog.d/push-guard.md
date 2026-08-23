section: Added

- **A push to a merged branch is refused before it happens (D-0164).** Three
  parties pushed to an already squash-merged branch on one day: the work got
  done, git accepted, everything looked right, and the content was not where
  anybody reads it — each time caught by somebody measuring against
  `origin/main` instead of trusting an outcome. The merge-base mechanism says
  where something went; this is the other half, where it did not go. `mc
  repo guard [repo]` installs a `pre-push` hook in the repository's common
  hooks directory (one file for all its worktrees), and mc installs it in
  every repository it adds a worktree to. The hook (`src/mc/push-guard.js`)
  asks GitHub whether the branch has a merged pull request and git whether
  the branch carries commits main lacks; both true refuses the push with the
  number, the age, the count, and the way forward (a new branch from
  `origin/main`). Not knowing never refuses — no `gh`, no network, no mc on
  PATH all print one line and push. `MC_PUSH_ANYWAY=1` lets a deliberate
  push through. A hook mc did not write is never overwritten, and
  `core.hooksPath` set elsewhere is reported rather than written around.
