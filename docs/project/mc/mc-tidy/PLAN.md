---
status: ready
next: "Step 1 — the runner closes a workarea by itself once its plan is done on main, its worktree is clean and its last run merged; the page lists only real workareas — done when `mc` (or `mc work` until mc-ui lands) no longer shows bin/brief/decisions/inbox/runner/status/pm/pm-helper, and the seven done workareas of 2026-08-29 are gone from ~/mc with their conversation logs kept under ~/mc/runner/log/closed/."
budget: 150k
needs: [mc-ui]
---

# mc tidy — workareas leave by themselves when their work lives on main

## Goal

`mc work` on 2026-08-29 listed 62 rows. Measured: 8 are mc's own folders
(bin, brief, decisions, inbox, runner, status, pm, pm-helper), 7 are
workareas whose plan on main is `done` and whose last runner step merged,
16 are workareas from before the plan world with no PLAN.md on main, and
32 are real. Nothing should have to be typed to make this list true —
Martin ruled (2026-08-29, in session): **no new verb**. The runner and the
page keep the list clean on their own.

## Rules

- A workarea is **closable** when all three hold: its plan on main says
  `status: done`; its worktree has no uncommitted change; the last row for
  it in `~/mc/runner/log/runs.tsv` ends `merged`. Commit counting against
  main is *not* a signal — the runner squash-merges, so every finished
  branch looks "ahead" (measured: continue-section, docs-structure, …).
- Conversations are not a reason to keep a folder: what is current lives
  in PLAN.md and decisions on main. Their index/log files are moved to
  `~/mc/runner/log/closed/<name>/` before the folder goes, never deleted.
- A folder without `memoro/` or `memoro-cli/` in it is not a workarea and
  is never listed.
- A workarea **without a plan on main** is never removed by a machine. It
  is listed under one heading on the page (name, repo, uncommitted count,
  last commit date) so Martin sees them in one place; the step writes
  `~/mc/intake/unplanned-workareas.md` with the same rows plus, for each,
  whether the branch's content is already on main, for `mc brief` to
  raise. (Of the 16: msr-track-1 carries 30 commits from 2026-08-24 and
  mc-repo 4 — those are the two where something real may sit.)

## Success criteria

- [ ] `mc run` closes every closable workarea at the end of each round
      (`git worktree remove`, local branch deleted, logs moved) and says so
      in runner.log, one line per workarea.
- [ ] The first run after merge removes the seven done workareas of
      2026-08-29 (continue-section, docs-structure, improve-chat-runtime,
      sql-readiness-session-A, language-voice-lexical-selection,
      language-voice-live-watchdog, language-voice-playback-underrun) and
      leaves the rest untouched — the PR body lists what it removed.
- [ ] The page (WORK in `mc`, or `mc work` until then) hides mc's own
      folders and shows unplanned workareas under their own heading.
- [ ] `~/mc/intake/unplanned-workareas.md` exists after the first run.
- [ ] Tests cover the closable rule with the squash-merge case (branch
      ahead, plan done, last run merged → closable) and the dirty case.

## Contract

- No new command, flag or prompt key. Nothing is removed that has an
  uncommitted change, no plan, or an unmerged last run.
- Removal is of the `~/mc/<name>/` folder and the local branch only; the
  remote branch and the PRs stay.

## Steps

- [ ] **1. Closable rule + runner close + page filter** — one PR.
- [ ] **2. Close-out** — `docs/technical/` note, `project_log.md` row.
