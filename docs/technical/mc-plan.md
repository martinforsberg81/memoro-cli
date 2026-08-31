# mc plan — where a programme's plans come from

Everything else in mc runs on plans. `mc run` takes `ready` ones off
`~/mc/queue.md` and off both origin/mains, spends one fresh headless session
per step, merges, archives. It does not write them: **the runner runs `ready`
plans and nothing else** (Martin, 2026-08-29). Plans are written here, in one
foreground session with Martin at the terminal, and the session's deliverable
is the files.

```
mc plan [<programme>] [--codex|--claude] [--model <m>]
```

The name is a **programme's**, not a project's. There is no `--resume`, no
tmux, no daemon and no inbox: it is an ordinary terminal program that Martin
closes when the PR exists.

## A programme, and why it is not a workarea

A programme is the initiative the work serves — `msr-core`, `sql-readiness`,
`mc` — and it outlives every project under it. A project is one independently
stable state that can start on its own, and it is what the runner runs: one
`PLAN.json`, one branch, one workarea, archived off main the round its plan
says done.

`mc plan <name>` used to make `~/mc/<name>` on branch `<name>` — exactly the
directory and the branch `mc run` gives the project of that name. One word was
the session, the project and the workarea at once, so the planning session sat
in the folder the runner would later merge into, close and hand back to git,
and it read as an *unplanned workarea* to `mc status` and to the runner's own
closing pass every round.

A planning session and a project's workarea are not the same kind of thing. A
planning session is Martin's, lasts as long as it takes, and spans both
repositories because a programme does. A project's workarea is the runner's,
holds one repository, and is removed the round its plan says done. They now
share exactly one thing: a `PLAN.json` on `main` (Martin, 2026-08-31 — "en mc
plan sessions workarea ska aldrig vara hopkopplad till något som körs av mc
run").

So a planning session lives at:

```
~/mc/plan/<programme>/
├── memoro/        worktree on branch plan/<programme>
├── memoro-cli/    worktree on branch plan/<programme>
└── decisions/     the questions it raises
```

`~/mc/plan/` is mc's own directory, beside `runner/`, `intake/` and `brief/`.
**The runner cannot reach what is under it**, and not by a rule about names
that could drift: `mc run`'s `workareas()` and `mc status`'s
`areasWithCheckout()` both list *top-level* directories under `~/mc` that hold
a checkout of a repository mc knows, and `~/mc/plan/` holds none. The
programmes are one level below that, where neither looks. `listWorkAreas`
skips the directory by name for the same reason, so `mc work` does not list a
"workarea" called `plan` whose repositories are programme names.

The session's working directory is the programme directory itself, not either
checkout: both repositories are siblings under it, and a programme that spans
them should not have to be opened in one of them by guess.

## Choosing a programme

With no programme named, `mc plan` asks — a numbered list, `n` to name a new
one, and Enter on nothing to walk away. Never when there is nobody to answer:
a pipe or a script gets the usage line, as [`prompt.js`](../../src/mc/prompt.js)
requires of every question mc asks. `p` on the page ([`mc`](mc-status.md))
takes the same route, with or without a name.

The list is built by `programmeRows` from three readings that are deliberately
separate:

| reading | question it answers |
|---|---|
| `listProgrammes` — `git ls-tree -d origin/main docs/project/` | which programmes **exist** |
| `listPlans` — the `PLAN.json` files on `origin/main` | what is **in** them |
| `openPlanAreas` — the directories under `~/mc/plan/` | which are **being planned** |

Asking only the second would drop a programme whose projects the runner has
already archived: the directory is left holding its own document and its
rulings, with no `PLAN.json` anywhere under it. Measured against the two
repositories on 2026-08-31 that is 3 of 17 — `docs-navigation`,
`legal-readiness`, `sql-readiness` — and they are exactly the ones the offer
matters most for, because the next piece of that work belongs under the
heading that already exists rather than under a parallel one somebody invents.

The third reading is what makes a programme re-openable before it is anywhere
on main: its PR is still open, or still unwritten, and the directory on disk is
the only thing that knows it was started.

## What the verb does

[`src/mc/commands/plan.js`](../../src/mc/commands/plan.js) does four things.

**Refuses a reserved name.** `mc plan pm` would make a directory wearing the
name that means "the singleton role's workspace". `reservedRoleName` is the
same guard `mc new` and `mc worker` use.

**Makes the session's directory if it is missing**, in `ensurePlanArea`:
`~/mc/plan/<programme>/` with a worktree of **every** repository mc knows, each
on branch `plan/<programme>` **from `origin/main` after a fetch**. The base
matters more here than anywhere else: a plan written on a stale local branch
reads a `docs/project/` that has already moved, and proposes a programme that
already exists. An existing directory is used as it stands and only what is
missing is added, so re-opening a programme carries on rather than starting
again. A repository that is not on this machine is said and skipped rather than
refused — a programme is usually planned against one of the two, and losing the
session over the other's absence helps nobody. Nothing at all is the only
failure.

**Assembles what the session is told**, in `planLaunch` — a pure function, so
a test can read it without starting anything.

**Hands it to `openInWorkArea`** with `pick: 'new'`, which is the same launch
path `mc brief` and `mc worker` use:
[`src/mc/work-open.js`](../../src/mc/work-open.js), `spawn` with `stdio:
'inherit'`. There is no second launcher. NOW says `plan` for exactly as long as
the session holds the terminal, through the foreground register.

`--repo` is gone. It chose which repository to make the old project-shaped
workarea in; a programme is not in one repository, so the flag has nothing left
to select. It is refused with that sentence rather than as an unknown flag,
because "unknown flag" reads like a typo to whoever typed what worked
yesterday.

## Two channels, one body of text

A new conversation is told two things: the user's Coding Profile, and the role
overlay behind it. They travel as **one body of markdown**, assembled by
`instructionsFor` in [`roles.js`](../../src/mc/roles.js) —

```
<profile>

---

<overlay>
```

— and `profileArgs` in [`portrait.js`](../../src/mc/portrait.js) decides how
that body reaches the tool that was chosen:

| tool | argument |
|---|---|
| claude | `--append-system-prompt <body>` |
| codex | `-c instructions=<JSON-quoted body>` |
| anything else | nothing, silently |

That is the whole of the tool difference. `instructionsFor` used to drop the
overlay for codex and hand it the profile alone, and a step of the original
project went looking for the codex channel it was missing. There wasn't one to
build: `-c instructions=` has carried markdown to codex since the profile
stopped being written to files, and `portrait.js` records a live check that
codex *layers* that text over its base instructions rather than replacing them.
So the fallback that was allowed for — writing the overlay into the worktree's
`AGENTS.md` and saying so — was not needed, and **nothing is written into
either worktree**. A plan session's only writes are the ones it means to
commit.

The first prompt is separate from both. It rides as the **last positional
argument**, which is how both tools take opening words, and only for a new
conversation — a resume already has its own history and is not spoken over.

## What the session is told

The overlay is [`canon/roles/plan.md`](../../canon/roles/plan.md): Opus, claude
first, codex allowed. It is read with `readCanonRole`, from the package, and
**never from `~/.memoro/mc/roles/`** — a verb's own role versions with the code
that launches it. (`mc worker` is the other way round by design: it marks the
area, and a catalogue that defines `worker` wins. `mc plan` marks nothing, so
the role is this session's and not the directory's.)

Five things the overlay fixes:

- **What it is planning.** A programme, and the projects under it. The
  deliverable is the programme document when the programme is new or its shape
  has changed, plus one `PLAN.json` for every project that can start *against
  the code as it stands* — not every state the programme will ever pass
  through, because a state that depends on an earlier one finishing is written
  when that one has finished, by the next session in this seat.
- **Read before writing.** `docs/project/<programme>/` in each checkout, its
  README, the open `Plan:` PRs in **both** repositories, the programme's
  `rulings.md`, and `~/mc/intake/proposals/` — where work nobody has planned
  yet arrives. If a programme for this work exists on main or in an open PR,
  the project goes under it. *Never a parallel programme, never a second
  project for the same state* — the failure this rule exists to stop is two
  plans quietly editing the same code from different directories.
- **The plan's shape.** One `PLAN.json` per project: the overall part — `goal`,
  `contract`, `out_of_scope`, `success_criteria`, `what_the_code_taught_us`,
  `documents` — then `steps[]`, each with its own `instruction`, `done_when`
  and `status`. The shape itself is written down in the repository being
  planned, in `docs/project/README.md` § *What a PLAN.json is*, the same text
  in memoro and memoro-cli, so the overlay points there rather than keeping a
  second copy that drifts. That shape is not decoration — it is the interface a
  headless step session reads at 03:00 with nobody to ask.
- **The workarea is not this session's to make.** The `<project>` directory
  name the session chooses is what the runner will later call that project's
  branch and its workarea. Choosing it is the whole of this session's part in
  it; it creates neither, queues nothing, and starts no runner.
- **Decisions are files.** `../decisions/<programme>-<n>.md` at the session's
  own root — `~/mc/plan/<programme>/decisions/` — one question each, what the
  code says and a `## Rekommendation` naming the one thing to do. A proposal
  Martin says GO to, not a menu. A question that is unclear, or that reading
  further would answer, gets no file; it gets read. [`mc brief`](mc-brief.md)
  is what puts them to him, and the answer travels plan-first: the next session
  writes it into the plan and sets `ready`, which is the only thing that puts a
  project back in front of the runner.

`scanDecisions` descends one level under `plan/` for exactly this reason, so a
planning session's questions reach `mc brief` and `mc status` as a workarea's
do. A decision is a decision wherever it was written, and whoever answers it
should not have to know which kind of session asked.

## The last word is the merge

The prompt's final line is `mc merge <repo> <pr> --docs`, not "and stop".

A plan PR is documentation only, and [`mc merge --docs`](mc-merge.md) lands one
with no suite, no lease, no worktree and no model — refusing by name the first
path outside `docs/`. Without it a finished plan sits in an open PR and the
runner cannot see it: the queue is built from `origin/main`. So the session
that wrote the plan lands it, and if the merge refuses it says why and leaves
the PR open. A programme whose plans span both repositories opens and lands one
PR in each.

Both places a plan session hears it say it: the role's closing paragraph and
this first prompt. The prompt was the later of the two to be fixed (#425) — the
words a session hears last are the ones it acts on, and a role paragraph read
twenty minutes earlier is not those words. (A third place used to say it, the
runner's `triage` prompt, which invented plans headlessly. That kind is gone:
the runner runs plans and does not write them, see
[`run-plan.js`](../../src/mc/run-plan.js) `chooseKind`.)

## How it is tested

[`tests/mc/commands/plan.test.js`](../../tests/mc/commands/plan.test.js), none
of which starts a session:

- **the decoupling, as a path**: `planArea('msr-core')` is `plan/msr-core` and
  not a top-level directory, and `planBranch` is `plan/msr-core`. This is the
  assertion the file exists for;
- the role ships, is Opus, claude-first, and its overlay is written for a
  programme — the `~/mc/plan/<programme>/` directory, "This is not a workarea",
  the decisions path, the `Plan: <programme>` title, the `**Beslut:**` shape,
  the no-parallel-programme rule and the docs merge — and carries **no**
  reference to a project workarea's `HANDOFF.md` or `../inbox/`;
- the picker: every programme on main in either repository, a programme whose
  projects are all archived kept on the list, and the unfinished count;
- `planLaunch` names the programme, both checkouts, the branch and the PR
  title, says the workarea is not its to make, and its last paragraph is the
  docs merge;
- the launch opens the **programme directory itself**, not one of its
  checkouts;
- the claude launch, through `openInWorkArea` with a stubbed `spawn`:
  `--model opus`, then `--append-system-prompt` whose body is
  `PROFILE\n\n---\n\nYou are the planning session…`, then the prompt as the
  final argument, no `--resume`, `stdio: 'inherit'`;
- the codex launch as argv only — `profileArgs('codex', instructionsFor(…))` is
  `-c instructions=<json>` and the JSON body carries the role text. It is
  asserted on the arguments rather than through `openInWorkArea` because
  resolving a codex launch needs the codex binary, and a test must not depend
  on one;
- no name without a terminal, a reserved name, and the retired `--repo` are
  each refused;
- `mc --help` lists the verb.

`tests/mc/brief-collect.test.js` carries the other half: a decision written at
`plan/<programme>/decisions/` is scanned and reaches the brief's *Waiting on
Martin* table like any other.

**Not measured, and honestly so.** No headless session can watch a program take
the terminal, so what is verified is that the right argv is built and spawned
with `stdio: 'inherit'`. `ensurePlanArea` and the picker were run live against
a scratch work root and the real repositories on 2026-08-31 — both worktrees
created on `plan/<programme>`, a second call idempotent, and
`areasWithCheckout()` and `listWorkAreas()` both empty with that directory on
disk while `openPlanAreas()` found it — but that is a smoke test recorded in a
pull request, not a test in the suite. And `mc plan --codex` has never been
started live here: codex is not installed on this machine, so
`resolveLaunch('codex')` fails on `missing-bin` before any of the above is
reached. The assembly is proven; the codex launch waits for a machine that has
codex.
