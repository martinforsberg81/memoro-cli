# Roles — how a session is instructed

Every session mc starts in a role is told two things, in this order: the text
**every role session shares**, and **that role's own words**. Nothing else —
the user's Coding Profile, which once came first, was removed by ruling 24, and
the one rule in it nothing else said (what is written in English) is a sentence
in `all-sessions.md`. This document is the one account of how those two are found
and joined. `mc run`, `mc plan`, `mc helper` and `mc manager` each described a corner
of it from their own angle; they now point here, because four parallel accounts
of one mechanism is four things to keep true.

What a session is told is never written into a worktree. It rides on the launch
argument each tool already takes — `--append-system-prompt` for claude, `-c
instructions=` for codex — built by `profileArgs` in
[`portrait.js`](../../src/mc/portrait.js). Nothing is left on disk for a
session to find, and nothing has to be cleaned up after one.

The code is [`src/mc/roles.js`](../../src/mc/roles.js).

A role reaches only a session mc launches. Other mc guidance is reached through
one installed skill, `mc`: [mc-skills.md](mc-skills.md). Its short entrypoint
routes to task, verb and programme references when the operation needs them.
Roles do not repeat the task catalogue.

## The catalogue

A role is a markdown file: frontmatter for what mc needs to know, body text for
what the conversation needs to be told.

```
---
name: build-session
model: opus
singleton: false
tools: claude, codex
cache: 5m
---
@part goal
You are a build session on one goal. …
@end
…
```

`parseRole` reads exactly those four keys and treats everything else in the
frontmatter as the rulebook's business. **No frontmatter is no role** — not a
role with defaults — and the filename names a role whose frontmatter does not
name itself. A CRLF checkout parses the same as an LF one.

There are two catalogues, and they are looked up in that order:

- **The user's** — `MC_ROLES_DIR`, or `<mc home>/roles` otherwise (`rolesDir`).
  It is the user's rulebook, versions with them and not with mc, and a role
  defined there wins. A directory that does not exist is an empty catalogue,
  not an error: roles are optional equipment.
- **mc's own** — `canon/roles/`, resolved from the module's own location by
  `canonRoot` ([`canon.js`](../../src/mc/canon.js)) rather than from
  `process.cwd()`, and shipped inside the package (`package.json` `files`
  lists `canon`). These are the verbs' own roles, versioned with the code that
  launches them, and `readCanonRole` never falls back to the user's catalogue —
  a verb must be able to launch its own session on a machine with no rulebook
  at all.

What canon holds today: five goal roles, each one file, and the three that
stay apart (Martin, 2026-11-03, goal `plan-session-roles`: a role says what
the session is for; a verb file says how a verb is used). Plan is interactive
only, and finish and mend took its headless goal work (Martin, 2026-11-07).

| role | model | started as | who launches it |
|---|---|---|---|
| `plan-session` | opus | `plan` | `mc plan <programme>`, a foreground session in `~/mc/programs/<programme>/`; never the runner |
| `build-session` | opus | `build-session:goal` | `mc run`, one headless session on a goal in `build` |
| `review-session` | opus | `review-session:goal` | `mc run`, the review of a goal in `review` |
| `finish-session` | opus | `finish-session` | `mc run`, one headless session on a goal in `finish · ready` ([mc-goals.md](mc-goals.md) § *Finish and mend*) |
| `mend-session` | opus | `mend-session` | `mc run`, one headless session only after a merge failure (conflict, failed candidate check or moved judged head) ([mc-goals.md](mc-goals.md) § *Finish and mend*) |
| `manager` | opus | `manager` | `mc manager`, foreground in `~/mc/manager/` or an explicit fresh headless task |
| `helper` | sonnet | `helper` | `mc helper`, the desk, foreground in `~/mc/helper/` |
| `intake` | sonnet | `intake` | the inbox drain, one headless turn per file |

## Parts: one role, started more than one way

The parser can select parts of a role. The build role currently has one:

```
@part goal
…the goal build is told this…
@end
```

Text outside every part is the role's shared words. A start names its part
after a colon — `readCanonRole('build-session:goal')` — and `parseRole` keeps
the shared words and every part whose `@part` line lists that name, in file
order, and drops the rest (`selectParts`). The whole reference is the role's
name wherever one is kept: `MC_ROLE`, the register's role record, and
`mc roles check build-session:goal`. A part the file does not have is no role,
so a start never runs on the shared words alone; `readCanonRole` with no part
gives the shared words and `parts`, which `mc roles show build-session` lists.
The constants are `PLAN_ROLE` and `REVIEW_ROLE` in `goals.js`,
`BUILD_ROLES` in `run-plan.js`. Projects went on 2026-11-03; see
[mc-goals.md § From a project](mc-goals.md#from-a-project).

A custom role can also be stored on an existing area rather than chosen by a
launcher. `markAreaRole` writes `.mc-role` — one file, one word — when the area is
created, `areaRole` reads it every time a conversation starts there, and an
area without the file is an ordinary area and stays one. A role is decided at
creation, never acquired.

## The shared file

`canon/roles/all-sessions.md` is the text every role session is told. It holds
shared essentials and one `@mc` marker. Assembly resolves that marker to the
installed `mc/SKILL.md` path for the session's tool. The role's own text says
purpose, authority and completion; task procedures live in `canon/tasks/`.
No task descriptions or bodies are copied into the launch context.

It began as the turn-cost paragraph, which was byte-identical in four role
files with two variants in two more — six places for one rule to drift, and the
day they disagree is the day one kind of session quietly stops being told
something every other kind is.

Two things about where it sits are mechanical rather than tidy:

**A passage is not a role.** `listRoles` makes a role out of every `*.md` in a
catalogue directory, so a copy of `all-sessions.md` or a verb file in a user's
catalogue would be listed by `mc roles list` as a role. `isPassageFile` names
them — `all-sessions.md`, `*-verb.md`, and a leading underscore — and
`listRoles` skips them. (None has frontmatter either, so `parseRole` would
reject them as well — but the name is the guard, and the guard is what is
tested.) Keeping every piece of instruction text in one directory won over a
`canon/common.md` beside `roles/`.

**It is read at assembly, not folded into `overlay`.** `readCanonRole(name).
overlay` stays the role's *own* words. `mc roles show <role>` prints it as that
role's text, `tests/mc/roles-decisions.test.js` asserts on one role's wording
through it, and — the reason that matters — `run.js` tests `role.overlay` to
decide whether a role file is installed at all:

```js
if (!role?.overlay) { say(`${name}: ${roleFileText(roleName)} is missing on this machine, skip`); return 'skipped:role-missing'; }
```

A shared preamble folded in ahead of that check would make a missing
`build-session.md` look present, and the runner would launch a ninety-minute session
with no instructions for what it is doing.

## The assembler

```js
export function instructionsFor(toolId, overlay) {
  const shared = overlay ? sharedRoleText() : null;
  const options = { tool: toolId };
  return [shared, overlay].map((text) => expandRoleIncludes(text, options))
    .filter(Boolean).join('\n\n---\n\n') || null;
}
```

That is the single door. **No overlay is no role, and no role is no shared
text** — a conversation in an ordinary work area inherits nothing and is
launched with no instructions at all, which is the whole parallel-operation
guarantee. The same text goes to every tool, because
the channel is the same shape for every tool; codex's `-c instructions=` was
verified to layer over the base instructions rather than replace them (see
[`portrait.js`](../../src/mc/portrait.js)), and a tool mc has no channel for
gets an empty argument list and is unaffected by any of this.

Four paths launch a session with instructions, and all four call it:

| path | the session |
|---|---|
| `work-open.js:93` (`openInWorkArea`) | a foreground conversation in an area — `mc manager`, `mc helper`, `mc plan` |
| `work-open.js:342` (`launchCommand`) | the argv a tmux launch or a handoff respawn is built from |
| `run.js` (`runGoal`) | a goal build, review, finish or mend session |
| `helper-turn.js:258` | the intake turn, one file, headless |

Each of them used to write the join out by hand.

## The verb files

`canon/verbs/goal.md` holds the goal manual. The plan, finish, mend and manager role files name
it with `@verb goal`. `expandRoleIncludes`, called by `instructionsFor`, turns
that line into a short instruction to read the installed `mc/verbs/goal.md`
before using `mc goal`. It never pastes the manual into the launch context.
`parseRole` leaves the marker in the role's own overlay.

Markers occupy a whole line, names cannot escape the reference directory,
and an unknown name stays visible rather than silently losing guidance.
For existing user catalogue roles, `@include goal-verb.md` and `@skill <task>`
still resolve, now to verb and task reference paths under the one mc skill.
`@mc` resolves to the root entrypoint path. Support files are ordinary `.md`
files; only `mc/SKILL.md` participates in skill discovery.

The build and review roles each have a `goal` part. A build is headless,
on one branch built to the end: it does not merge main to keep up, and it
ends at an item boundary only when done, blocked, or cheaper to continue in a
fresh session. A review judges the goal's criteria and PR head; it never
builds. `roles.test.js` holds the selected parts and their shared instructions.

**The plan session** (`plan-session.md`) is written around the programme's
aim in `~/mc/programs/<programme>/README.md` (Martin, 2026-11-03). It has, in
principle, full freedom to move the programme toward it, a goal's branch
included: it may finish a goal's work itself when that is quicker than a new
build session. It is interactive only (Martin, 2026-11-07): Martin is at the
terminal and it has no restrictions; the runner never starts one. It names
the headless roles and what each owns, so it knows the goal's text is its
own and a headless session's `Martin` is a question for it. A goal
is what the runner builds, a means toward the aim. `refusedMove`
(`commands/goal.js`) still enforces forward stage moves for plan sessions. Before 2026-11-03 the
role was `plan.md`, which forbade a headless plan session code, commits, a
publish and `review`/`done`, and listed three allowed ends; both are gone.
Until 2026-11-07 the same file had headless sections (`### finish`, `### blocked`,
programme planning, `MC_PLAN_REASON`); those are gone too.

**The finish session** (`finish-session.md`) and **the mend session**
(`mend-session.md`) each state one job, their inputs, what they may change,
their exits and what they hand to whom. Finish takes `finish · ready` to
`merge`, or resolves its own acceptance obstacle or sets `Martin` directly (a change to
the goal, contract or scope). Mend exists only after a merge failure, repairs it and requeues; bounded failure waits on Martin. Neither changes the goal's text: `refusedMove`
and the criterion verbs refuse them, as they refuse build and review.
`canon/roles/plan.md` had no body at all until #656 — six lines of
frontmatter — and `tests/mc/roles.test.js` § *every canon role has a body* is
the guard that keeps that from coming back, for every part of every role.

## What a session is running on, afterwards

A role file can be edited while a session launched from it is still running,
and until #660 nothing on the machine could say so. The brief that planned
*this* is the proof: its role text on 2026-09-06 held two sentences that
`canon/roles/brief.md` had not held since #614 landed the day before. The
launcher had exited with its argv; there was nothing to compare and nothing to
compare it against.

So every launch that writes a register writes a **role record** beside the
rest of it (`roleRecord`, `roles.js`):

```json
"role": {
  "name": "build-session:goal",
  "source": "canon",
  "digest": "sha256:345f6ea5956c",
  "text_digest": "sha256:43046c402ec7"
}
```

Four fields and no text. The registers are `~/mc/runner/foreground/<pid>.json`
(a verb holding a terminal — `foreground.js`) and
`~/mc/runner/current-<repo>.json` (a lane of the runner — `run.js`), and the
page parses both on every draw: a kilobyte of overlay in there would be a cost
for nothing.

**Two digests, because they answer two questions.** `digest` is over the
assembled instructions — `all-sessions.md` and the overlay, joined as
`instructionsFor` joins them — and answers *is this session running what a
launch would produce now*. `text_digest` is over the role's own body with its
includes expanded, and answers *is this session running the role file on disk
today*. An edit to `all-sessions.md` moves the first and not the second. Both inputs
are files in the repository; the Coding Profile, which could move the first
from outside it, was removed by ruling 24.

`source` is there because `areaRole` prefers the user's catalogue over canon on
purpose. A session running a catalogue role is not automatically running a stale copy
of canon; it is running that rulebook, and it is compared against the file it
actually came from. (A reference always resolves in canon, whichever
catalogue the role itself came from.)

A launch that assembled nothing records the role and no digests. That is the
resumed conversation: its instructions are in its own history, and a digest of
today's file would be a claim about it nobody checked.

`mc roles check [<role>]` is the reader:

```
$ mc roles check build-session:goal
build-session:goal (canon) …/canon/roles/build-session.md
  role text     sha256:43046c402ec7
  instructions  sha256:345f6ea5956c   all-sessions.md + overlay, as a launch joins them

2 live sessions: 1 ok, 1 drift
  55012 build goal:mc/page — ok
  55130 build goal:mc/lanes — drift

…
```

Named, it prints the whole assembled text — the same object the digests are
taken from, so the two halves of the comparison cannot be different things —
and checks the sessions running that role. Bare, it checks every live session
against the role each one names. `--json` for both. The verdicts are `ok`,
`drift` (the role file or `all-sessions.md` has moved under it), `resumed`, `no-role-file`, and `unrecorded` —
an ordinary session with no role, or one started before this existed.

**Two launches write no register and so cannot be checked:** a tmux session
(`startInBackground` — there is no mc process holding it, and the foreground
register is keyed by the pid of the mc process that is waiting) and the intake
turn (`helper-turn.js`, which writes to neither register). Both were outside
the registers before this and still are; what they launch on is not knowable
from the outside.

The foreground path also puts `role` and `role_digest` in its `work.open` log
line. The register lives exactly as long as the session; the log is still there
tomorrow, which is what the brief above needed and did not have.

## Where the code is

| file | what |
|---|---|
| `src/mc/roles.js` | `parseRole` and parts (`roleRef`, `selectParts`), the two catalogues, `sharedRoleText`, `expandRoleIncludes`, `instructionsFor`, `textDigest`/`roleRecord`/`roleSourceOf`, the `.mc-role` mark, the reserved names |
| `src/mc/canon.js` | `canonRoot` — where the packaged `canon/` is, resolved from the module's own path |
| `src/mc/portrait.js` | `profileArgs` — the per-tool launch argument the assembled text rides on |
| `src/mc/commands/roles.js` | `mc roles list`, `mc roles show <role>` over the user's catalogue; `mc roles check` over both catalogues and the two registers |
| `src/mc/foreground.js` | `~/mc/runner/foreground/<pid>.json` — the register a verb holding a terminal writes, role record and all |
| `canon/roles/all-sessions.md` | the text every role session shares |
| `canon/roles/<verb>-verb.md` | how one verb is used, included by the roles that use it |
| `canon/roles/<name>.md` | one role's frontmatter, its own words and its parts |

## How it is tested

[`tests/mc/roles.test.js`](../../tests/mc/roles.test.js) — `parseRole` on text
(frontmatter, no frontmatter, CRLF, the filename fallback), the catalogue and
the missing catalogue, the `.mc-role` mark, and the assembly: the join for both
tools, and `null` when there is no overlay. Its *text every role session shares* block asserts the turn-cost rule
is in exactly one file in `canon/roles/`, reaches every canon role that has a
body, is **not** listed as a role with the file sitting in the catalogue
directory under test, and is not in a role's own overlay.

Blocks below it. *The verb files* asserts the defining sentences of each verb
file are in exactly that file, that `plan-session` and `manager` carry the
markers and no copy, that a verb file is not listed as a role, that
`instructionsFor` expands the marker and leaves none behind — and that an
unresolvable marker is left standing. *Every canon role has a body* walks
`canonRolesDir()` and fails any role file, and any part of one, that does not
parse to a role with a non-empty `overlay` or leaves a `@part`, `@end` or
`@include` line in what a session is told. *A role's parts*, *the build role*
and *the review role* hold that each start is told its own part and no other
start's.

[`tests/mc/roles-decisions.test.js`](../../tests/mc/roles-decisions.test.js) —
what each role is told, read through the path that actually delivers it: the
assembler for the roles with a body, `planLaunch` for a role without one. It
walks the canon roles and their starts for the loose-thread and route rules,
asserts their text exists in exactly one file, and holds the decision shape a
goal's build and review are held to.

The delivered text is asserted at each launch path too, against
`sharedRoleText()` rather than a copy of it:
[`work-open.test.js`](../../tests/mc/work-open.test.js),
[`run.test.js`](../../tests/mc/run.test.js),
[`helper-turn.test.js`](../../tests/mc/helper-turn.test.js) and
[`commands/plan.test.js`](../../tests/mc/commands/plan.test.js).

The record and the reader are tested from both ends.
[`work-open.test.js`](../../tests/mc/work-open.test.js) asserts the digest the
register receives is the hash of the very string handed to the tool on the
command line, and that a resumed conversation records the role and no digests;
[`foreground.test.js`](../../tests/mc/foreground.test.js) asserts the record
reaches the file and the overlay text does not;
[`run.test.js`](../../tests/mc/run.test.js) asserts the lane's current file
carries it. [`commands/roles-cli.test.js`](../../tests/mc/commands/roles-cli.test.js)
drives the fault itself: a session is registered on a fixture role's text, the
file is edited under it, and `mc roles check` names it by pid — and says
nothing about the same session while the file is untouched.

**Not asserted from the file:** that a `model:` a role names is a model the
tool will accept. `modelArgs` in
[`claude-code.js`](../../src/adapters/claude-code.js) passes the string through
as given — the tool is the authority on its own model names — so a name it
rejects fails at launch and nowhere earlier. `plan`'s move to `fable` was
verified by opening a real planning session with it (2026-09-05, #614).


## Session identity is not only an instruction argument

Every launch sets `MC_ROLE` on new and resumed conversations. `MC_PROGRAMME`
accompanies programme-owned launches; `MC_GOAL` identifies a goal. Desks are
`manager`, `helper` and `intake`. The launch clears inherited session
identity first so the child cannot inherit the caller's job by accident.
Runner roles are `build-session:goal`, `review-session:goal`, `finish-session`
and `mend-session`; `plan` is the interactive plan session's.

`sessionIdentity` (`src/mc/session-role.js`) reads MC_ROLE first, then
MC_GOAL, then cwd. Programme directories identify plan sessions; their
`goals/<goal>/` subtrees identify goal builds instead. Brief, helper and
intake directories have their own fallbacks; unknown stays unknown. The
SessionStart hook prints what it found even outside a repository.

`mc plan` refuses recognised sessions and Claude/Codex agent markers before
creating anything. A session writes a goal through `mc goal`, not by opening
another interactive plan session. The runner's finish and mend sessions have
roles of their own and never use the plan role or that person's entrance.
