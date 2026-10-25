# mc tidy — what a finished project costs

A project ends in three places: a plan under `~/mc/programs/`, a workarea
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
functions of text; the git and `gh` half is `closeWorkareas`
and `tidyQueue` in [`src/mc/run.js`](../../src/mc/run.js).

## The order: the plan first, then the workarea

None of this is a step. It is the runner's **chore loop**, which runs beside
the lanes that take steps ([`mc-run.md`](mc-run.md) § *The pick, in order*)
and sleeps `--idle-sleep` between two passes. One chore pass reads every
`PLAN.json` under `~/mc/programs/`, and then:

1. **tidies `queue.md`** against that reading,
2. **archives** every plan that has been `done` for 24 hours, under
   `~/mc/programs/` (*What archiving does*), its row landing as a docs-only pull
   request,
3. **closes** the step areas of every project that is `done` — with the
   project's scratch directories — and the legacy areas directly under `~/mc`
   whose archive has landed in step 2.

The order is not cosmetic for a legacy area: it is closed only after the project
that explains it is archived, so there is never a moment where a folder exists
that no plan or closeout accounts for. A step area does not wait for the
archive. Its checkout is where the steps ran, and once the register says every
step is `done` it holds nothing the project still needs, so the first pass after
the project is `done` closes it. The close is given the pass's own reading,
taken before the archive, and the list of projects whose archive actually
landed. A step area with a process standing in it (a session, a dev server, or
a live tmux session) or an uncommitted change is kept, and runner.log says so;
so is a done legacy project whose archive has not landed.

**But the two halves need not be the same pass.** They had to be, once: the
close tested `status: done`, so a plan an *earlier* pass had already
archived read as "no plan" and its folder joined the pile no machine
will touch. Measured 2026-08-30, the close had never once run — the only pass
that reached the archive, taking three projects off main, was cut short by STOP
before the close — and the next one found three folders it could no longer
explain. The close now asks the record the archive itself writes:
`docs/project/project_log.md` names every project the runner has ever
archived, so a pass cut short is finished by the next one.

## What archiving does

Until ruling 48 a plan in a repository was archived the same way:
`docs/project/<programme>/<project>/` was `git rm -r`'d and one row was
appended to that repository's `docs/project/project_log.md`, and the
project's closeout is added (§ *The closeout*). Nothing else in
the repository is touched, and `docs/plans/` is out of it entirely.

A project under `~/mc/programs/` takes another route (ruling 48, `src/mc/project-archive.js`). It is archived by `mc project archive <project>`, or by the runner once it has been done for `ARCHIVE_HOLD_MS`, 24 hours. Done is the register's word: the latest of its steps' `updated` and its criteria's `at` is the moment it became done, and a project still inside the hold is said so in `runner.log` and waits. The repository gets one thing only, its row in `docs/project/project_log.md`, landed as a docs-only pull request through `runDocsMerge`; a row already on main is never rewritten or added twice. The plan stays at `~/mc/programs/<programme>/<project>/PLAN.json`, and `CLOSEOUT.json` beside it is the closeout and the mark that the project is archived. Nothing is removed from a repository by this route. No reader of plans lists an archived project, and `--after`, project blockers, the workarea closing and rule P count it as archived. Plans that were in a repository were archived as above until ruling 48 took them out of the repositories (`plans-out-of-repos`). A programme is never archived automatically.

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

Two things about the repository archive's mechanics, which ruling 48 removed,
are worth knowing:

- **The archive gets a worktree of its own**, `~/mc/runner/archive/programs/<repo>`,
  made from origin/main and taken down however the pass ends. Not the
  project's own workarea: a done project need not have one, several projects
  are archived in the one PR, and the workarea is removed later in the same
  pass.
- **One archive PR at a time per repository.** The branch is
  `mc-archive-<stamp>`, unique per pass, so an archive PR that never merged
  would otherwise be joined by a second one next pass removing the same
  directories again. The runner looks for an open PR whose head starts with
  `mc-archive-` and holds off while one exists.

## The closeout

A project archived from a repository left one file in git:
`docs/project/<programme>/closeout/<project>.json` (`src/mc/closeout.js`).
The archive wrote it into the same commit and pull request that removed the
plan, so the plan never left main without it. The project's README, when it had
one, stays beside it as `closeout/<project>.md`. It holds:

- `goal` and `success_criteria`, from the plan as it stood at the archive;
- `steps`: each step's `title` and `done_when` from the plan, and from the
  register its `status`, `pr`, `landed` (`sha`, `into`, `at`), `attempts`,
  `reason` and `comments`, with `sessions`, `seconds` and `cost_usd` summed
  over the sessions whose `pr` is the step's;
- `sessions`: every runs.tsv row of the project that is not the merger's
  (`merge`, `mend`), with `cost_usd` the `total_cost_usd` of the session's own
  result file under `runner/log/` (plain or `.json.gz`), or `null` — runs.tsv
  has no cost column, and a cost is never estimated;
- `totals`: sessions, seconds, land seconds, tokens, the known cost with
  `cost_unknown` counting the sessions without one, the first session and the
  last landing.

A closeout that fails to build is skipped and named in `runner.log`; the
archive goes on. The backfill that wrote closeouts for projects archived before the closeout
existed (`CLOSEOUT_BACKFILL_MAX`, read from git history) went with the
repository archive (ruling 48); the closeouts it wrote stay where they are.

A project under `~/mc/programs/` leaves no file in git. Its closeout is `CLOSEOUT.json` beside its `PLAN.json` in mc, built the same way and written once its row is on `origin/main`, so a closeout never names a row that is not there. That file is also the mark that the project is archived: `programsPlans` stops listing the project, and `programsArchived` lists it.

The closeout is what lets a project's local data go: the register file is
removed only once the closeout is on `origin/main`, or, for a project under `~/mc/programs/`, once its `CLOSEOUT.json` is beside its plan.

## What closing a workarea does

A workarea is **closable** when three facts hold, and no judgement is made
beyond them:

- its project is finished — its plan under `~/mc/programs/` says `status: done`, **or** the
  plan is gone and `docs/project/project_log.md` carries the row the archive
  wrote for it,
- its worktree has no uncommitted change,
- for an area at `~/mc/step/<project>/`, every step of the project is `done`
  in the register; for one left directly at `~/mc/<project>/`, its last row in
  `~/mc/runner/log/runs.tsv` ends `merged`.

The runner's areas live at `~/mc/step/<project>/<repo>` (ruling 39). Areas
left at `~/mc/<project>/` from before that drain in place: stepped, closed and
removed where they stand, never moved.

The last two are what keep the second half of the first from taking anything
it should not. A folder somebody made by hand that happens to share a name
with a project archived weeks ago has no runner step to point at, so it is
kept and filed as one nothing explains. Under `step/` that cannot happen —
only the runner makes areas there — so the register's word is enough, where
the last-run rule had kept done areas open on `success,blocked` and
`success,failed` (106 rounds of it on 2026-10-11).

Commit counting against main is deliberately not one of them: the runner
squash-merges, so every finished branch reads as "ahead" forever. A live
tmux session named `mc-<name>` is a fourth refusal rather than a fourth rule
— it is the same check `runStep` already makes, and removing the worktree
somebody is sitting in is the one irreversible thing here.

The close hands the worktree back through the repository that owns it,
deletes the local branch, and moves everything the folder kept beside its
checkout to `~/mc/runner/log/closed/<name>/` — `<name>` the project, wherever
its area stood — before the emptied directory is removed (not recursively).
The remote branch and the PRs
stay. Conversations are not a reason to keep a folder — what is current lives
in the plans and in decisions on main — so their index and log files are moved,
never deleted.

**mc deletes nothing itself.** The one thing that is deleted is what `git
worktree remove` takes with it, which is the ignored files: measured across
the seven closable workareas of 2026-08-29 that was `node_modules/`,
`__pycache__/`, `.wrangler/`, `public/dist/` and one generated
`scripts/dev/local-schema.sql` — build output a fresh checkout rebuilds, and
no `.env` and no untracked note. A step that fails stops the rest of that
folder's close and says so; the next pass tries again.

A folder is a workarea when it holds `memoro/` or `memoro-cli/`, and nothing
else is. That rule is the same in the runner (`areaRepos`) and on the page
(`areasWithCheckout`), and it is what keeps `bin/`, `brief/`, `inbox/`,
`intake/`, `runner/`, `status/` and the role homes off the board
and out of reach of the close.

## The strict queue

`~/mc/queue.md` is a list of project names and nothing else — no comments, no
headings, no sections. Every chore pass rewrites it to that shape (`tidyQueue`,
by `strictQueue`'s rule): a line that is not a project name is dropped, so is a
name given twice, a name with no plan, a plan still written as
`PLAN.md` and a name whose plan is `done`, one runner.log line each. **That is
the whole rule: a name leaves when its plan is `done` or off `main`.**

Until 2026-09-08 a name also left the moment its step had *run*, and the file
emptied itself over a pass through the queue. That made sense while the runner
tried every name once per pass; with the order as the only thing a lane goes by
([`mc-run.md`](mc-run.md) § *The queue*), a prioritised five-step project would
have dropped to alphabetical after its first step and the file would have
stopped meaning *these first*.

A `blocked` step keeps its place too: the moment it is `ready` again, it is
first again.

## What is handed to Martin instead

Two things a machine must not decide, so it writes them down and moves on:

- **`~/mc/runner/undocumented-closures.md`** — appended when a project is
  archived whose row says `doc: none`. A thin or missing `docs/technical/`
  note never stops an archive: keeping a project alive because its
  documentation is thin is how `docs/plans/` reached 656 files.
- **`~/mc/runner/unplanned-workareas.md`** — rewritten every chore pass with every
  runner area — under `~/mc/step/`, or left directly under `~/mc` — that
  **no project** explains — no plan and no
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

Both are raised in `mc brief`, which is where they are read: the role sends
the session to the two files, and it walks them one row at a time. An absent file is
reported as absent rather than as "none" — the runner has not written one
yet is a different answer from there is nothing to report.

They sit in `~/mc/runner/`, with the rest of what the runner writes about its
own work, and not in `~/mc/intake/` where they were until 2026-09-04: the
inbox is drained one file per turn, and a table rewritten whole every pass is
back in it the next pass however carefully it was read.

## mc tidy

`mc tidy [--apply] [--json] [--days <n>]` (`src/mc/tidy.js`, the verb in
`src/mc/commands/tidy.js`; `mc work tidy` is the same command) removes what
the chores above leave behind, per root of
[Ruling 39](../project/mc/rulings.md) § 39. It exists because of 2026-09-26: the
data volume had 2.6 GB free, and a shell loop meant to remove orphaned
transcripts read a `find` that errored as "nothing here" and deleted nearly all
of `~/.claude/projects`, every `memory/` with it. So most of it is about what
stays.

| Root | What lives there | What tidy may remove |
|---|---|---|
| `~/mc/plan/<programme>/` | a planning area: `memoro/`, `memoro-cli/`, extra worktrees | an extra worktree whose content is on main (X); a programme's own checkouts once it has no project that is not done (I) |
| `~/mc/step/<project>/` | a step area the runner made | nothing (S) |
| `~/mc/work/<name>/` | a work area `mc work` made | nothing (W) |
| `~/mc/runner/` (state) | `projects/`, `log/`, `log/closed/`, `scratch/` | an archived project's files (P) |
| `~/.claude/projects/` | transcripts, `<uuid>/`, `memory/` | transcripts and leftovers (P, G, L) |
| `~/mc/gate-cache/`, `~/mc/gate/`, `~/.memoro/mc/selection/` | a directory per repository slug (`repoFileSlug` of its path) | a slug directory no repository mc knows hashes to, untouched for a day, with no process in it (K) |

In layout 2 the planning areas are `~/mc/programs/<programme>/`, of which tidy removes only git worktrees (X) and a programme's own checkouts once it is idle (I), and the registers sit beside their plans ([mc-layout.md](mc-layout.md)).

**P — an archived project.** A register entry under `runner/projects/` whose
repository's origin/main has its row in `project_log.md`, no plan directory,
and its closeout (`docs/project/<programme>/closeout/<project>.json`; for a project under `~/mc/programs/`, its `CLOSEOUT.json` beside its plan, which is then no plan directory), and
which has no area on this machine — neither `step/<project>` nor a legacy
`~/mc/<project>`. Its session logs (`<project>-<stamp>.{jsonl,json,json.err}`,
gzipped or not), `log/closed/<project>/`, its scratch directories, the
transcripts of its step area, and last its register file, so a run cut short
finds the project again. Names are matched exactly: `ui-faults` never takes
`ui-faults-2`'s files. A repository git cannot answer for stops every purge
that run.

**G — planning transcripts.** Per `~/.claude/projects/<dir>`, the transcripts
whose cwd is in `plan/<programme>`: the newest stays at any age, and so does
anything touched within `PROGRAMME_TRANSCRIPT_KEEP_MS` (72 hours). Martin,
2026-10-11: "alltid behålla den aktuella; gamla kan städas efter 72h". One
transcript in that directory that cannot be read keeps the whole group: it may
be the newest.

**X — a planning area's extra worktree.** Anything under `plan/<programme>/`
but `memoro/` and `memoro-cli/`, judged by `releaseVerdict` as `mc work
release` judges it: no process stands in it, nothing uncommitted, and its
content on main (or its tip a merged pull request's head). Removed with
`git worktree remove` without `--force`, then `branch -D`. One `lsof` answers
for all of them; an lsof that fails keeps every one.

**I — a planning area's own checkouts** (`memoro/`, `memoro-cli/`, made by
`ensurePlanArea`) go while their programme has no project that is not done.
A project is not done when it has a draft (`DRAFT.json`), or a sent plan with no
`CLOSEOUT.json` beside it whose register entry is not done: a step not `done`, or
a criterion not met. A register that cannot be read counts as not done. The
checkout is judged by the release verdict as X judges it, but no process may
stand anywhere in the programme's directory, since a planning session stands
there and not in the checkout. Removed the same way as X, and `mc plan
<programme>` adds it back when it next opens the programme. An lsof that fails
keeps every one, with its error.

**W — work areas** are listed with the rule `work-area` and never removed:
only `mc work release` or `mc work discard` removes one. **S — step areas**
are the runner's, closed by `closeWorkareas` when the project is done.

**L — loose transcripts and leftovers.** What P and G leave, by T1–T5, first
match wins: no cwd, kept; touched within `--days`, kept; its cwd gone,
removed; its cwd in an area, removed unless it is that area's latest; outside
the work root, kept. A `<uuid>/` with no transcript beside it and nothing
inside touched within `--days` is a leftover and goes.

**R — foreign worktrees.** Worktrees git knows of outside the work root
(`/private/tmp/claude-*`, `memoro/.claude/worktrees/agent-*`) are listed with
the rule `foreign-worktree` and never removed. After an apply,
`git worktree prune` runs on both repositories.

**C — `mc shot --compare` trees.** The detached worktrees `shot-compare.js`
makes under `~/.memoro/mc/compare/` (`tidyRoots().compare`, under mc's home,
not the work root). One goes when it has not been used for `COMPARE_KEEP_MS`
(a day) and no live dev server stands in it (`serversFor`). Last use is the
directory's mtime, and that is only true because `compareTree` touches the
directory when it reuses one (a reuse writes nothing in it). The tree is
removed with `git worktree remove`, without `--force`, run in the repository
git names as its owner (`rev-parse --git-common-dir`), read again at the
apply. A tree with edits, or one whose server started after the list was
written, stays. These trees are no longer listed as `foreign-worktree`.

**K — slug directories no repository mc knows has.** The gate's directories
(`~/mc/gate/<slug>/` and `~/mc/gate/<slug>-freshen/`), its dependency cache
(`~/mc/gate-cache/<slug>/`) and its selection state
(`~/.memoro/mc/selection/<slug>/`) are named by `repoFileSlug` of a repository's
path, a hash of it, so a moved repository leaves its old directories where
nothing reads them again. A slug is known when it hashes to a repository's bare
path or its checkout (`defaultRepos`), and `<slug>-freshen` is known by its
`<slug>`. A known slug is never a target, whatever its age. An unknown one goes
when no file under it was touched within a day and no process stands in it
(`processesStandingIn`), through `rmTree`, which takes read-only files too. A
slug that is not a direct child of its root is refused at the apply. Measured
2026-10-25, after the move to `~/mc/repos/*.git`: `~/mc/gate-cache/memoro-a66fc130/`
(the hash of `/Users/martinforsberg/memoro`) held 2 GB until it was removed by
hand, and `~/.memoro/mc/selection/` held `memoro-1ee6756a`, `memoro-76f950b8`,
`memoro-ffede537` and `memoro-cli-1d5e7a04` beside the live `memoro.git-17111bc1`
and `memoro-cli.git-365b96c6`.

### The list file

Every run, the dry run too, writes `~/mc/runner/tidy/<yyyymmddThhmmssZ>.json`
with `writeJsonAtomic` before anything is removed:
`{ at, rules_version, days, targets: [{ path, kind, rule, why, bytes }], kept: [{ path, rule, why }] }`.
`--apply` reads that file back and acts on its `targets` only. Each one is
asked again: its realpath must lie under the root its kind allows, in the
shape that kind has, and its rule must still say so on facts read now. A
target that fails either, or whose check throws, is kept with the reason.
What happened is appended to the same file as `applied: [{ path, ok, why }]`,
and logged as `tidy` with counts. The newest 30 list files are kept.

### When it runs

`mc tidy` by hand prints the counts and bytes per rule, the first ten targets,
every keep worth reading, and the list file; `--json` prints the list. The
runner runs `mc tidy --apply` once a day by its own `runs.tsv` row (kind
`tidy`, note `freed=<bytes>,items=<n>,kept=<k>`). It also runs it in the first
chore pass after a lane skipped for disk, at most once per hour
(`TIDY_DISK_MIN_INTERVAL_MS`, remembered in memory). In the same pass
`runner.log` moves to `runner.log.1` once it passes 32 MiB
(`RUNNER_LOG_MAX_BYTES`).

### Docker

Docker's images and build cache are not files under a root, so they are not
in the list. `tidyDocker` (`src/mc/docker.js`) prunes them after the list has
been applied: `docker image prune --all` and then `docker builder prune --all`,
both with `--filter until=72h`. Docker itself never removes an image that a
container uses, so a running gate or dev server keeps its own. The dry run
removes nothing and reports `docker system df`'s reclaimable sizes. Those
sizes are an upper bound, because they ignore the three days. A failed prune
is printed as a line and makes the run exit 1. The file half still stands.

The runtime is asked through `runtimeOf`, which on OrbStack means
`orbctl status`, because any `docker` call starts the VM. A runtime that is
down is never started, not by the runner's run and not by `mc tidy --apply`.
It is left down and the output says so. `mc tidy --docker` tidies Docker and
nothing else. With `--apply` it starts the runtime through `ensure`, under a
lease for its own pid, and releases the lease when it is done, so the
runner's idle stop stops it again ([`mc-docker.md`](mc-docker.md)). Martin
asked for both on 2026-10-19. On 2026-10-10 OrbStack held 21 images (17 GB)
on an 8 GB machine whose disk was 98 % full. `mc deploy`'s prune after a
container rollout keeps a week of images. This keeps three days and also
reaches the build cache.

The runner's tidy line ends with what Docker reclaimed
(`· docker: images 12.4GB, build cache 2.1GB`), and has no such ending when
the runtime was down.

### Never touched

A work area; a planning area's `memoro/` and `memoro-cli/`; a worktree with
uncommitted changes or commits main lacks; any `memory/` under
`~/.claude/projects`; `runs.tsv`; `~/.memoro/mc/gate-rounds.jsonl`;
`project_log.md`; anything outside the roots above. No `git worktree move`
and no `--force`. Deletion goes through node `fs`, with no shell, no `find`
and no globbing.

## How it is tested

`tests/mc/archive-plan.test.js` and `tests/mc/close-workarea.test.js` cover
the rules on text: which row a project gets and where it is appended, and the
squash-merge case (branch ahead, plan done, last run merged → closable), the
dirty case, the missing-plan case and the live-session refusal.
`tests/mc/run.test.js` drives the chore pass against fake git, gh and tmux —
the archive PR, the hold-off while one is open, the intake files, the queue
rewrite. `tests/mc/close-live.test.js` runs the same against real git repositories
and a real work root, which is where `git worktree remove` is the call whose
behaviour a fake would only assert back at itself.
`tests/mc/brief-collect.test.js` covers the two sections that raise the
intake files, including the absent-versus-empty answer.
`tests/mc/tidy.test.js` runs `mc tidy` over a temp home with git faked: each
rule's targets and keeps, the list written before the first removal, a rule
that flips between the list and the apply, and a hand-edited list that names
a path outside the roots.
