# mc goals

**Status:** current · 2026-11-01 · derived from `src/mc/goals.js`,
`src/mc/commands/goal.js`, `src/mc/run.js` (`goalPass`, `runGoal`,
`goalWithoutWord`) and `canon/roles/goal.md`

A goal is two text files and a worktree, beside projects. It has no steps, no
register, no owner and no merge door. A goal session does the work and
publishes its pull request; a person or a plan session merges it. The ruling is [`rulings.md`](../project/mc/rulings.md) § 60 with its
2026-11-01 clarification; the earlier brief,
[`autonomy-goals.md`](../project/mc/autonomy-goals.md), is superseded.

## Layout

```
~/mc/programs/<programme>/goals/<goal>/GOAL.md    the brief and its status
~/mc/programs/<programme>/goals/<goal>/LOG.md     one entry per session, newest last
~/mc/programs/<programme>/goals/<goal>/<repo>/    a worktree on goal/<goal>, from origin/main
```

One worktree per repository the goal names. Anyone may work in one: a person,
a plan session, or a goal session. `<programme>` must be a directory under
`~/mc/programs/`; `<programme>` and `<goal>` are lower-case letters, digits and
hyphens. mc keeps nothing else for a goal.

## GOAL.md

Front matter between two `---` lines, then Markdown:

```
---
status: open
repos: memoro-cli, memoro
class: fast
created: 2026-11-01T20:00:00Z
---
# Title

## Goal

## Criteria

## Out of scope
```

- `status` — `open`, `blocked` or `done`. A goal starts `open`.
- `repos` — comma-separated repository names. The first is where a session
  starts, and the lane that serves it takes the goal.
- `class` — `fast` or `large`, routed as a step's class is (ruling 59).
- `created` — optional; written by `mc goal new`.

The body is Markdown, written by a person or a session. mc rewrites only the
`status` line. A GOAL.md whose front matter does not parse is listed by
`mc goal list` with its problems, and the runner never starts it.

## LOG.md

Each session adds one entry, newest last:

```
## 2026-11-01T21:30Z · claude claude-haiku-5-5 · open

Gjort: what the session did
Kommentar: what a reader should know
Nästa: what the next session should do
```

- The heading is `## <at> · <tool> [<model>] · <status>`: `<at>` is UTC to the
  minute; `<tool>` is `MC_TOOL`, `person` or `runner`; `<model>` is `MC_MODEL`
  when set; `<status>` is the goal's status after the entry.
- The labels are `Gjort:`, `Kommentar:` and `Nästa:`. A label's text runs on
  until the next label or heading, so a field may take several paragraphs.
- A heading that does not match the form is skipped with its lines.
- `mc goal new` writes the first entry: `person`, `open`, `Gjort: skapat`.
- A session count is every entry whose tool is neither `runner` nor `person`.

## The verbs

Five verbs; the status verbs are three words.

- **`new <p>/<g> --repo <r>[,<r>] --class fast|large --title "…"`** — makes a
  goal, refused unless its flags are valid and its names are new. Each
  repository is fetched first; then GOAL.md, LOG.md, and a worktree of each on
  `goal/<g>` from `origin/main` (or that branch as it stands, when it exists).
- **`log [<p>/<g>] [--done "…"] [--comment "…"] [--next "…"] [--status <s>]`** —
  appends one entry; at least one field is needed. `--status` also sets the
  status line. The goal is `MC_GOAL`'s when none is named.
- **`open|blocked|done [<p>/<g>] [--reason "…"]`** — sets the status and logs
  the reason as the entry's `Kommentar`.
- **`show <p>/<g>`** — the front matter, the body, the last three entries, and
  each worktree's changed files, commits past `origin/main` and last commit date.
- **`list [<p>]`** — one line per goal: `programme/goal · repos · status ·
  n sessions · the last entry's Nästa`.

## How the runner takes a goal

Goals are asked for only after project steps. In a lane with no runnable step,
`goalPass` in `src/mc/run.js` takes the next goal:

1. **Pick.** Of the open goals that parse, whose first repository this lane
   serves and that are not held, the one whose last entry is oldest. No entry
   means oldest of all; a tie goes to the first listed. Held means a current
   file named `goal:<programme>/<goal>` exists, or the lane claimed it this
   tick. A goal keeps no slot between its sessions.
2. **Worktrees.** A repository's worktree that has gone is made again on
   `goal/<goal>`, as `mc goal new` makes it.
3. **Launch.** A headless session with the `goal` role runs in the first
   repository's worktree, with the goal's class routing, model and billing as a
   step has them. `MC_GOAL`, `MC_REPO`, `MC_WORKAREA` and `MC_TOOL` are set. If
   `canon/roles/goal.md` is missing on the machine, the goal is skipped.
4. **Silent exit.** A session that leaves no entry gets one from the runner:
   tool `runner`, status unchanged, `Kommentar: session ended without a log
   entry (exit <n>, <s> s)`. A worktree that could not be made gets one too.
5. **Three in a row.** When the last three entries are all the runner's and the
   status is `open`, the runner sets `blocked` and writes a runner entry saying
   so. That is the only guard against a session that fails the same way every
   time; there is no attempt counter.

The runner never sets `done`. Each session is a row in `runs.tsv`, of kind
`goal`, named `goal:<p>/<g>`.

## What a goal session does

The role (`canon/roles/goal.md`) has it merge `origin/main` into its worktree,
work until the criteria hold, run `mc gate`, commit, and publish with
`mc publish --no-merge`. It ends with `mc goal log`, adding `--status done`
when the criteria hold and the pull request carries them, or `--status blocked`
when it cannot go on. A goal session publishes and never merges.

## Status

Set by a session (`mc goal log --status`, `mc goal open|blocked|done`) or by a
person; the runner sets `blocked` only in step 5. `open` goals are picked.

## What a goal does not have

- **No steps.** No `PLAN.json`, no `mc step`, no `mc project`. Criteria are text
  in GOAL.md.
- **No register.** mc writes the status line, LOG.md, the current file while a
  session runs, and the `runs.tsv` row. Nothing else.
- **No owner, lease, revision or capability report.** Anyone may work in the
  worktree; the last entry says what was done.
- **No review of its own.** A person or a plan session reads the pull request.
- **No merge door.** `mc merge <repo> <pr>` is a person's or a plan session's
  act. A goal session's pull request is not queued for the merger.
- **No close-out.** No archive verb; a `done` goal stays where it is.

The headless plan session (`autonomy on`) and phases are not built; they wait
until goal sessions have run for real.
