# mc plan — where a PLAN.md comes from

Everything else in mc runs on plans. `mc run` takes `ready` ones off
`~/mc/queue.md` and off both origin/mains, spends one fresh headless session
per step, merges, archives. It does not write them: **the runner runs `ready`
plans and nothing else** (Martin, 2026-08-29). A plan is written here, in one
foreground session with Martin at the terminal, and the session's deliverable
is the file.

```
mc plan <name> [--repo memoro|memoro-cli] [--codex|--claude] [--model <m>]
```

The name is the workarea's. `--repo` defaults to `memoro`, because most plans
are memoro's. There is no `--resume`, no tmux, no daemon and no inbox: it is
an ordinary terminal program that Martin closes when the PR exists.

## What the verb does

[`src/mc/commands/plan.js`](../../src/mc/commands/plan.js) is a hundred lines
and does four things.

**Refuses a reserved name.** `mc plan pm` would create a workarea wearing the
name that means "the singleton role's workspace", and everything that later
trusts the name would be talking to an impostor. `reservedRoleName` is the
same guard `mc new` and `mc worker` use.

**Makes the workarea if it is missing.** `~/mc/<name>/<repo>`, a worktree on
branch `<name>` **from `origin/main` after a fetch** — exactly `mc work add
<name> <repo> --from origin/main`. The base matters more here than anywhere
else: a plan written on a stale local branch reads a `docs/project/` that has
already moved, and proposes a programme that already exists. An area that is
already there is used as it stands.

**Assembles what the session is told**, in `planLaunch` — a pure function, so
a test can read it without starting anything.

**Hands it to `openInWorkArea`** with `pick: 'new'`, which is the same launch
path `mc brief` and `mc worker` use:
[`src/mc/work-open.js`](../../src/mc/work-open.js), `spawn` with `stdio:
'inherit'`. There is no second launcher. NOW says `plan` for exactly as long
as the session holds the terminal, through the foreground register.

## Two channels, one body of text

A new conversation is told two things: the user's Coding Profile, and the
role overlay behind it. They travel as **one body of markdown**, assembled by
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
overlay for codex and hand it the profile alone, and step 2 of this project
went looking for the codex channel it was missing. There wasn't one to build:
`-c instructions=` has carried markdown to codex since the profile stopped
being written to files, and `portrait.js` records a live check that codex
*layers* that text over its base instructions rather than replacing them. The
guard was a note from before the channel existed. So the fallback the plan
allowed for — writing the overlay into the workarea's `AGENTS.md` and saying
so — was not needed, and **nothing is written into the worktree**. A plan
session's only writes are the ones it means to commit.

The first prompt is separate from both. It rides as the **last positional
argument**, which is how both tools take opening words, and only for a new
conversation — a resume already has its own history and is not spoken over.

## What the session is told

The overlay is [`canon/roles/plan.md`](../../canon/roles/plan.md): Opus,
claude first, codex allowed. It is read with `readCanonRole`, from the
package, and **never from `~/.memoro/mc/roles/`** — a verb's own role
versions with the code that launches it. (`mc worker` is the other way round
by design: it marks the area, and a catalogue that defines `worker` wins.
`mc plan` marks nothing, so the role is this session's and not the area's;
a conversation opened in the same area tomorrow is an ordinary one.)

Four things the overlay fixes:

- **Read before writing.** `docs/project/` on this branch, its README, and the
  open `Plan:` PRs. If a programme for this work exists on main or in an open
  PR, the project goes under it. *Never a parallel programme, never a second
  project for the same state* — the failure this rule exists to stop is two
  plans quietly editing the same code from different directories.
- **The PLAN.md shape.** Frontmatter `status` · `next` · `budget` · `needs`;
  sections **Goal · Success criteria · Contract · Steps · What the code taught
  us · Documents**, in that order. The shape itself is written down in the
  repository being planned, in `docs/project/README.md` § *What a PLAN.md is*,
  the same text in memoro and memoro-cli, so the overlay points there rather
  than keeping a second copy that drifts. Every remaining step carries its own
  "done when", every criterion names how it is checked, and the Contract names
  what is out of scope as well as what may not change. That shape is not
  decoration — it is the interface a headless step session reads at 03:00 with
  nobody to ask.
- **Decisions are files.** `../decisions/<programme>-<n>.md` at the workarea
  root, one question each, what the code says and a `## Rekommendation` naming
  the one thing to do. A proposal Martin says GO to, not a menu. A question
  that is unclear, or that reading further would answer, gets no file — it
  gets read. [`mc brief`](mc-brief.md) is what puts them to him, and the
  answer travels plan-first: the next session writes it into PLAN.md and sets
  `ready`, which is the only thing that puts a project back in front of the
  runner.
- **Never merge, never start the runner, never write another project's plan.**

## The last word is the merge

The prompt's final line is `mc merge <repo> <pr> --docs`, not "and stop".

A plan PR is documentation only, and [`mc merge --docs`](mc-merge.md) lands
one with no suite, no lease, no worktree and no model — refusing by name the
first path outside `docs/`. Without it a finished plan sits in an open PR and
the runner cannot see it: the queue is built from `origin/main`. So the
session that wrote the plan lands it, and if the merge refuses it says why
and leaves the PR open.

Both places a plan session hears it say it: the role's closing paragraph and
this first prompt. The prompt was the later of the two to be fixed (#425) —
the words a session hears last are the ones it acts on, and a role paragraph
read twenty minutes earlier is not those words. (A third place used to say it,
the runner's `triage` prompt, which invented plans headlessly. That kind is
gone: the runner runs plans and does not write them, see
[`run-plan.js`](../../src/mc/run-plan.js) `chooseKind`.)

## How it is tested

[`tests/mc/commands/plan.test.js`](../../tests/mc/commands/plan.test.js), six
tests, none of which starts a session:

- the role ships, is Opus, claude-first, and its overlay carries the PLAN.md
  path, the `Plan: <name>` title, the `**Beslut:**` shape, the no-parallel-
  programme rule and the docs merge;
- `planLaunch` names the workarea, the repository and the PR title, and its
  **last line** is the docs merge with the real repository in it;
- the claude launch, through `openInWorkArea` with a stubbed `spawn`:
  `--model opus`, then `--append-system-prompt` whose body is
  `PROFILE\n\n---\n\nYou are the planning session…`, then the prompt as the
  final argument, no `--resume`, `stdio: 'inherit'`;
- the codex launch as argv only — `profileArgs('codex', instructionsFor(…))`
  is `-c instructions=<json>` and the JSON body carries the role text. It is
  asserted on the arguments rather than through `openInWorkArea` because
  resolving a codex launch needs the codex binary, and a test must not depend
  on one;
- no name and a reserved name are each refused;
- `mc --help` lists the verb.

**Not measured, and honestly so.** No headless session can watch a program
take the terminal, so what is verified is that the right argv is built and
spawned with `stdio: 'inherit'`. And `mc plan <name> --codex` has never been
started live here: codex is not installed on this machine — nothing on
`PATH`, nothing under `~/.local/bin`, only a leftover `~/.codex` — so
`resolveLaunch('codex')` fails on `missing-bin` before any of the above is
reached. The assembly is proven; the codex launch waits for a machine that
has codex.
