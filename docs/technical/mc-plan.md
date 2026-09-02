# mc plan — a session in a directory, told which programme it is for

```
mc plan [<programme>] [--codex|--claude] [--model <m>]
```

That is the whole verb. It opens a foreground session in
`~/mc/plan/<programme>/` with both repositories checked out, and hands it one
prompt naming the programme, where it stands, and what to read. Martin is at
the terminal for all of it.

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
one `PLAN.json`, one branch, one workarea, archived off main the round its plan
says done.

`mc plan <name>` used to make `~/mc/<name>` on branch `<name>` — exactly the
directory and the branch the runner gives the project of that name. One word
was the session, the project and the workarea at once, so the planning session
sat in the folder `mc run` would later merge into, close and hand back to git,
and it read as an *unplanned workarea* to `mc status` and to the runner's own
closing pass every round.

A planning session and a project's workarea are not the same kind of thing. A
planning session is Martin's, lasts as long as it takes, and holds both
repositories because a programme may span them. A project's workarea is the
runner's, holds one repository, and is removed the round its plan says done
(Martin, 2026-08-31 — "en mc plan sessions workarea ska aldrig vara hopkopplad
till något som körs av mc run").

So a planning session lives at:

```
~/mc/plan/<programme>/
├── memoro/        worktree on branch plan/<programme>
└── memoro-cli/    worktree on branch plan/<programme>
```

`~/mc/plan/` is mc's own directory, beside `runner/`, `intake/` and `brief/`.
**The runner cannot reach what is under it**, and not by a rule about names
that could drift: `mc run`'s `workareas()` and `mc status`'s
`areasWithCheckout()` both list *top-level* directories under `~/mc` that hold
a checkout of a repository mc knows, and `~/mc/plan/` holds none. The
programmes are one level below that, where neither looks. `listWorkAreas` skips
the directory by name for the same reason, so `mc work` does not list a
"workarea" called `plan` whose repositories are programme names. The name lives
once, in [`paths.js`](../../src/mc/paths.js).

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
| `listPlans` — the `PLAN.json` files on `origin/main` | what is **in** them |
| `openPlanAreas` — the directories under `~/mc/plan/` | which are **being planned** |

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

[`src/mc/commands/plan.js`](../../src/mc/commands/plan.js) does four things.

**Refuses a reserved name.** `mc plan pm` would make a directory wearing the
name that means "the singleton role's workspace". `reservedRoleName` is the
same guard `mc new` and `mc worker` use.

**Makes the session's directory if it is missing**, in `ensurePlanArea`:
`~/mc/plan/<programme>/` with a worktree of **every** repository mc knows, each
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

## What the session is told

The prompt, in full:

```
You are the planning session for the `<programme>` programme.

You stand in `~/mc/plan/<programme>/`, with `memoro/` and `memoro-cli/` beside
you — each a worktree on branch `plan/<programme>`. This is not a workarea:
nothing `mc run` does can reach it.

Martin is at the terminal. Start by reading `docs/project/README.md` and what
`docs/project/<programme>/` already holds in each repository, and say what you
found.
```

And nothing else. `canon/roles/plan.md` is **frontmatter only** — `model:
opus`, `tools: claude, codex` — with no overlay behind the prompt. mc reads it
for the defaults a launch needs and for nothing else.

`docs/project/README.md` is named because that is where the convention and the
`PLAN.json` schema actually live, in the repository being planned, the same
text in memoro and memoro-cli. Naming the file rather than restating it is what
keeps this from becoming a second copy that drifts.

The user's Coding Profile still reaches the session the way it reaches every
other — `--append-system-prompt` for claude, `-c instructions=` for codex,
through `instructionsFor` in [`roles.js`](../../src/mc/roles.js) and
`profileArgs` in [`portrait.js`](../../src/mc/portrait.js). With no overlay,
that body is the profile alone. The prompt rides as the **last positional
argument**, which is how both tools take opening words, and only for a new
conversation.

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
- the prompt does name the programme, the directory, the branch, both
  checkouts, and the two things to read;
- the role is frontmatter, with `overlay === null`;
- the picker: every programme on main in either repository, a programme whose
  projects are all archived kept on the list, and the unfinished count;
- the launch opens the **programme directory itself**, not one of its
  checkouts;
- the claude launch, through `openInWorkArea` with a stubbed `spawn`:
  `--model opus`, then `--append-system-prompt` whose body is the profile
  alone, then the prompt as the final argument, no `--resume`, `stdio:
  'inherit'`;
- the codex launch as argv only — `profileArgs('codex', instructionsFor(…))` is
  `-c instructions=<json>` carrying the profile. Asserted on the arguments
  rather than through `openInWorkArea` because resolving a codex launch needs
  the codex binary, and a test must not depend on one;
- no name without a terminal, a reserved name, and the retired `--repo` are
  each refused;
- `mc --help` lists the verb.

`tests/mc/brief-collect.test.js` carries the decisions half: a file written at
`plan/<programme>/decisions/` is scanned and reaches the brief.

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
