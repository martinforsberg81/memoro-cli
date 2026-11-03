# Roles — how a session is instructed

Every session mc starts in a role is told two things, in this order: the text
**every role session shares**, and **that role's own words**. Nothing else —
the user's Coding Profile, which once came first, was removed by ruling 24, and
the one rule in it nothing else said (what is written in English) is a sentence
in `all-sessions.md`. This document is the one account of how those two are found
and joined. `mc run`, `mc plan`, `mc helper` and `mc brief` each described a corner
of it from their own angle; they now point here, because four parallel accounts
of one mechanism is four things to keep true.

What a session is told is never written into a worktree. It rides on the launch
argument each tool already takes — `--append-system-prompt` for claude, `-c
instructions=` for codex — built by `profileArgs` in
[`portrait.js`](../../src/mc/portrait.js). Nothing is left on disk for a
session to find, and nothing has to be cleaned up after one.

The code is [`src/mc/roles.js`](../../src/mc/roles.js).

A role reaches only a session mc launches. The guidance every session reaches —
launched by mc or opened by hand — is a task skill, installed where Claude Code
and Codex look for skills: [mc-skills.md](mc-skills.md). A role names one with
`@skill <name>` instead of repeating it (below).

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

What canon holds today: three roles, each one file, and the three that stay
apart (Martin, 2026-11-03, goal `plan-session-roles`: a role says what the
session is for; a verb file says how a verb is used).

| role | model | started as | who launches it |
|---|---|---|---|
| `plan-session` | fable | `plan-session` | `mc plan <programme>`, a foreground session in `~/mc/programs/<programme>/`; and `mc run`, one headless session on a blocked goal ([mc-goals.md](mc-goals.md) § *A blocked goal wakes plan*) |
| `build-session` | opus | `build-session:goal` | `mc run`, one headless session on a goal |
| | | `build-session:project` | `mc run`, one step of a `PLAN.json` (with its `workers` part when the plan says `subagents: on`) |
| | | `build-session:worker` | `mc worker`, and every conversation in that area after |
| `review-session` | opus | `review-session:goal` | `mc run`, the review of a goal in `review` |
| | | `review-session:project` | `mc run`, the review step of a branch-flow plan: it measures the criteria and lands the project |
| `brief` | opus | `brief` | `mc brief`, a foreground session in `~/mc/brief/` |
| `helper` | sonnet | `helper` | `mc helper`, the desk, foreground in `~/mc/helper/` |
| `intake` | sonnet | `intake` | the inbox drain, one headless turn per file |

## Parts: one role, started more than one way

A role started more than one way keeps each start's words in a part:

```
@part goal
…only a goal's build is told this…
@end
@part goal project
…every headless build is told this; a worker is not…
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
`withWorkers(role, true)` keeps the `workers` part as well, for a step with
Haiku workers. The constants are `PLAN_ROLE` and `REVIEW_ROLE` in `goals.js`,
`BUILD_ROLES` and `PROJECT_REVIEW_ROLE` in `run-plan.js` and `WORKER_ROLE` in
`roles.js`. An area marked `worker` before 2026-11-03 still opens as the
worker part (`MOVED_MARKS`).

`worker` is the one that reaches a session through a work area rather than a
verb. `markAreaRole` writes `.mc-role` — one file, one word — when the area is
created, `areaRole` reads it every time a conversation starts there, and an
area without the file is an ordinary area and stays one. A role is decided at
creation, never acquired.

## The shared file

`canon/roles/all-sessions.md` is the text every role session is told, whichever role
it is. It holds only what is true of any session and is not a task: what a turn
costs, that you are already a session, that you read the code before deciding
and say what you actually ran, that task rules are skills the role names, and
what is written in English. Everything that is a task — the gate, publishing
and merging, conflicts, the shared git directory, proposals, processes, scratch
files and probes, `mc shot`, dev servers, asking Martin, memory — is a skill in
`canon/skills/` (goal `agent-skills-text`, 2026-11-02), and a role file that
needs one names it with `@skill`.

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
  return [shared, expandRoleIncludes(overlay)].filter(Boolean).join('\n\n---\n\n') || null;
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
| `work-open.js:93` (`openInWorkArea`) | a foreground conversation in a work area — `mc work`, `mc brief`, `mc helper`, `mc plan` |
| `work-open.js:342` (`launchCommand`) | the argv a tmux launch or a handoff respawn is built from |
| `run.js` (`runStep`) | a runner session: a step |
| `helper-turn.js:258` | the intake turn, one file, headless |

Each of them used to write the join out by hand.

## The verb files

`all-sessions.md` is what *every* role session is told. How a verb is used is
not that: the plan session and the brief write plans and a build session does
not, and telling a build session how to write a `PLAN.json` it may never write
is worse than telling it nothing. So each verb is a file of its own, and a role
that uses the verb names it on a line of its own:

```
@include project-verb.md
```

| file | what it says | included by |
|---|---|---|
| `project-verb.md` | runner or session; driving work in a session; writing a `PLAN.json` | `plan-session`, `brief` |
| `step-verb.md` | a step that waits on Martin, and bringing it back with `mc step ready` | `plan-session`, `brief` |
| `goal-verb.md` | what a goal is, its entries, who sets which status | `plan-session` |

`expandRoleIncludes` replaces that line with the file's text **in
`instructionsFor`** — the same door, for the same reason a second one was never
opened. It is deliberately not expanded in `parseRole`: `overlay` stays the
role's own words, which is what `run.js`'s installed-or-not check and
`mc roles show` read.

Three properties are mechanical rather than tidy. Only a `*-verb.md` name in
`canon/roles/` can be included, so a role cannot include a role and there is no
recursion to bound. The marker has to be a line of its own — a mention inside a
sentence is left alone. And a name that resolves to nothing is left standing in
the text rather than dropped: a visible `@include` line in a session's
instructions is a broken install somebody can see, and a rule that quietly
vanished is not.

A role names a task skill the same way: `@skill publish-and-merge` on a line of
its own becomes, in `instructionsFor`, a pointer to the installed
`mc-publish-and-merge` — its description and its path for the session's tool
(`~/.claude/skills/…` or `~/.agents/skills/…`) — not its text; the tool loads
the skill as it loads any. A name `canon/skills/` does not ship is left standing,
as an unknown `@include` is. See [mc-skills.md](mc-skills.md).

The build role is the first role with parts. A goal's build, a project's step
and a worker were three files until 2026-11-03 (`build-goal.md`,
`build-project.md`, `worker.md`, with `_build.md` and `_step-workers.md`
included); they are `build-session.md` now. What is true of every headless
build is one part, `@part goal project`: **one branch, built to the end** — a
build never fetches or merges `origin/main` to keep up, and a conflict the
merger reports is the one time it does — and **when a session ends**: at a
boundary between two items, only when the work is done, when it is blocked, or
when its turns cost more than a fresh session reading the log would. The
worker, at a person's terminal, is not told it. `roles.test.js` holds that each
start is told its own part and no other start's, and that no build start tells
a session to merge `origin/main` otherwise. The review role is the same shape:
`review-session.md`, a `goal` part (judge, never build) and a `project` part
(measure, close the gaps, land).

**The plan session** (`plan-session.md`) is written around the programme's
aim in `~/mc/programs/<programme>/README.md` (Martin, 2026-11-03). It has, in
principle, full freedom to move the programme toward it, a goal's branch
included: it may finish a goal's work itself when that is quicker than a new
build session. Interactive, it has no restrictions; headless, it never does
Martin's acts — `mc deploy`, production data, credentials, `--admin`. A goal
is what `mc build goal` runs, a means toward the aim. `refusedStatus`
(`commands/goal.js`) refuses a plan session no status. Before 2026-11-03 the
role was `plan.md`, which forbade a headless plan session code, commits, a
publish and `review`/`done`, and listed three allowed ends; both are gone.
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
  "name": "build-session:project",
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
purpose. A session running the catalogue's `worker` is not running a stale copy
of canon's; it is running the rulebook, and it is compared against the file it
actually came from. (An `@include` always resolves in canon, whichever
catalogue the role itself came from.)

A launch that assembled nothing records the role and no digests. That is the
resumed conversation: its instructions are in its own history, and a digest of
today's file would be a claim about it nobody checked.

`mc roles check [<role>]` is the reader:

```
$ mc roles check build-session:project
build-session:project  (canon)  …/canon/roles/build-session.md
  role text     sha256:43046c402ec7
  instructions  sha256:345f6ea5956c   all-sessions.md + overlay, as a launch joins them

2 live sessions: 1 ok, 1 drift
  55012  build the-page-remade    2026-09-06T10:06:46Z  build-session:project  ok
  55130  build total-lane-cap     2026-09-06T09:34:57Z  build-session:project  drift — started on sha256:9c1…, build-session.md is sha256:430… now

----- what a launch would hand a build-session:project session today -----
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
| `src/mc/roles.js` | `parseRole` and parts (`roleRef`, `selectParts`, `withWorkers`), the two catalogues, `sharedRoleText`, `expandRoleIncludes`, `instructionsFor`, `textDigest`/`roleRecord`/`roleSourceOf`, the `.mc-role` mark, the reserved names |
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
file are in exactly that file, that `plan-session` and `brief` carry the
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
worker and a project's build are held to.

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

Every launch sets `MC_ROLE` for its own session, including resumed foreground
sessions and tmux replacements. `MC_PROGRAMME` accompanies plan, step, goal and
review launches when the programme is known. The intake turn sets `MC_ROLE=intake`, not `helper`.
An ordinary work conversation sets `MC_ROLE=work`; a worker uses
`build-session:worker`. Every other launch sets the role it was started on:
`plan-session`, `build-session:goal`, `build-session:project`,
`review-session:goal`, `review-session:project`.
Launchers clear inherited role, programme, goal and step identity first, so a
child never inherits its caller's job by accident.

[`session-role.js`](../../src/mc/session-role.js) is shared by the launchers,
the SessionStart hook and the `mc plan` refusal. It reads `MC_ROLE` first, then
older `MC_GOAL` and `MC_STEP` markers, then cwd under the work root. Programme
directories identify an interactive plan session; their `goals/<goal>/`
subtrees identify goal sessions instead. Both step layouts, brief, helper and
intake have cwd fallbacks. An unrecognised directory is
unknown, not a guessed role. The hook names what it checked in its first line.

`mc plan` is the person's entrance. It refuses a recognised session, or a
Claude/Codex session marker, before choosing a programme or creating anything.
Plan changes inside a session use `mc project new`, `mc project step add` and
`mc project send`. The plan session is interactive with Martin; a headless plan
session is not built yet.
