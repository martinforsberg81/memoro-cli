# mc tidy — what a finished project costs

A project ends in three places: a plan under `docs/project/`, a workarea
under `~/mc/`, and a name in `~/mc/queue.md`. Until 2026-08-29 none of them
ended by itself. `mc run` answered a plan that said `done` with a `break` —
it stopped working on the project and did nothing else — so the plan stayed,
the workarea stayed, and the queue kept the name. Measured that morning:
`docs/project/` held ten directories whose plan said `done`, `~/mc` held 61
folders of which eleven were finished and merged, and `docs/plans/`, the
directory `docs/project/` replaced, had reached 656 files the same way.

Since then, **`status: done` is the whole trigger**. Nothing is typed, no
verb was added, and no flag turns it off.

This note is what that costs — what is removed, what is kept, and what is
handed to Martin instead of being decided by a machine. The rules are
[`src/mc/archive-plan.js`](../../src/mc/archive-plan.js) and
[`src/mc/close-workarea.js`](../../src/mc/close-workarea.js), both pure
functions of text; the git and `gh` half is `archiveDone`, `closeWorkareas`
and `tidyQueue` in [`src/mc/run.js`](../../src/mc/run.js).

## The order: the plan first, then the workarea

A round reads every `PLAN.json` on both `origin/main`s, and then:

1. **tidies `queue.md`** against that reading,
2. **archives** every plan that says `done`, one PR per repository, and
   merges it like any other,
3. runs its steps,
4. **closes** the workareas whose archive PR merged in step 2.

The order is not cosmetic. A workarea is closed only after the plan that
explains it is off main, so there is never a moment where a folder exists
that nothing on main accounts for. It also means "its plan on main says
`done`" can no longer be asked of main by the time the close runs — so the
close is given the round's own reading, taken before the archive, and the
list of projects whose archive PR actually merged. A done project whose
archive PR failed to merge keeps its workarea, and runner.log says so.

**But the two halves need not be the same round.** They had to be, once: the
close tested `status: done`, so a plan an *earlier* round had already
archived read as "no plan on main" and its folder joined the pile no machine
will touch. Measured 2026-08-30, the close had never once run — the only round
that reached the archive, taking three projects off main, was cut short by STOP
before step 4 — and the next round found three folders it could no longer
explain. The close now asks the record the archive itself writes:
`docs/project/project_log.md` names every project the runner has ever
archived, so a round cut short is finished by the next one.

## What archiving does

`docs/project/<programme>/<project>/` is `git rm -r`'d and one row is
appended to that repository's `docs/project/project_log.md`. Nothing else in
the repository is touched, and `docs/plans/` is out of it entirely.

**The row is preferred, never waited for.** If the project's own close-out
step already wrote a row naming it, the runner leaves that row alone and only
removes the directory — four of the ten done projects on 2026-08-29 were in
exactly that state, which is why this is a rule and not an edge case. With no
row, the runner writes one from the plan: `date` today, `programme` and
`project` from the path, `outcome` `delivered`, `summary` the plan's `next:`
on one line, `doc` the first `docs/technical/…` path the plan names (else
`none`), and `pointer` the PRs the runner merged for it, read out of
`runs.tsv` and linked through the repository's remote slug.

The history is the record. `git log --all -- docs/project/<programme>/<project>`
still answers every question the removed directory could; the row is a
one-line index into it, not a replacement for it.

Two things about the mechanics are worth knowing:

- **The archive gets a worktree of its own**, `~/mc/runner/archive/<repo>`,
  made from origin/main and taken down however the round ends. Not the
  project's own workarea: a done project need not have one, several projects
  are archived in the one PR, and the workarea is removed later in the same
  round.
- **One archive PR at a time per repository.** The branch is
  `mc-archive-<stamp>`, unique per round, so an archive PR that never merged
  would otherwise be joined by a second one next round removing the same
  directories again. The runner looks for an open PR whose head starts with
  `mc-archive-` and holds off while one exists.

## What closing a workarea does

A workarea is **closable** when three facts hold, and no judgement is made
beyond them:

- its project is finished — its plan on main says `status: done`, **or** the
  plan is gone and `docs/project/project_log.md` carries the row the archive
  wrote for it,
- its worktree has no uncommitted change,
- its last row in `~/mc/runner/log/runs.tsv` ends `merged`.

The last two are what keep the second half of the first from taking anything
it should not. A folder somebody made by hand that happens to share a name
with a project archived weeks ago has no runner step to point at, so it is
kept and filed as one nothing explains.

Commit counting against main is deliberately not one of them: the runner
squash-merges, so every finished branch reads as "ahead" forever. A live
tmux session named `mc-<name>` is a fourth refusal rather than a fourth rule
— it is the same check `runStep` already makes, and removing the worktree
somebody is sitting in is the one irreversible thing here.

The close hands the worktree back through the repository that owns it,
deletes the local branch, and moves everything the folder kept beside its
checkout to `~/mc/runner/log/closed/<name>/`. The remote branch and the PRs
stay. Conversations are not a reason to keep a folder — what is current lives
in the plans and in decisions on main — so their index and log files are moved,
never deleted.

**mc deletes nothing itself.** The one thing that is deleted is what `git
worktree remove` takes with it, which is the ignored files: measured across
the seven closable workareas of 2026-08-29 that was `node_modules/`,
`__pycache__/`, `.wrangler/`, `public/dist/` and one generated
`scripts/dev/local-schema.sql` — build output a fresh checkout rebuilds, and
no `.env` and no untracked note. A step that fails stops the rest of that
folder's close and says so; the next round tries again.

A folder is a workarea when it holds `memoro/` or `memoro-cli/`, and nothing
else is. That rule is the same in the runner (`areaRepos`) and on the page
(`areasWithCheckout`), and it is what keeps `bin/`, `brief/`, `inbox/`,
`intake/`, `runner/`, `status/` and the role homes off the board
and out of reach of the close.

## The strict queue

`~/mc/queue.md` is a list of project names and nothing else — no comments, no
headings, no sections. A round rewrites it to that shape: a line that is not
a project name is dropped, so is a name with no plan on main and a name whose
plan is `done`, one runner.log line each. A name leaves the file the moment
its step has *run*, so the file empties itself over a round.

A `blocked` step keeps its place. It has a step ahead of it; a name leaves
because it ran, never because it was skipped.

## What is handed to Martin instead

Two things a machine must not decide, so it writes them down and moves on:

- **`~/mc/runner/undocumented-closures.md`** — appended when a project is
  archived whose row says `doc: none`. A thin or missing `docs/technical/`
  note never stops an archive: keeping a project alive because its
  documentation is thin is how `docs/plans/` reached 656 files.
- **`~/mc/runner/unplanned-workareas.md`** — rewritten every round with every
  folder under `~/mc` that **no project** explains — no plan on main and no
  row in `project_log.md` (sixteen of them on 2026-08-29, from before the plan
  world; fifty-seven on 2026-08-30). Such a folder is work somebody started and
  only Martin can say is finished, so no machine removes one. Each row carries whether the branch's content is already on main —
  asked of content with `git merge-tree`, not of commit counts — which is the
  one fact that says whether anything would be lost. The branch is asked of
  the worktree (`rev-parse --abbrev-ref HEAD`), never guessed from the folder
  name: a workarea from before the plan world was made by hand and need not
  be named after its branch, and a stale branch that *does* carry the folder's
  name would make the column answer confidently about something nobody is on
  (`mc-repo` sits on `cut-old-surface`). `unknown` in that column means
  `merge-tree` hit a conflict, which is itself an answer: a branch that
  conflicts with main holds something main does not.

Both are raised in `mc brief`, which is where they are read: two sections,
*Archived without a note* and *Workareas with no plan on main*, and the brief
role walks them one row at a time after the decisions. An absent file is
reported as absent rather than as "none" — the runner has not written one
yet is a different answer from there is nothing to report.

They sit in `~/mc/runner/`, with the rest of what the runner writes about its
own rounds, and not in `~/mc/intake/` where they were until 2026-09-04: the
inbox is drained one file per turn, and a table rewritten whole every round is
back in it the next round however carefully it was read.

## How it is tested

`tests/mc/archive-plan.test.js` and `tests/mc/close-workarea.test.js` cover
the rules on text: which row a project gets and where it is appended, and the
squash-merge case (branch ahead, plan done, last run merged → closable), the
dirty case, the missing-plan case and the live-session refusal.
`tests/mc/run.test.js` drives whole rounds against fake git, gh and tmux —
the archive PR, the hold-off while one is open, the intake files, the queue
rewrite. `tests/mc/archive-live.test.js` and `tests/mc/close-live.test.js`
run the same against real git repositories and a real work root, which is
where a row already written is left alone and a programme left empty by its
last project is seen to go with it: `git rm -r` and `git worktree remove` are
the two calls whose behaviour a fake would only assert back at itself.
`tests/mc/brief-collect.test.js` covers the two sections that raise the
intake files, including the absent-versus-empty answer.
