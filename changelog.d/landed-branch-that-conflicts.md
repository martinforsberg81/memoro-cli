section: Fixed

- **A landed branch whose merge with main conflicts reads landed.**
  `branchLanded` answers `unknown` when `git merge-tree` conflicts, and
  `freshBranch` left such a workarea on the branch: `step-cost` step 2 ran on
  `step-cost-2` on 2026-09-11 after #693 had landed from it, was handed a
  conflict on main's own later edit, and had its push refused at the end. On
  `unknown` — and only then — `freshBranch` now asks GitHub for the newest
  pull request merged from the branch; when its head is the branch's tip the
  workarea is moved to `<name>-<n>` from `origin/main` as for `landed`. A
  different tip, or a `gh` that fails, leaves the branch as before.
  `branchLanded` stays local.
