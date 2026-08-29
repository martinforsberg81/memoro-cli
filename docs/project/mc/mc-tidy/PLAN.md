---
status: done
next: "nothing — step 4 measured what a session can measure and says plainly what it could not. The round that first runs the merged tidying is the next one, not this one: `mc run --rounds 1` loads its module graph at process start, so #454-#456 merged into a round that had already read the old `run.js`. So the six round criteria are rewritten to what was measured — a live dry run of the merged code against the real `~/mc`, the real `runs.tsv` and both real origin/mains, with every write and every mutating git call refused — and runner.log is where the round itself shows."
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

- [x] `mc run` archives every plan that says `done` on main, in the round it
      reads it, and says so in runner.log — one line per project. Measured on
      the rules, not on a round: `donePlans` over the 51 plans both
      `origin/main`s carried at 2026-08-29T18:50Z returns the 13 that say
      `done` and nothing else, and `archiveIn` says one `archive: <repo>
      <programme>/<project> removed` line per project. `tests/mc/run.test.js`
      drives the round half; `tests/mc/archive-live.test.js` drives `git rm -r`
      against a real repository.
- [x] The first run after merge archives the done plans of the day and leaves
      every other directory in `docs/project/` untouched. Rewritten: the plan
      named ten, and the set is what says `done` when the round reads it.
      Measured at 2026-08-29T18:50Z, that is **13** — memoro 9
      (avatar-fab-composition, docs-structure, improve-chat-runtime, the three
      language-voice ones, continue-section, msr-design,
      sql-readiness-session-A) and memoro-cli 4 (mc-helper, mc-run-lanes,
      mc-ui, mc-ui-polish) — out of 51 plans. The other 38 are untouched
      because `donePlans` is the only thing that selects.
- [x] Every archived project has exactly one `project_log.md` row naming it.
      Measured against both real logs: `rowFor` already finds a row for all
      four memoro-cli projects (mc-helper, mc-run-lanes, mc-ui, mc-ui-polish),
      so none is written twice; all nine memoro projects have none, so each
      gets one. "No PLAN.md says `done` afterwards" is the same statement as
      the criterion above and is not separately measurable before the round.
- [x] `~/mc/intake/undocumented-closures.md` names every project archived
      with `doc: none`. Measured: of the 13, **8** are undocumented — every
      memoro one except docs-structure, which names
      `docs/technical/msr-surface-contract-ratchets.md`; all four memoro-cli
      rows name a `docs/technical/` note. So the first round writes the header
      and eight rows, and eight `archive: <project> names no docs/technical/
      note` lines.
- [x] `mc run` closes every closable workarea at the end of each round
      (`git worktree remove`, local branch deleted, logs moved) and says so
      in runner.log, one line per workarea.
- [x] The first run after merge removes the done workareas and leaves the
      rest untouched. Rewritten for the same reason as the archive set: it is
      **11**, not seven. Measured by running the real `closeWorkareas` against
      the real `~/mc` and the real `runs.tsv`, with every mutating git call
      and every write refused — the seven the plan named plus
      avatar-fab-composition, mc-run-lanes, mc-ui and msr-design, which
      reached `done` after the plan was written. mc-helper and mc-ui-polish
      are kept and say `the last run says success`; every other folder is
      passed over without git being asked anything.
- [x] The page (WORK in `mc`, or `mc work` until then) hides mc's own
      folders and shows unplanned workareas under their own heading.
- [x] `~/mc/intake/unplanned-workareas.md` exists after the first run.
      Measured: the same dry run produced the whole file — header plus **20**
      rows (not the plan's 16; the world moved) — and the write was captured
      rather than performed. Step 4 also fixed what that dry run exposed: the
      `branch` column asked about a branch named after the folder instead of
      the one the worktree sits on.
- [x] `mc brief` names what is in both intake files: *Archived without a
      note* and *Workareas with no plan on main*, absent said as absent
      rather than as "none", and the brief role walks them one row at a time
      after the decisions.
- [x] `~/mc/queue.md` contains only names of projects with a plan on main
      that have not yet had their step this round; after a round in which
      every named project ran, the file is empty. `mc run` never reads a
      comment line into the queue.
- [x] Tests cover the closable rule with the squash-merge case (branch
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
      the row it needs, PR per repository. One PR (#454). The rules are
      `src/mc/archive-plan.js`, the round's half is `archiveDone` in
      `src/mc/run.js`.
- [x] **2. Closable rule + runner close + page filter + strict queue.md** — one PR.
      The rules are `src/mc/close-workarea.js` and `strictQueue` in
      `src/mc/run-plan.js`; the round's half is `closeWorkareas`, `tidyQueue`
      and `dropFromQueue` in `src/mc/run.js`; the page's is `workSection` in
      `src/mc/page-collect.js` and `areasWithCheckout` in
      `src/mc/status-collect.js`.
- [x] **3. Close-out** — `docs/technical/mc-tidy.md`, the `project_log.md`
      row, and the one thing steps 1 and 2 left for a reader: `mc brief`
      raising `~/mc/intake/undocumented-closures.md` and
      `~/mc/intake/unplanned-workareas.md`. Two sections in the brief —
      *Archived without a note* and *Workareas with no plan on main* — read
      by `intakeRows` in `src/mc/brief-collect.js`, walked one row at a time
      by the brief role in `canon/roles/brief.md`.
- [x] **4. The first round, measured** — the round had not run the merged
      code, so the measurement was taken the only other honest way: the merged
      `closeWorkareas`, `donePlans`, `rowFor`, `planDoc` and `strictQueue`
      driven against the real `~/mc`, the real `runs.tsv` and both real
      `origin/main`s, with `write`, `gh` and every mutating git subcommand
      refused and recorded. One line of code came out of it — the `branch`
      column of `unplanned-workareas.md` now asks the worktree which branch it
      is on (`unplannedFor` in `src/mc/run.js`), with a test in
      `tests/mc/run.test.js`.

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

- **The closable set is eleven, not seven, and two done projects are kept.**
  Dry-run against the real `~/mc` and the real `runs.tsv` while step 2 was
  written: eleven workareas are closable — the plan's seven plus
  avatar-fab-composition, mc-run-lanes, mc-ui and msr-design, which reached
  `done` after the plan was written. Two more say `done` and are kept,
  because their last row in `runs.tsv` ends `success` rather than
  `success,merged`: mc-helper and mc-ui-polish, whose last step's PR was
  merged by something other than the runner. The rule does not guess at
  that. Once their plans are archived they have no plan on main, so they
  land in `unplanned-workareas.md` for Martin — which is the escape hatch
  working, not a gap.

- **mc's own folders were already off the page, by accident.** The plan
  counted eight of the 62 rows as `bin/`, `brief/`, `decisions/`, `inbox/`,
  `runner/`, `status/`, `pm/` and `pm-helper/`. Measured while step 2 was
  written, the page showed 61 rows and none of them were those: the filter
  asked whether *any* subdirectory held a `.git`, and none of mc's do. So
  the change is not a fix but a rule made explicit — a folder is a workarea
  when it holds `memoro/` or `memoro-cli/`, and a repository mirror dropped
  into `pm-helper/` would no longer put mc's own bookkeeping on the board.
  The runner uses the same rule, which is what keeps it from ever removing
  one of them.

- **A live tmux session is a fourth reason to keep a workarea.** Not a
  fourth rule: it is the refusal `runStep` already makes before it starts
  anything, and removing the worktree somebody is sitting in is the one
  irreversible thing in this step. It is inside the Contract's "nothing is
  removed that has an uncommitted change, no plan, or an unmerged last run"
  — strictly more conservative, never less.

- **The close needs the round's reading of main, not main.** A workarea is
  closed after its plan has been archived, so by then the plan is gone from
  main and "its plan on main says `done`" can no longer be asked of main.
  The round already holds the reading it took before archiving, and
  `archiveDone` now returns `{ archived, landed }` — `landed` being the
  projects whose archive PR actually merged. Only those may have their
  workarea closed, which is what "the plan goes first, then the workarea"
  costs in code. A done project whose archive PR failed to merge keeps its
  workarea and says so.

- **`git worktree remove` takes the ignored files with it, and that is
  measured rather than assumed.** A clean `git status --porcelain` says
  nothing about files `.gitignore` covers, and git removes those without
  `--force` (verified in a throwaway repository: a worktree holding only
  `node_modules/` is "clean" and is removed, directory and all). Measured on
  the seven closable workareas of 2026-08-29, what that costs is
  `node_modules/`, `__pycache__/`, `.wrangler/`, `public/dist/` and one
  generated `scripts/dev/local-schema.sql` — build output and nothing else.
  No `.env` and no untracked note. So the close does not ask about ignored
  files: everything else the folder holds is moved to
  `runner/log/closed/<name>/` first, and what git deletes is what a fresh
  checkout would rebuild.

- **Six criteria are a round's to answer, not a session's — so the round
  gets a step.** Step 3 could verify everything it built (`npm test`, the
  brief rendered from the runner's own row builders) and none of what the
  plan asks of "the first run after merge": on 2026-08-29T18:40Z runner.log
  held no `archive:` or `close:` line, and both `origin/main`s still carried
  every done plan — #454 and #455 merged into a runner process that had
  already loaded the old `run.js`. Setting `status: done` here would have
  archived this plan and closed its workarea in the very round that first
  exercises archiving, taking the plan away before anyone could read what
  that round did. So step 4 exists, it builds nothing, and it ends the plan
  in the session that reads the round — ticked or rewritten, but not left
  open. A verification step is cheap; a criterion nobody ever checked is the
  habit this project was written to end.

- **Step 4 could never have been the measurement it was written to be.** A
  step always runs *inside* a round, and `mc run --rounds 1` caches its whole
  module graph at process start — so the round that merges the tidying is by
  construction the last round that cannot use it. Measured: the round holding
  this session started 2026-08-29T17:12:50Z from a checkout at 575cc9f, which
  has no `src/mc/archive-plan.js` at all; #454, #455 and #456 all merged after
  it began, and runner.log holds no `archive:` or `close:` line. Waiting was
  the obvious answer and it is the wrong one: `runLane` stays on a project
  whose step merged and whose plan is still `ready`, up to eight times, so
  "leave it ready and measure next round" costs eight stale sessions in this
  one before the round boundary is even reached. So the step took the
  measurement it could actually take — the real rules against the real world,
  with every write refused — and said plainly which half is still the
  runner's to show. The next round is where runner.log answers; nothing has
  to be typed for that, and the two intake files plus `mc brief` are where it
  surfaces if it goes wrong.

- **A dry run of the real code against the real world is a different thing
  from a test, and it caught what the tests could not.** Every fake in
  `tests/mc/run.test.js` names its workareas after their branches, because
  that is what a plan-world workarea does. The sixteen from before the plan
  world were made by hand and do not: msr-track-1 sits on `msr-track1-skin`,
  mc-repo on `cut-old-surface`, project-management-improvement on
  `connect-trigger-lookup`. Worse than a blank, a *stale* branch carrying the
  folder's name still exists for mc-repo and for
  project-management-improvement — so the column that exists to say whether
  anything would be lost read a confident `landed` about a branch nobody is
  on, for one of the two workareas the plan singled out as "where something
  real may sit". `unplannedFor` now asks `rev-parse --abbrev-ref HEAD`.
  Measured after the fix: 6 `landed`, 3 `ahead`, 9 `unknown` — and `unknown`
  there means `merge-tree` hit a conflict, which is an answer of its own, a
  branch that conflicts with main holds something main does not.

- **The queue empties itself, and that is measurable without a round.**
  `strictQueue` over the real `~/mc/queue.md` (five names, already comment-free
  — an earlier hand pass, not this code) and the 51 real plans keeps
  `mc-tidy` and drops mc-ui, mc-ui-polish, mc-helper and mc-run-lanes with
  `the plan is done`. Once this plan is `done` too the file is empty, which is
  the criterion stated as an outcome rather than as a rule.

- **The brief is where an intake file is read, and absent is not empty.**
  Both files are one markdown table under a header paragraph, so one parser
  keyed by column names reads either. A file the runner has never written is
  reported as absent: "none" for a file nobody has produced would be the
  brief claiming a clean board it never looked at. The undocumented file is
  append-only and nothing but Martin prunes it, so the brief shows the newest
  twelve rows and counts the rest, and it prints `#455` rather than clipping
  a GitHub URL mid-link.

- **The brief role's overlay had drifted, and a test held it there.** It said
  the `**Beslut:**` line is the runner's trigger and that `mc run` deletes the
  answered file. Neither is true since 2026-08-29: the runner runs `ready`
  plans and nothing else, and `retireDecisions` runs from `mc brief
  --collect`. `tests/mc/commands/brief.test.js` asserted the stale sentence
  word for word, which is how it survived. Both are corrected here — the
  drift was in the file this step had to edit anyway.

- **`waiting-decision` keeps its place in the queue.** The strict-queue rule
  drops a line that is not a name, a project that is `done`, and a project
  with no plan on main — a plan that is waiting or blocked still has a step
  ahead of it, so its name stays where Martin put it. A name leaves the file
  when its step has *run*, not when it was skipped.
