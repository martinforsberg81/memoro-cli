---
name: git
description: Working with git in an mc repository (memoro, memoro-cli), whose worktrees share one git directory — stash, commits, branches, worktrees and pushing. Use before git stash, rebase, commit, checkout, branch or worktree commands.
---
# Git in a shared git directory

Every worktree of a repository shares one git directory: its stash, its refs
and its `index.lock` are every session's at once.

- **Never `git stash`.** The stack is shared, and push/pop has destroyed
  parallel work. Set work aside with a commit (`git reset --soft HEAD~1`
  later) or in a scratch worktree. `git rebase` autostashes: commit or reset
  before rebasing.
- **One command at a time where it matters.** A failed `git add` in a chain
  has left a pushed branch without its commit; a failed `git checkout` has
  gated the wrong branch. Print `git branch --show-current` before a
  branch-dependent command, read `git status` after committing, and retry a
  held `index.lock` — it clears in seconds.
- **Commits.** Read `git status` and the diff; stage only the task's files and
  leave unrelated changes alone. A short imperative English subject (`Fix
  session expiry check`), no Conventional Commit prefix.
- **Branches.** Stay on the branch you were given. Never continue a branch
  that has merged: the same content lands twice under two SHAs. Never stack a
  branch on an open one unless it cannot be built without it.
- **Pushing.** Only through `mc publish`; never force-push, never rewrite
  published history, never push to `main`.
- **Worktrees and branches are mc's.** Never delete a local branch or a
  worktree by hand. A remote branch gone after a merge is the repository's
  `deleteBranchOnMerge`, not a fault.
