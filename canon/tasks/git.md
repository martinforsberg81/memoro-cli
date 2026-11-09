---
name: git
description: Working with git in an mc repository (memoro, memoro-cli), whose worktrees share one git directory — stash, commits, branches, worktrees and pushing. Use before git stash, rebase, commit, checkout, branch or worktree commands.
---
# Git in a shared git directory

Every worktree of a repository shares one git directory: its stash, its refs
and its `index.lock` are every session's at once.

- **Never `git stash`.** The stack is shared, and push/pop has destroyed
  parallel work. Set work aside with a commit (`git reset --soft HEAD~1`
  later), never in a scratch checkout of a goal branch. `git rebase`
  autostashes: commit or reset before rebasing.
- **One command at a time where it matters.** A failed `git add` in a chain
  has left a pushed branch without its commit; a failed `git checkout` has
  gated the wrong branch. Print `git branch --show-current` before a
  branch-dependent command, read `git status` after committing, and retry a
  held `index.lock` — it clears in seconds.
- **Commits.** Read `git status` and the diff; stage only the task's files and
  leave unrelated changes alone. A short imperative English subject (`Fix
  session expiry check`), no Conventional Commit prefix.
- **Branches.** A runner step's or goal's branch is built to the end on its
  pull request, and merges `origin/main` when the merger reports a conflict.
  New work starts from a fresh `origin/main`. A branch that has merged is
  finished: building on it lands the same content twice under two SHAs. A
  branch stacked on an open one is rebuilt from `main` once its parent lands,
  not rebased onto it.
- **Pushing.** `mc publish` pushes without force and opens the pull request.
  A force-push rewrites what another session or the merger may already hold;
  when one is meant (a rebased stack), `--force-with-lease` with
  `MC_HOOK_ALLOW=1`. `main` changes only through a merge.
- **Keep an open PR's checkout.** Publication, a pushed head and failed gates
  are not completion. Retain its existing branch checkout until the PR lands
  or closes, including manual disk cleanup: the merger must borrow that tree.
  If it was already removed, inspect the branch/head and restore its original
  path once; never create a second checkout for a merge measurement.
- **Removing a branch or a worktree.** Check first, then do it:
  `git worktree list` shows no worktree holding the branch (git refuses
  otherwise), and `git cherry origin/main <branch>` lists nothing, or each `+`
  commit is in a merged pull request. A worktree goes with
  `git worktree remove <path>` (without `--force` when it has edits you have
  not read). A runner area's or a goal's worktree is cheaper to leave to
  `mc tidy` and `mc goal archive`, which do the same checks. A remote branch
  gone after a merge is the repository's `deleteBranchOnMerge`, not a fault.
