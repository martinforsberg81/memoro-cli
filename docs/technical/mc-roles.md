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
| `plan` | fable | `mc plan <programme>` — **frontmatter only**, see below |
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

## The one session that cannot inherit it

`canon/roles/plan.md` is **frontmatter only** and stays that way (#580): what a
planning session is told is its first prompt, composed by `planLaunch` in
[`plan.js`](../../src/mc/commands/plan.js), so that function is the whole
account of what that session hears
([`mc-plan.md`](mc-plan.md#what-the-session-is-told)).

Its overlay is therefore `null`, and the assembler correctly hands it nothing.
So `planLaunch` reads `sharedRoleText()` itself and folds it into the prompt.
The other shape — having the assembler supply the shared text when the overlay
is null — would have cost the parallel-operation guarantee above: it would need
a second flag saying "this null overlay is a role and that one is not", which
is the drift this mechanism exists to stop. Reading the one file keeps the rule
in a single home and keeps `planLaunch` the single account of its own prompt.

## Where the code is

| file | what |
|---|---|
| `src/mc/roles.js` | `parseRole`, the two catalogues, `sharedRoleText`, `instructionsFor`, the `.mc-role` mark, the reserved names |
| `src/mc/canon.js` | `canonRoot` — where the packaged `canon/` is, resolved from the module's own path |
| `src/mc/portrait.js` | `profileArgs` — the per-tool launch argument the assembled text rides on |
| `src/mc/commands/roles.js` | `mc roles list`, `mc roles show <role>` over the user's catalogue |
| `canon/roles/_common.md` | the text every role session shares |
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

[`tests/mc/roles-decisions.test.js`](../../tests/mc/roles-decisions.test.js) —
what each role is told, read through the path that actually delivers it: the
assembler for the roles with a body, `planLaunch` for `plan`. It walks all
seven canon roles for the loose-thread and route rules, asserts their text
exists in exactly one file, and holds the decision shape `worker`, `step` and
`repair` are held to.

The delivered text is asserted at each launch path too, against
`sharedRoleText()` rather than a copy of it:
[`work-open.test.js`](../../tests/mc/work-open.test.js),
[`run.test.js`](../../tests/mc/run.test.js),
[`helper-turn.test.js`](../../tests/mc/helper-turn.test.js) and
[`commands/plan.test.js`](../../tests/mc/commands/plan.test.js).

**Not asserted from the file:** that a `model:` a role names is a model the
tool will accept. `modelArgs` in
[`claude-code.js`](../../src/adapters/claude-code.js) passes the string through
as given — the tool is the authority on its own model names — so a name it
rejects fails at launch and nowhere earlier. `plan`'s move to `fable` was
verified by opening a real planning session with it (2026-09-05, #614).
