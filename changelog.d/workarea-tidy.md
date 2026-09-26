section: Changed

- **`mc work release` asks GitHub when the content check cannot answer.** A
  branch whose merge against `origin/main` conflicts was kept with "cannot
  tell whether main has this content" — measured 2026-09-26, 29 workareas
  kept that way, every one with a merged pull request whose head was exactly
  the branch's tip. Release now asks the question the runner already asked:
  when the newest pull request merged from the branch has the branch's tip as
  its head, the worktree and branch go, and the line says so
  (`— #468 merged at this tip`; `--json` carries `landed_by`). Anything else —
  a later commit, no merged pull request, `gh` failing — keeps it as before. A
  branch that is `ahead` is never sent to GitHub. The question lives once, in
  `mergedPullAtTip` (`branch-landed.js`), and the runner's `mergedAtTip` now
  asks it there with unchanged behaviour; the per-worktree decision is the
  pure, tested `releaseVerdict` (`work-area.js`).

- **`mc work tidy` releases every finished workarea and removes the
  transcripts nothing will open again — dry run first.** One list in three
  groups with byte totals: worktrees `mc work release` would remove (only in
  areas holding nothing but git worktrees, never a role home or a register
  project with steps left), Claude transcripts older than `--days` (default
  14) whose directory is gone or that are not their workarea's latest, and
  `<uuid>/` directories an earlier delete left behind. `--apply` removes
  exactly that list and logs `work-tidy` with counts. Only `<uuid>.jsonl` and
  `<uuid>/` are ever removed under `~/.claude/projects` — `memory/` is never
  opened — and a question that fails keeps what it was about (2026-09-26: a
  shell loop that read an erroring `find` as "nothing here" took every
  transcript and every `memory/`). `mc work release`, `remove` and `discard`
  now really see a process standing in a worktree: `directoryInUse` called
  `processesStandingIn` without importing it, and the swallowed error read as
  "nobody here".

- **A deleted Claude conversation takes its `<uuid>/` directory with it.**
  Claude Code keeps a sibling `<session-id>/` directory (subagents, tool
  results) beside each transcript; `mc work discard ytor --apply` removed five
  `.jsonl` files and left 203 MB of those behind (2026-09-26).
  `deleteConversation` now removes the sibling when the id is a uuid
  (`SESSION_ID`), and `listConversations` counts it in `bytes`
  (`treeBytes`: symlinks never followed, unreadable entries count 0), so the
  dry runs of `release` and `discard` show what is really at stake. Nothing
  else in a project directory is touched — `memory/` survives, and a project
  directory goes only when it is empty afterwards, as before.
