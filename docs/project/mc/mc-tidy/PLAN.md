---
status: ready
next: "Step 2 — the closable rule, the runner's close, the page filter and a strict `queue.md`: a workarea whose plan on main says `done`, whose worktree is clean and whose last row in `runs.tsv` ends `merged` is removed at the end of the round (`git worktree remove`, local branch deleted, index/log files moved to `~/mc/runner/log/closed/<name>/`) — done when a round removes such a workarea and says so in runner.log one line each, a workarea with no plan on main is never removed but is listed under its own heading with `~/mc/intake/unplanned-workareas.md` beside it, mc's own folders are off the page, and `~/mc/queue.md` holds nothing but names of projects that still have a step to run this round."
budget: 150k
needs: [mc-ui]
---

# mc tidy — a plan that is done leaves, and takes its workarea with it

## Goal

A plan that reaches `done` is archived. Nothing else is the trigger, and
nothing has to be typed (Martin, 2026-08-29: "När en plan är DONE ska den
arkiveras. Punkt.").

Measured on 2026-08-29, that is not what happens. `run.js:355` answers a
done plan with `break` — the runner stops working on it and does nothing
else. No code in mc writes a `project_log.md` row or removes a directory
under `docs/project/`; `PROJECT_LOG` appears once in the source
(`helper-turn.js:38`) and is only ever read. The close-out rule in
`docs/project/README.md` is prose that a human or a step's Claude is
expected to follow unaided, so:

- memoro: 39 plans, **8 say `done`**, all 8 still in `docs/project/`, all 8
  still holding a workarea. `project_log.md` has 4 rows, none of them these.
- memoro-cli: 11 plans, **2 say `done`** (mc-ui, mc-ui-polish). Both already
  have their `project_log.md` row — and both directories are still there.
  Step 1 of close-out happens; step 2, the only one that removes anything,
  does not.
- `docs/plans/`, the home `docs/project/` replaced, holds **656 .md files**
  (49 archived). `docs/project/` is five weeks old and holds 77 on 39
  projects. Same curve, one generation later.

So the archiving is the runner's, not the reader's. The workarea question
below is the same question one layer down — a workarea outlives its plan
for exactly the same reason — and both are answered here.

`mc work` on 2026-08-29 listed 62 rows. Measured: 8 are mc's own folders
(bin, brief, decisions, inbox, runner, status, pm, pm-helper), 7 are
workareas whose plan on main is `done` and whose last runner step merged,
16 are workareas from before the plan world with no PLAN.md on main, and
32 are real. Nothing should have to be typed to make this list true —
Martin ruled (2026-08-29, in session): **no new verb**. The runner and the
page keep the list clean on their own.

## Rules

- **A plan on main that says `status: done` is archived in the round the
  runner reads it**, in the repository that keeps it: the directory
  `docs/project/<programme>/<project>/` is `git rm -r`'d, a row is appended
  to that repository's `docs/project/project_log.md`, and the change lands
  as its own PR the runner merges like any other. `done` is the whole
  trigger — not a verb, not a flag, not the workarea's state.
- **The row is preferred, never waited for.** If the project's close-out
  step already wrote its `project_log.md` row, the runner leaves it alone
  and only removes the directory — that is the case measured on mc-ui and
  mc-ui-polish. If no row names the project, the runner writes one from the
  plan: `date` today, `programme`/`project` from the path, `outcome`
  `delivered`, `summary` the plan's `next:` clipped to one line, `pointer`
  the PRs the runner merged for it in `runs.tsv`, and `doc` the
  `docs/technical/` path the plan names if it names one, else `none`.
- **A missing doc is recorded, never a blocker.** Archiving a delivered
  project whose row says `doc: none` writes one line to runner.log naming
  it, and `~/mc/intake/undocumented-closures.md` gets a row for `mc brief`
  to raise. It does not stop the removal: a project kept alive because its
  documentation is thin is how `docs/plans/` reached 656 files.
- Archiving is of `docs/project/<programme>/<project>/` only. An empty
  programme directory goes with its last project; `project_log.md`,
  `README.md` and any file the programme keeps beside its projects stay.
  `docs/plans/` is not touched by this project at all.
- **The plan goes first, then the workarea.** A workarea is closed in the
  same round, after its project's archive PR has merged — so a workarea is
  never removed while the plan that explains it is still on main.

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

- **`~/mc/queue.md` is a strict list** (Martin, 2026-08-29: "ett träsk —
  där ska INTE finnas någonting annat än en lista över vad som ska köras").
  One project name per line, nothing else: no comments, no headings, no
  blank-line sections. The runner removes a name from the file the moment
  that project's step has run (or when the project is `done` or has no
  plan on main, saying why in runner.log) — the file is Martin's "these
  first" and empties itself; the alphabetical list of ready plans on main
  is the order after it, as today. A line that is not a project name is
  dropped with one log line, never kept. The step rewrites the current
  file to that shape in its first run (the 2026-08-29 file has 7 comment
  lines and 20 names that are already done or have no plan).

## Success criteria

- [ ] `mc run` archives every plan that says `done` on main, in the round it
      reads it, and says so in runner.log — one line per project.
- [ ] The first run after merge archives the ten done plans of 2026-08-29 —
      memoro: docs-structure, improve-chat-runtime,
      language-voice-lexical-selection, language-voice-live-watchdog,
      language-voice-playback-underrun, continue-section, msr-design,
      sql-readiness-session-A; memoro-cli: mc-ui, mc-ui-polish — and leaves
      every other directory in `docs/project/` untouched.
- [ ] After that run, no directory under `docs/project/` in either
      repository has a PLAN.md that says `done`, and every one that was
      removed has exactly one `project_log.md` row naming it — the two that
      already had a row (mc-ui, mc-ui-polish) still have exactly one each.
- [ ] `~/mc/intake/undocumented-closures.md` names every project archived
      with `doc: none`.
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
- [ ] `~/mc/queue.md` contains only names of projects with a plan on main
      that have not yet had their step this round; after a round in which
      every named project ran, the file is empty. `mc run` never reads a
      comment line into the queue.
- [ ] Tests cover the closable rule with the squash-merge case (branch
      ahead, plan done, last run merged → closable) and the dirty case;
      and archiving with a row already written, with no row, and with a
      programme left empty by its last project.

## Contract

- No new command, flag or prompt key. Nothing is removed that has an
  uncommitted change, no plan, or an unmerged last run.
- Archiving removes `docs/project/<programme>/<project>/` and nothing else
  in the repository; `docs/plans/` is out of scope. The history is the
  record — `git log --all -- <path>` still answers every question the
  removed directory could.
- Workarea removal is of the `~/mc/<name>/` folder and the local branch
  only; the remote branch and the PRs stay.
- A thin or missing `docs/technical/` note never stops an archive. It is
  reported, and Martin decides whether to write it.

## Steps

- [x] **1. Archive on done** — the runner removes the directory and writes
      the row it needs, PR per repository. One PR. (PR pending; the rules are
      `src/mc/archive-plan.js`, the round's half is `archiveDone` in
      `src/mc/run.js`.)
- [ ] **2. Closable rule + runner close + page filter + strict queue.md** — one PR.
- [ ] **3. Close-out** — `docs/technical/` note, `project_log.md` row, and
      the one thing step 1 left for a reader: `mc brief` raising
      `~/mc/intake/undocumented-closures.md` (the runner writes it; nothing
      reads it yet).

## What the code taught us

- **The done set is not a fixed list.** The plan names ten done plans
  measured earlier on 2026-08-29; measured again while step 1 was written,
  there are thirteen — memoro 9 (the plan's 8 and avatar-fab-composition)
  and memoro-cli 4 (mc-ui, mc-ui-polish and, both with their
  `project_log.md` row already written, mc-helper and mc-run-lanes). So the
  criterion the code implements is `status: done` on main at the moment the
  round reads it, and the list in the success criteria is that morning's
  measurement rather than its definition: the first run archives whatever
  says `done` then.
- **The archive needs a worktree of its own.** A done project need not have
  a workarea (nothing guarantees one, and step 2 removes it), and several
  projects are archived in the one PR per repository. So the runner opens
  `~/mc/runner/archive/<repo>` from origin/main, archives there, and takes
  it down again however the round ends — inside `~/mc/runner/`, which is
  mc's own folder and not a workarea.
- **One archive PR at a time per repository.** The branch is
  `mc-archive-<stamp>`, which is unique per round; an archive PR that never
  merged would therefore be joined by a second one next round removing the
  same directories again. The runner asks for an open PR whose head starts
  with `mc-archive-` first and holds off while one exists.
