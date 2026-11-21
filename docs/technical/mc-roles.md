# Roles — how a session is instructed

Every session mc starts in a role is told two things, in this order: the text
**every role session shares**, and **that role's own words**. Nothing else —
the user's Coding Profile, which once came first, was removed by ruling 24, and
the one rule in it nothing else said (what is written in English) is a sentence
in `all-sessions.md`. This document is the one account of how those two are found
and joined. `mc run`, `mc plan`, `mc martin` and `mc manager` each described a corner
of it from their own angle; they now point here, because parallel accounts
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

What canon holds today: five stage/goal roles, each one file, plus the Martin desk, preparation, decision and ask-reader roles and the three that
stay apart (Martin, 2026-11-03, goal `plan-session-roles`: a role says what
the session is for; a verb file says how a verb is used). Plan supports interactive planning; the runner starts no plan session, and cuts a ready order by code. Mend retains its former delivery recovery work (Martin, 2026-11-07 and 2026-11-09). The finish role was removed on 2026-11-15: a rejected goal returns to build, and `finish` is a name kept for old records (their stage, their run rows, the `finish` model list).

| role | model | started as | who launches it |
|---|---|---|---|
| `plan-session` | opus | `plan` | `mc plan <programme>`, a foreground session in `~/mc/programs/<programme>/`; the runner never starts it |
| `programme-review` | sonnet | `programme-review` | `mc programs review`, called by Martin's interactive session for an advisory reading or by the assigned repair author for a release receipt; never scheduled by the runner; review catalogue/author exclusion, 30-minute limit and no cap ([mc-plan.md](mc-plan.md#programme-state-and-advisory-reading)) |
| `ask-reader` | opus | `ask-reader` | `mc ask`, when jev did not settle a question: one fresh headless read-only session, in a read-only copy of the asker's worktree, on the `decision` list (not the asker's own model when another can run), limit 10 minutes; never the runner. It may use only `mc goal show\|list\|areas` and `mc ask answer`, and its run row (kind `ask-reader`) counts under the desk's daily ceiling ([mc-jev.md](mc-jev.md) § *The reader*) |
| `build-session` | opus | `build-session:goal` | `mc run`, one headless session on a goal in `build`, a repair build when a review rejected it ([mc-goals.md](mc-goals.md) § *Repair and mend*) |
| `review-session` | opus | `review-session:goal` | `mc run`, the review of a goal in `review` |
| `mend-session` | opus | `mend-session` | `mc run`, one headless session only after a merge failure (conflict, failed candidate check or moved judged head) ([mc-goals.md](mc-goals.md) § *Repair and mend*) |
| `manager` | opus | `manager` | `mc run`, the manager's horizon and curation turns ([mc-run.md](mc-run.md)); `mc manager --headless`, an explicit fresh task; never a conversation |
| `martin` | opus | `martin` | `mc martin`, foreground in `~/mc/martin/`; never the runner |
| `intake` | sonnet | `intake` | only a person's `mc helper --intake`, one headless turn per file; the runner starts none (Martin, 2026-11-21) |
| `decision` | opus | `decision` | runner lane or a person’s `mc decision [<id>]`, unattended on its own `decision` list; full goal desk authority within headless hooks ([mc-martin.md](mc-martin.md)) |
| `desk-prepare` | sonnet | `desk-prepare` | only a person's `mc martin prepare`, one fresh headless evidence-only turn per item on the `build` list; the runner starts none (Martin, 2026-11-21); no goal identity or mutation authority ([mc-martin.md](mc-martin.md)) |
| `learning` | opus | `learning` | `mc learning` or chores, one headless session on the `decision` list in `~/mc/martin/lessons/`. It updates factual area information and records dispositions, never creates a programme or goal ([mc-martin.md](mc-martin.md) § *Lessons and the learning pass*) |
| `repair` | opus | `repair` | `mc repair`, with `MC_ROLE=repair` and `MC_HEADLESS=1`. It reads one defect to propose a bounded functionality repair or record why none is established. |

The repair role has no execution tools and inherits neither another session's
identity nor runtime secrets. The caller feeds selected evidence on stdin and
services only bounded reads/searches of versioned standards, source, tests and
scripts at pinned `origin/main` revisions. Each source has up to two rounds
of four reads and five minutes for the model. Raw output is not written to a
session transcript by mc. Only the caller validates and writes a disposition
or a draft; the role cannot plan, review, release or act on production.

The repair handoff commands validate a live programme-bound repair lease
before reviewing, releasing or stopping a repair order. The model itself
does not receive that lease or execution tools. Programme dispositions are
interactive Martin's alone; repair cannot close a scope stop.

`programme-review` reads the document, horizon playback/basis, cited code and
standards, unread places and pictures at origin/main. Its eight questions and
two-line PROGRAMME-REVIEW.md format live in its role, not a second question
list. It records only a token-bound programme verdict; mc goal mutations and
mc ask refuse it, and it has no signing authority. The shared reader launch
clears inherited goal/session identity and assigns MC_PROGRAMME, its role and
MC_PROGRAMME_REVIEW_TOKEN.

## Parts: one role, started more than one way

### Martin's decision desk

`mc martin` is a foreground-only desk in `~/mc/martin/`, distinct from
the manager, plan and helper. It cannot be launched by the runner or an unattended
session. Its `get` subcommand is a model-free, read-only view over live
goal records, not a cache or a second queue store; see [mc-martin.md](mc-martin.md).
A resumed conversation receives a fresh queue snapshot so remembered goals are
not treated as current.

Martin explicitly granted this interactive role full authority over waiting
goals: take over and finish, fix only the obstacle and return to the same
stage, hand off to an appropriate stage, rewrite goal/criteria/programme plan,
move stages backward or forward, or drop. The goal verbs enforce it and log
`by martin`; the role text alone is not authorization. It preserves JSON
validation and acceptance, review, gate, publish and merge evidence. It cannot
mark criteria met administratively. The unattended `decision` role has the same goal authority, including rewriting, backward moves and dropping, but never administrative done. Its default list is `claude:opus:high`, then `codex:gpt-6.2-sol:high`; the interactive Martin role stays interactive-only. Headless hooks still refuse decision deploy/admin/production-data/credential acts. Other session roles retain their bounds.

Horizons, what the desk holds as worked toward, are set, moved, reopened and dropped only by the interactive Martin role or a person; the unattended manager may mark one reached and may propose one as a text item, and never creates one. [mc-martin.md](mc-martin.md) § Horizons holds the rest.

`MC_ROLE=learning` only reads goals (`show`, `list`, `areas`) and programme
records. Its dispositions and area publications use `mc learning`'s own
subcommands. Headless refusals still apply when started from the terminal.

Martin investigates source questions against shared technical standards and
programme design before raising a choice. Resolved details are not escalated.
A remaining choice that is a change to a text Martin holds is brought in the
form of [mc-martin.md](mc-martin.md) (*Durable desk items*): what the text
says, the proposed wording as its second part, and what was found, with no
alternatives and no recommendation; any role but `desk-prepare` may leave one
with `mc martin propose`. Alternatives/tradeoffs, one recommendation and the
exact act stay for a reserved act. No clock changes anything on the desk: a
brief waits for him, and nothing carries out a recommendation after a time.
Original queue evidence remains
unchanged. After a decision, the canonical standard and affected programme and
goal contracts are reconciled before handoff. Get remains model-free and does
not reinterpret historical questions.

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
| `work-open.js:93` (`openInWorkArea`) | a foreground conversation in an area — `mc martin`, `mc plan` |
| `work-open.js:342` (`launchCommand`) | the argv a tmux launch or a handoff respawn is built from |
| `run.js` (`runGoal`) | a selected-draft plan, build, review or mend session |
| `helper-turn.js:258` | the intake turn, one file, headless |

Each of them used to write the join out by hand.

## The verb files

`canon/verbs/goal.md` holds the goal manual. The plan, mend and manager role files name
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

An overlay is chosen by the role's name and part, never by the form of the
goal. A goal that is a part of an order ([mc-goals.md](mc-goals.md#a-goal-that-is-a-part))
is therefore built with the same `build-session:goal` part, which carries one
section for it, *A goal that is a part*: read the whole part and the log, write
each reading of something unclear as a `Read as:` line and build on it, report
no goal defect, hand over with one entry, and in a repair fix each rejected
line and every other place with the same fault. The prompt of such a goal says
that this section applies and that what the role says about criteria,
obligations, evidence records and goal defects does not (`goalPrompt`,
`run-plan.js`). The review role has no such section yet.

Planning aims for a goal a build session can reasonably hand to independent
review in one turn, not a new limit. When a build continues, its goal log records
the concrete implemented or verified result and a specific remaining task in
`Next`, including useful verification without a commit; if nothing useful was
established it says so. This guidance changes neither eligibility nor runner
stops. Repairable in-scope obstacles remain with build; a verified wrong brief
or impossible premise follows the goal-defect technical desk route.

**The plan session** (`plan-session.md`) is written around the programme's
aim in `~/mc/programs/<programme>/README.md` (Martin, 2026-11-03). Its primary
deliverable is the programme's planning: the README and design, the resolved
prerequisite and policy decisions, the goal decomposition and phases, and
complete goal briefs with contracts, exclusions, documents, success criteria and
executable checks. A complete brief moves from draft to build; the build session establishes its
[acceptance setup](mc-plan.md#acceptance-setup-at-build). A consumer awaiting
a producer is in build in a dependent phase; a brief with unresolved planning
prerequisites stays draft. Within that it has, in
principle, full freedom to move the programme toward the aim, a goal's branch
included: it may finish a goal's work itself when that is quicker than a new
build session. That freedom is interactive. The runner does not run the role:
code cuts a ready order into one goal per part, with no session
([mc-run.md](mc-run.md#the-cut-of-a-ready-order); Martin, 2026-11-21), and the
role's section *The headless programme turn* says only that. It names
the headless roles and what each owns, so it knows the goal's text is its
own and a headless session's `Martin` is a question for it. A goal
is what the runner builds, a means toward the aim. `refusedMove`
(`commands/goal.js`) still enforces forward stage moves for plan sessions. Before 2026-11-03 the
role was `plan.md`, which forbade a headless plan session code, commits, a
publish and `review`/`done`, and listed three allowed ends; both are gone.
Until 2026-11-07 the same file had headless sections (`### finish`, `### blocked`,
programme planning, `MC_PLAN_REASON`); those are gone too. What it writes unasked is in [mc-plan.md](mc-plan.md) § *Writing goals*.

**The mend session** (`mend-session.md`) states one job, its inputs, what it may
change, its exits and what it hands to whom. The repair a review asks for is a
build session's (`build-session.md`, the repair case): it reads REVIEW.md, fixes
the NOT OK items and moves the goal to review, or resolves its own acceptance
obstacle or sets `Martin` directly (a change to the goal, contract or scope).
`canon/roles/finish-session.md` was removed on 2026-11-15. Mend owns a reported merge failure through repair,
final acceptance and requeue, preserving intervening person decisions. An unchanged delivery retry can retain
valid evidence; a content-changing repair requires acceptance of the repaired
worktree. Bounded failure outside its authority waits on Martin. Neither mend nor a repair build changes
the goal's text: `refusedMove` and the criterion verbs refuse them, as they
refuse build and review.
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
`martin` and the eye's `intake`; `manager` is launched headless, by the runner or by a person. The launch clears inherited session
identity first so the child cannot inherit the caller's job by accident.
Runner roles are `build-session:goal`, `review-session:goal`
and `mend-session`; `plan` serves interactive planning only.

`sessionIdentity` (`src/mc/session-role.js`) reads MC_ROLE first, then
MC_GOAL, then cwd. Programme directories identify plan sessions; their
`goals/<goal>/` subtrees identify goal builds instead. Brief, helper and
intake directories have their own fallbacks; unknown stays unknown. The
SessionStart hook prints what it found even outside a repository.

`mc plan` refuses recognised sessions and Claude/Codex agent markers before
creating anything. A session writes a goal through `mc goal`, not by opening
another interactive plan session. The runner's mend sessions have
roles of their own and never use the plan role or that person's entrance.
