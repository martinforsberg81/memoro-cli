# mc plan — a session in a directory, told which programme it is for

```
mc plan [<programme>] [--new] [--codex|--claude] [--model <m>]
mc plan <programme> --archive
```

This is the person's entrance, not an instruction to a session already
planning. It opens or resumes an interactive foreground session in
`~/mc/programs/<programme>/` with both repositories checked out, and hands it one
prompt naming the programme and where it stands; what a planning session is
for is the `plan` role's to say. Martin is at the terminal for all of it.
`--archive` is the one other thing it does: it ends a programme
([below](#archiving-a-programme)).

The current directory is `~/mc/programs/<programme>/`. Legacy layout 1 uses
`<work root>/plan/<programme>/`; [mc-layout.md](mc-layout.md) describes compatibility.

**It predicts nothing beyond that**, and that is the point rather than an
omission. How many projects the programme needs, what they are called, whether
a plan comes out of this session at all, and by what route it reaches `main`
are not knowable when the session opens (Martin, 2026-08-31: "Hur en EVENTUELL
PLAN SENARE SKA LÄGGAS PÅ MAIN OCH I VILKET PROJEKT GÅR INTE ATT FÖRUTSÄGA").
They are worked out in the session. A prompt that answers them in advance is
guessing, and a session that follows the guess does the wrong work
confidently.

An earlier version of this verb did guess. Its prompt and its role overlay
between them named a programme document, one `PLAN.json` per project "that can
start now", a PR titled `Plan: <programme>`, and the `mc merge --docs` that
lands it. All of that is gone.

## A programme, and why it is not a workarea

A programme is the initiative the work serves — `msr-core`, `sql-readiness`,
`mc` — and it outlives every project under it. A project is what `mc run` runs:
one `PLAN.json` under `~/mc/programs/`, one branch, one workarea, archived by the runner's
next chore pass once its plan says done.

`mc plan <name>` used to make `~/mc/<name>` on branch `<name>` — then exactly the
directory and the branch the runner gives the project of that name. One word
was the session, the project and the workarea at once, so the planning session
sat in the folder `mc run` would later merge into, close and hand back to git,
and it read as an *unplanned workarea* to `mc status` and to the runner's own
closing pass every time it ran.

A planning session and a project's workarea are not the same kind of thing. A
planning session is Martin's, lasts as long as it takes, and holds both
repositories because a programme may span them. A project's workarea is the
runner's, holds one repository, and is removed once its plan says done
(Martin, 2026-08-31 — "en mc plan sessions workarea ska aldrig vara hopkopplad
till något som körs av mc run").

So a planning session lives at:

```
~/mc/programs/<programme>/
├── memoro/        worktree on branch plan/<programme>
└── memoro-cli/    worktree on branch plan/<programme>
```

`~/mc/programs/` is mc's own directory, beside `runner/`, `intake/` and `brief/`.
**The runner does not treat a programme's checkouts as step areas.** Current
step areas are under `~/mc/runner/step/`, and ordinary workareas under
`~/mc/work/`. The runner reads project plans and goals under `programs/`, but
never turns the programme session's `memoro/` or `memoro-cli/` worktree into a
step area. The layout names live in [`paths.js`](../../src/mc/paths.js).

The session's working directory is the programme directory itself, not either
checkout: both repositories are siblings under it, and a programme that spans
them should not have to be opened in one of them by guess.

## Choosing a programme

With no programme named, `mc plan` asks — a numbered list, `n` to name a new
one, and Enter on nothing to walk away. Never when there is nobody to answer: a
pipe or a script gets the usage line, as [`prompt.js`](../../src/mc/prompt.js)
requires of every question mc asks. `p` on the page ([`mc`](mc-status.md))
takes the same route, with or without a name.

The list is built by `programmeRows` from three readings that are deliberately
separate:

| reading | question it answers |
|---|---|
| `listProgrammes` — `git ls-tree -d origin/main docs/project/` | which programmes **exist** |
| `listPlans` — the `PLAN.json` files under `~/mc/programs/` | what is **in** them |
| `openPlanAreas` — the directories under `~/mc/programs/` | which are **being planned** |

Asking only the second would drop a programme whose projects the runner has
already archived: the directory is left holding its own documents, with no
`PLAN.json` anywhere under it. Measured against the two repositories on
2026-08-31 that is 3 of 17 — `docs-navigation`, `legal-readiness`,
`sql-readiness` — and they are exactly the ones the offer matters most for,
because the next piece of that work belongs under the heading that already
exists rather than under a parallel one somebody invents.

The third reading is what makes a programme re-openable before it is anywhere
on main.

## What the verb does

[`src/mc/commands/plan.js`](../../src/mc/commands/plan.js) first refuses a caller that is already a session, then does four things.
The refusal reads `MC_ROLE`, older goal/step identity and cwd, or the coding
agent markers `CLAUDECODE`, `CODEX_THREAD_ID`, `CODEX_SESSION_ID` and `CODEX_CI`.
It names the caller and points to `mc project new`, `mc project step add` and
`mc project send`; it opens nothing. Help remains available inside a session.

**Refuses a reserved name.** `mc plan pm` would make a directory wearing the
name that means "the singleton role's workspace". `reservedRoleName` is the
guard the other role verbs use too.

**Makes the session's directory if it is missing**, in `ensurePlanArea`:
`~/mc/programs/<programme>/` with a worktree of **every** repository mc knows, each
on branch `plan/<programme>` **from `origin/main` after a fetch**. The base
matters more here than anywhere else: a session opened on a stale local branch
reads a `docs/project/` that has already moved. An existing directory is used
as it stands and only what is missing is added, so re-opening a programme
carries on rather than starting again. A repository that is not on this machine
is said and skipped rather than refused — a programme is usually planned
against one of the two, and losing the session over the other's absence helps
nobody. Nothing at all is the only failure.

**Assembles the prompt**, in `planLaunch` — a pure function, so a test can read
it without starting anything.

**Hands it to `openInWorkArea`** with `pick: null` — the conversation already
in the programme directory is resumed, with no intro, and a new one starts
only when there is none or `--new` says so (Martin, 2026-09-13: "Existerar
det en session, ska samma öppnas utan intro"). It is the same launch path
`mc brief`, `mc helper` and a project opened from the page use:
[`src/mc/work-open.js`](../../src/mc/work-open.js), `spawn` with `stdio:
'inherit'`. There is no second launcher. NOW says `plan` for exactly as long as
the session holds the terminal, through the foreground register.

`--repo` is gone. It chose which repository to make the old project-shaped
workarea in; a programme is not in one repository, so the flag has nothing left
to select. It is refused with that sentence rather than as an unknown flag,
because "unknown flag" reads like a typo to whoever typed what worked
yesterday.

## What the session is told

The opening prompt names the programme, `~/mc/programs/<programme>/`, its
repository worktrees on `plan/<programme>`, and the project directories beside
them. It says plans change only through `mc project` and `mc step`, keeps the
project-named branch for the runner, then waits for Martin. A resume gets no
opening prompt.

The launch sets `MC_ROLE=plan-session` and `MC_PROGRAMME=<programme>` on both a new
conversation and a resume. A SessionStart hook names the role in its first
line, including a session Martin opens by hand in that programme directory.
The role and the hook both say never to run `mc plan` from inside the session.
The runner also starts a headless plan session on a blocked goal, with the
same role ([mc-goals.md](mc-goals.md) § *A blocked goal wakes plan*).

Behind the prompt are `canon/roles/all-sessions.md` and `canon/roles/plan-session.md`, assembled by `instructionsFor` the way every other role
session's instructions are ([`mc-roles.md`](mc-roles.md)). The role file was
frontmatter and no body until #656 — the model and the tools, and nothing about
planning — and `planLaunch` had to read `sharedRoleText()` and fold it into the
prompt itself, because a role with no overlay inherits nothing through the
assembler. With a body it inherits like the rest, so that fold is gone and the
`shared` parameter with it; folding it in as well would tell the session the
same rules twice.

What the role says is what a plan session *is* (Martin, 2026-11-03): the
programme's aim, written in `~/mc/programs/<programme>/README.md`, and full
freedom to move the programme toward it — goals and plans as means, building
and landing work itself, taking over a goal's branch when that is quicker than
a new build session. Interactive, it has no restrictions; headless, it never
does Martin's acts (`mc deploy`, production data, credentials, `--admin`). It
also says where it stands, `~/mc/programs/<programme>/` and why that is not a
workarea, and that a step parked on `blocked_by: plan-review` is its own. How
`mc project`, `mc step` and `mc goal` are used are verb files it includes —
`project-verb.md` (with how a plan is written) and `step-verb.md`, which
`canon/roles/brief.md` includes too, and `goal-verb.md`. None of that predicts
this programme's deliverable, which is what the prompt is still held to.

The role also says the checkouts stay on `plan/<programme>`, and that a
planning session never checks out or creates a branch named after a project.
It said only "you create neither" until 2026-09-26, when a planning session in
`<work root>/plan/entity-detail/memoro` (the old layout) wrote a plan on a local branch named after the
project and stayed on it: the runner's `addWorktree` (`src/mc/work-area.js`)
found that branch, git refused to check it out a second time, and the step went
`blocked` on `worktree-missing` until somebody detached the planning tree.

Since 2026-10-14 the role and the launch prompt also name the pull request's
branch `plan/<project>`, and the runner refuses a project-named branch it did
not make as `branch-foreign` instead of failing inside `git worktree add`: the
planning session for `morning-calls` had opened its pull request from a branch
named after the project and kept it checked out in a scratchpad worktree.

The prompt rides as the **last positional argument**, which is how both tools
take opening words, and only for a new conversation. It names the programme
and where the session stands, and then waits: the reading list and the
`plan-review` hand-off it used to carry are the role's (`canon/roles/plan-session.md`),
and a session told to start by reading and reporting spent its first turn on
an intro nobody asked for.

### Why the plan-writing passage says what it says

`canon/roles/project-verb.md` § *Writing a PLAN.json* is a page of rules; the reasons are here.

**Work classes, not models (ruling 59, ruling 42).** A class says how much
judgement a step needs; it does not claim two providers' models are equal.
When the step starts, mc resolves the class to a candidate from its catalog
(`mc model list`) and from the subscription capacity it has observed; the
candidate's tool, model and effort become the session's. Only included
subscriptions are candidates, so a class step never spends a credit, and a
started session is never switched to another provider. A step pinned to one
concrete model waits whenever that model's usage is spent, where a class takes
the next candidate; whether a session runs on the plan or the API is billing's
to decide, not the step's. A plan sent before the rule keeps its concrete
models and runs on them, and a catalog edit never rewrites a plan. `model` in
the plan's own `runner` would make every step that model, so it is refused.

**Codex names.** `gpt-6.1-sol` and `gpt-6-luna` are Codex's models, not
stand-ins for Claude's. On a legacy sent plan a concrete Codex name belongs to
a `--tool codex` plan, and a Claude name is refused there. A class names no
tool, so `runner.tool` does not apply to it. `effort` takes the same five
levels on both tools; which model names exist is for the installed, signed-in
codex CLI to decide, not mc.

**Review.** The review step runs on the review candidates Martin configures
with `mc model add|remove review` and `mc model set review` (Claude Opus at
high effort alone at launch), on either tool, and does not inherit the
implementation steps' provider; `mc project step add` refuses `review`. Review is an ordered list of candidates: it takes the first that can run on its plan now and is not the model the goal was built on, and that model only when no other can.
A project's review step has no build entry to pass over.

**Checks the review cannot reach.** The merge door refuses the review step
until every criterion is `met` in the register, so a check that needs this plan
landed first (the runner updated, the page redrawn from main) never passes. A
plan lands once, at its review, so nothing in it can wait for its own deploy.
`mc project criterion add` and `mc project send` refuse a check that says
"after the deploy", "in production", "not a step's" or names Martin. A live
check on this machine — a service restarted, a build, an install on the
paired phone, a wait for the runner's next chore pass — is commands the review
runs, so it stays a criterion.

## Archiving a programme

`mc plan <programme> --archive` is how a programme ends, and the only way:
`mc run` archives a project once its plan says done (a repository plan the round it is read, a plan under `~/mc/programs/` 24 hours after it is done), but nothing removes
the programme above it — `docs/project/<programme>/` keeps its own document and
rulings, and `~/mc/programs/<programme>/` keeps two worktrees on `plan/<programme>`.
No machine can tell that a programme is over, since one whose projects are all
done is also where the next piece of that work belongs, so it is typed and
never triggered.
[`src/mc/archive-programme.js`](../../src/mc/archive-programme.js):

1. **Everything is checked before anything is touched.** It fetches, then
   refuses — listing every reason — while any plan under the programme is under
   `~/mc/programs/` (a `done` one is `mc run`'s to archive
   first), or while `releaseWorkArea`'s dry run would keep anything in
   `~/mc/programs/<programme>/`: uncommitted work, commits main lacks, a process
   standing in it (the session itself, if run from inside), a file somebody
   put there. A name that is neither on main nor being planned is refused too.
2. **Main first.** In each repository whose `docs/project/` holds the
   programme: a throwaway worktree from `origin/main` on
   `mc-programme-archive-<programme>-<stamp>` (never `mc-archive-`, which the
   runner waits on), `git rm -r docs/project/<programme>/`, one
   `project_log.md` row for the programme itself — project `-`, outcome
   `closed`, doc `none`, pointer the last commit that touched the directory —
   and a docs-only PR landed through `runDocsMerge`, `mc merge --docs`'s own
   function. An archive PR for the programme still open from an earlier
   attempt is landed instead of opening a second.
3. **Then the planning session**, only once every PR has merged:
   `releaseWorkArea(planArea(<programme>))` — each worktree
   handed back, `plan/<programme>` deleted, the conversations and the
   directory gone with them. In layout 2 the directory is
   `~/mc/programs/<programme>/` and holds the programme's projects and
   documents too: once its worktrees are released it is moved whole to
   `~/mc/archive/programs/<programme>/` (ruling 57), and the conversations
   are left where Claude keeps them.

Main goes first because it is the half that fails on the network. A PR that
does not merge stops the command with the planning session untouched — the
state it started from — and running it again carries on.

The session's flags have nothing to do here: `--archive` with `--new`,
`--model`, `--codex` or `--claude` is refused, and so is `--archive` with no
name — a picker is no way to choose what to remove.

## Questions

A planning session is the one session Martin is sitting in front of, so a
question does not have to become anything to reach him — it can be asked.
Nothing tells it to write one down, and there is nowhere for it to go: mc
keeps no decision file and no reader for one (#510). What Martin answers is
carried into the plan, which is the only place it survives.

## How it is tested

[`tests/mc/commands/plan.test.js`](../../tests/mc/commands/plan.test.js), none
of which starts a session:

- **the decoupling, as a path**: `planArea('msr-core')` is `plan/msr-core` and
  not a top-level directory, and `planBranch` is `plan/msr-core`. This is the
  assertion the file exists for;
- **the prompt predicts nothing** — it carries none of `PLAN.json`,
  `<project>`, `PR`, `pull request`, `mc merge`, `push`, `programme document`
  or `Then stop`. This is the assertion that keeps the prompt from growing
  back;
- the prompt does name the programme, the directory, the branch and both
  checkouts, and asks for no reading and no report; the `plan-review` hand-off
  is the role's, not the prompt's;
- the launch resumes (`pick: null`) and `--new` starts fresh;
- the role has a body: it says what a planning session is for and what is not
  its work, carries the plan-writing rules by `@include` rather than by copy,
  and a launch with no body behind the role is refused rather than started;
- the shared text is the overlay's to carry — it is not in the prompt, and the
  assembled instructions hold it exactly once;
- the picker: every programme on main in either repository, a programme whose
  projects are all archived kept on the list, and the unfinished count;
- the launch opens the **programme directory itself**, not one of its
  checkouts;
- the claude launch, through `openInWorkArea` with a stubbed `spawn`:
  `--model opus`, then `--append-system-prompt` whose body is the profile, the
  shared text and the role's own words, then the prompt as the final argument,
  no `--resume`, `stdio: 'inherit'`;
- the codex launch as argv only — `profileArgs('codex', instructionsFor(…))` is
  `-c instructions=<json>` carrying the same body. Asserted on the arguments
  rather than through `openInWorkArea` because resolving a codex launch needs
  the codex binary, and a test must not depend on one;
- no name without a terminal, a reserved name, and the retired `--repo` are
  each refused;
- `--archive`, in
  [`tests/mc/archive-programme.test.js`](../../tests/mc/archive-programme.test.js),
  against a real repository and a bare origin with GitHub, the docs merge and
  the release stubbed: the pushed branch has `docs/project/<programme>/` gone
  and one `closed` row with project `-`; nothing is opened while a plan is on
  main; the planning session is not released when the PR does not merge; an
  archive PR left open is landed rather than doubled; the throwaway worktree
  and its branch are gone afterwards; and the verdict's refusals — a plan on
  main, what release would keep, a programme that is nowhere — each say why;
- `mc --help` lists the verb.

**Not measured, and honestly so.** No headless session can watch a program take
the terminal, so what is verified is that the right argv is built and spawned
with `stdio: 'inherit'`. `ensurePlanArea` and the picker were run live against
a scratch work root and the real repositories on 2026-08-31 — both worktrees
created on `plan/<programme>`, a second call idempotent, and
`areasWithCheckout()` and `listWorkAreas()` both empty with that directory on
disk while `openPlanAreas()` found it — but that is a smoke test recorded in a
pull request, not a test in the suite. And `mc plan --codex` has never been
started live here: codex is not installed on this machine, so
`resolveLaunch('codex')` fails on `missing-bin` first. The assembly is proven;
the codex launch waits for a machine that has codex.
