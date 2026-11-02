---
name: merge-conflicts
description: Resolving a merge conflict in an mc repository (memoro, memoro-cli) — merging origin/main into a branch, a conflict the merger reported, a worktree handed over mid-merge. Use before running git merge or editing a conflicted file.
---
# Merge conflicts

A conflict is two intents. Keep both; never take a side because it is quicker.

- Merge, conflict check, regeneration and commit are separate commands. Never
  chain `git commit` after `git merge`: `&&` cannot tell a conflicted stop from
  success, and the markers get committed. After a merge, read `git status` for
  unmerged paths first.
- A `diff3` block has three sections (ours · base · theirs); keeping "our
  lines" as a range keeps the base too. Run `node --check <file>` after every
  hand-resolved JavaScript file.
- When "mine already contains theirs", check it mechanically (their text is a
  substring of yours) before writing the file.
- Regenerate generated files with the repository's own script; resolve only
  source. `.gitattributes` names what is generated:
  `git diff --name-only --diff-filter=U | git check-attr --stdin merge | grep -v ': generated$'`
  lists what to resolve by hand. Never `--ours`/`--theirs` on a file both
  sides edited.
- Then reread the result for hunks kept twice, and commit as a merge: no
  rebase, no rewritten history.
