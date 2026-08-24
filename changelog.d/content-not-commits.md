section: Fixed

- **"Unmerged" counts content, not commits.** Every merge here is a
  squash, so the SHA count (`origin/main..branch`) called every landed
  branch unmerged forever. Measured 2026-08-24: fourteen MSR areas showed
  "unmerged" on the board; twelve had merged PRs, nothing uncommitted, and
  their content verified in main — and the board's arithmetic read as
  disorder to the person it exists for, while `mc work release` refused to
  clean the same twelve on the same count. The question is now asked of
  content, locally and without the network: `git merge-tree --write-tree
  origin/main <branch>` — a branch whose merge reproduces main's own tree
  has landed. Three honest answers: landed (the board says nothing,
  release and remove delete the branch — with `-D`, since a squashed
  branch is never ancestor-merged and git's `-d` would refuse exactly
  these), ahead ("N commits main lacks" — real work, kept), and unknown
  ("cannot tell whether main has this content — its merge against
  origin/main conflicts; left for a person" — a doubt, said as a doubt,
  never dressed as either).
