# Roles — how a session is instructed

Every session mc starts is told three things, in this order: the user's
**Coding Profile**, the text **every role session shares**, and **that role's
own words**. This document is the one account of how those three are found and
joined. `mc run`, `mc plan`, `mc helper` and `mc brief` each described a corner
of it from their own angle; they now point here, because four parallel accounts
of one mechanism is four things to keep true.

What a session is told is never written into a worktree. It rides on the launch
argument each tool already takes — `--append-system-prompt` for claude, `-c
instructions=` for codex — built by `profileArgs` in
[`portrait.js`](../../src/mc/portrait.js). Nothing is left on disk for a
session to find, and nothing has to be cleaned up after one.

The code is [`src/mc/roles.js`](../../src/mc/roles.js).

## The catalogue

A role is a markdown file: frontmatter for what mc needs to know, body text for
what the conversation needs to be told.

```
---
name: step
model: opus
singleton: false
tools: claude, codex
---
You are one step of the runner: …
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

What canon holds today:

| role | model | who launches it |
|---|---|---|
| `brief` | opus | `mc brief`, a foreground session in `~/mc/` |
| `helper` | sonnet | `mc helper`, the desk, foreground in `~/mc/helper/` |
| `intake` | sonnet | the inbox drain, one headless turn per file |
| `plan` | fable | `mc plan <programme>`, a foreground session in `~/mc/plan/<programme>/` |
| `repair` | opus | `mc run`, on a pull request whose landing failed |
| `step` | opus | `mc run`, one step of a `PLAN.json` |
| `worker` | opus | `mc worker`, and every conversation in that area after |

`worker` is the one that reaches a session through a work area rather than a
verb. `markAreaRole` writes `.mc-role` — one file, one word — when the area is
created, `areaRole` reads it every time a conversation starts there, and an
area without the file is an ordinary area and stays one. A role is decided at
creation, never acquired.

## The shared file

`canon/roles/_common.md` is the text every role session is told, whichever role
it is. It holds what is true of any session mc starts: what a turn costs, that
you read the code before deciding and say what you actually ran, the shape of a
question that reaches Martin, what to do with a finding that is not your job
and why that is `~/mc/proposals/` and not `~/mc/intake/`, how a stopped merge is
resolved, the route to `main` and what `mc merge` decides, what stays Martin's,
and what changes when a session is running under `mc run`.

It began as the turn-cost paragraph, which was byte-identical in four role
files with two variants in two more — six places for one rule to drift, and the
day they disagree is the day one kind of session quietly stops being told
something every other kind is.

Two things about where it sits are mechanical rather than tidy:

**The underscore means "not a role".** `listRoles` makes a role out of every
`*.md` in a catalogue directory, so a `common.md` copied into a user's
catalogue would be listed and shown by `mc roles list` as a role named
`common`. `listRoles` skips a leading underscore instead. (The shipped file has
no frontmatter either, so `parseRole` would reject it as well — but the name is
the guard, and the guard is what is tested.) The alternative shape,
`canon/common.md` beside `roles/`, could not be mistaken for a role at all;
keeping every piece of instruction text in one directory won.

**It is read at assembly, not folded into `overlay`.** `readCanonRole(name).
overlay` stays the role's *own* words. `mc roles show <role>` prints it as that
role's text, `tests/mc/roles-decisions.test.js` asserts on one role's wording
through it, and — the reason that matters — `run.js` tests `role.overlay` to
decide whether a role file is installed at all:

```js
if (!role?.overlay) { say(`${name}: canon/roles/${kind}.md is missing — skip`); return 'skipped'; }
```

A shared preamble folded in ahead of that check would make a missing
`repair.md` look present, and the runner would launch a ninety-minute session
with no instructions for what it is doing.

## The assembler

```js
export function instructionsFor(toolId, profile, overlay) {
  const shared = overlay ? sharedRoleText() : null;
  return [profile, shared, overlay].filter(Boolean).join('\n\n---\n\n') || null;
}
```

That is the single door. **No overlay is no role, and no role is no shared
text** — a conversation in an ordinary work area inherits nothing, which is the
whole parallel-operation guarantee. The same text goes to every tool, because
the channel is the same shape for every tool; codex's `-c instructions=` was
verified to layer over the base instructions rather than replace them (see
[`portrait.js`](../../src/mc/portrait.js)), and a tool mc has no channel for
gets an empty argument list and is unaffected by any of this.

Four paths launch a session with instructions, and all four call it:

| path | the session |
|---|---|
| `work-open.js:93` (`openInWorkArea`) | a foreground conversation in a work area — `mc work`, `mc brief`, `mc helper`, `mc plan` |
| `work-open.js:342` (`launchCommand`) | the argv a tmux launch or a handoff respawn is built from |
| `run.js:1355` | a runner session: a step, or a repair |
| `helper-turn.js:258` | the intake turn, one file, headless |

Each of them used to write the join out by hand.

## A passage two roles share

`_common.md` is what *every* role session is told. Since 2026-09-06 there is a
second kind of shared text, and it is not that: two roles write plans — the
planning session, and the brief for a proposal Martin said GO to (ruling 11) —
and six do not. Telling a `step` session how to write a `PLAN.json` it may
never write is worse than telling it nothing, so the plan-writing rules are
neither in `_common.md` nor copied into both role files. They are
`canon/roles/_plan-writing.md`, and each of the two names it on a line of its
own:

```
@include _plan-writing.md
```

`expandRoleIncludes` replaces that line with the file's text **in
`instructionsFor`** — the same door, for the same reason a second one was never
opened. It is deliberately not expanded in `parseRole`: `overlay` stays the
role's own words, which is what `run.js`'s installed-or-not check and
`mc roles show` read.

Three properties are mechanical rather than tidy. Only an underscored name in
`canon/roles/` can be included, so a role cannot include a role and there is no
recursion to bound. The marker has to be a line of its own — a mention inside a
sentence is left alone. And a name that resolves to nothing is left standing in
the text rather than dropped: a visible `@include` line in a session's
instructions is a broken install somebody can see, and a rule that quietly
vanished is not.

`canon/roles/plan.md` had no body at all until #656 — six lines, every one of
them frontmatter — so an `mc plan <programme>` session was told its model,
`_common.md` and its first prompt, and nothing about planning. #580 was called
*"Every role says a turn is the cost; the plan role gets a body"* and landed
only the first half. It has one now: the programme as the unit, `~/mc/plan/`
and why it is not a workarea, the two kinds of work that are its own (thinking
a programme through, and a `plan-review` park), the project the brief has
already decided and it therefore does not take, and the shared passage above.
`planLaunch` no longer folds `sharedRoleText()` into its prompt — with a role
body, the shared text arrives through the assembler like every other session's,
and pasting it in as well would say it twice.

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
  "name": "step",
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

**Two digests, because two different things can move.** `digest` is over the
assembled instructions — profile, `_common.md`, overlay, joined as
`instructionsFor` joins them — and answers *is this session running what a
launch would produce now*. `text_digest` is over the role's own body with its
includes expanded, and answers *is this session running the role file on disk
today*. Only the second is the fault: a Coding Profile edited at lunchtime
moves the first and not the second, and one digest could not have told those
apart — it would have reported every live session as drifted every time Martin
touched his profile.

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
$ mc roles check step
step  (canon)  …/canon/roles/step.md
  role text     sha256:43046c402ec7
  instructions  sha256:345f6ea5956c   profile + _common.md + overlay, as a launch joins them

2 live sessions: 1 ok, 1 drift
  55012  step the-page-remade     2026-09-06T10:06:46Z  step   ok
  55130  step total-lane-cap      2026-09-06T09:34:57Z  step   drift — started on sha256:9c1…, step.md is sha256:430… now

----- what a launch would hand a step session today -----
…
```

Named, it prints the whole assembled text — the same object the digests are
taken from, so the two halves of the comparison cannot be different things —
and checks the sessions running that role. Bare, it checks every live session
against the role each one names. `--json` for both. The verdicts are `ok`,
`drift` (the role file has moved under it), `profile` (the role text matches,
the Coding Profile has changed), `resumed`, `no-role-file`, and `unrecorded` —
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
| `src/mc/roles.js` | `parseRole`, the two catalogues, `sharedRoleText`, `expandRoleIncludes`, `instructionsFor`, `textDigest`/`roleRecord`/`roleSourceOf`, the `.mc-role` mark, the reserved names |
| `src/mc/canon.js` | `canonRoot` — where the packaged `canon/` is, resolved from the module's own path |
| `src/mc/portrait.js` | `profileArgs` — the per-tool launch argument the assembled text rides on |
| `src/mc/commands/roles.js` | `mc roles list`, `mc roles show <role>` over the user's catalogue; `mc roles check` over both catalogues and the two registers |
| `src/mc/foreground.js` | `~/mc/runner/foreground/<pid>.json` — the register a verb holding a terminal writes, role record and all |
| `canon/roles/_common.md` | the text every role session shares |
| `canon/roles/_plan-writing.md` | the passage `plan` and `brief` share about writing a `PLAN.json` |
| `canon/roles/<name>.md` | one role's frontmatter and its own words |

## How it is tested

[`tests/mc/roles.test.js`](../../tests/mc/roles.test.js) — `parseRole` on text
(frontmatter, no frontmatter, CRLF, the filename fallback), the catalogue and
the missing catalogue, the `.mc-role` mark, and the assembly: the join for both
tools, the profile alone when there is no overlay, `null` when there is
neither. Its *text every role session shares* block asserts the turn-cost rule
is in exactly one file in `canon/roles/`, reaches every canon role that has a
body, is **not** listed as a role with the file sitting in the catalogue
directory under test, and is not in `step`'s own overlay.

Two blocks below it. *A passage two roles share* asserts three sentences of
`_plan-writing.md` are each in exactly one file in `canon/roles/`, that `plan`
and `brief` both carry the marker and neither a copy, that the passage is not
itself listed as a role, that `instructionsFor` expands the marker and leaves
none behind — and that an unresolvable marker is left standing. *Every canon
role has a body* walks `canonRolesDir()` and fails any `*.md` without a leading
underscore that does not parse to a role with a non-empty `overlay`; it is the
guard that would have caught `plan.md`, and it failed on the tree that shipped
it.

[`tests/mc/roles-decisions.test.js`](../../tests/mc/roles-decisions.test.js) —
what each role is told, read through the path that actually delivers it: the
assembler for the roles with a body, `planLaunch` for a role without one. It
walks all seven canon roles for the loose-thread and route rules, asserts their
text exists in exactly one file, and holds the decision shape `worker`, `step`
and `repair` are held to.

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
