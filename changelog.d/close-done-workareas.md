section: Added

- **A workarea whose plan is finished is closed by `mc run`, at the end of
  the round that archived the plan.** A workarea outlived its plan for the
  reason a done plan used to outlive its project: nothing removed it.
  Measured 2026-08-29, `~/mc` held 61 of them — seven finished and merged
  weeks earlier, sixteen from before the plan world with no PLAN.md on main
  at all. A workarea is now **closable** on three facts and no judgement:
  its plan on main says `done`, its worktree has no uncommitted change, and
  its last row in `runs.tsv` ends `merged`. Commit counting is not one of
  them — the runner squash-merges, so every finished branch reads as
  "ahead" of main forever. Closing hands the worktree back
  (`git worktree remove`), deletes the local branch, and moves everything
  the folder kept beside its checkout to
  `~/mc/runner/log/closed/<name>/` before the folder goes: nothing is
  deleted, the remote branch and the PRs stay, and the plan goes first —
  a folder is never removed while the plan that explains it is still on
  main.

- **A workarea with no plan on main is listed rather than removed.** No
  machine takes one down. `mc run` writes them to
  `~/mc/intake/unplanned-workareas.md` every round — name, repository, how
  much is uncommitted, when it was last committed to, and whether the
  branch's content is already on main (asked of content, not of commit
  counts) — and the page gathers them under one heading of their own
  instead of scattering them through the rows that have a plan. WORK's
  numbers run through both lists, so every row is still opened by the
  number beside it.

section: Changed

- **`~/mc/queue.md` is a strict list.** One project name per line and
  nothing else: no comments, no headings, no blank-line sections (the
  2026-08-29 file had seven comment lines and twenty names that were
  already done or had no plan on main). `mc run` rewrites it to that shape
  at the top of every round, saying in `runner.log` why each line went, and
  a name leaves it the moment that project's step has run — so the file is
  Martin's "these first" and it empties itself.

- **A directory under `~/mc` without `memoro/` or `memoro-cli/` in it is
  not a workarea.** mc's own folders — `bin/`, `brief/`, `decisions/`,
  `inbox/`, `intake/`, `runner/`, `status/` and the role homes — were off
  the page by accident, because nothing under them happened to hold a
  `.git`. Now the rule is the rule, and the runner uses the same one.
