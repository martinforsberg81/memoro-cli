# mc plan — a programme's interactive session

```
mc plan [<programme>] [--new] [--codex|--claude] [--model <model>]
mc plan <programme> --archive
```

This is the person's entrance, not a command for a session already planning.
`src/mc/commands/plan.js` refuses recognised session identity or coding-agent
markers before choosing a programme or creating anything. Inside a session,
goals change through `mc goal new`, `mc goal set` and `mc goal criterion add`.
Help remains available.

## A programme, and why it is not a workarea

A programme is the initiative the work serves. Its aim is in
`~/mc/programs/<programme>/README.md`. Its interactive session starts in that
directory, with a worktree of each known repository beside it on
`plan/<programme>`. The directory also holds `goals/<goal>/`, each goal with
its own GOAL.json, LOG.md and repository worktrees on `goal/<goal>`.
The runner never builds in the programme session's checkouts.

`ensurePlanArea` fetches before creating missing worktrees from `origin/main`.
Existing checkouts are reused and dependencies reattached. Missing repositories
are said and skipped; no checkout at all is a failure. Layout 1's planning
root remains supported ([mc-layout.md](mc-layout.md)).

With no programme named, `chooseProgramme` offers a numbered list, a new name,
or an empty answer to leave. A pipe gets usage instead of a question. The
list combines programmes read from the repositories (`listProgrammes`) and
open planning areas on disk (`openPlanAreas`). A programme can be reopened
before it has documents on main, or after all its goals have been archived.

## What the session is told

`planLaunch` names the programme, asks it to read the aim first, names the
checkouts and their branches, and waits for Martin. In layout 2 it names the
goals beside them and `mc goal` as their writer. A `goal/<goal>` branch
belongs to that goal's worktree; a planning branch is `plan/<slug>`.
The prompt predicts no deliverable, pull request or landing route.

`openInWorkArea` resumes the existing conversation (`pick: null`), with no
intro; `--new` starts fresh. Instructions are `all-sessions.md` plus the
`plan-session` overlay, assembled by `instructionsFor`. The launch sets
`MC_ROLE=plan-session` and `MC_PROGRAMME` for new conversations and resumes.
The SessionStart hook also recognises the role from cwd.

The plan session has full freedom toward the programme's aim: investigate,
write goals, build and land work itself, or take over a goal's branch when
that costs less than a new build session. Interactive, Martin is at the
terminal. Headless, it never performs his acts: deploy, production data,
credentials or an admin merge. The runner starts a headless plan session
only for a goal in `finish`, or in `merging` after its first red or moved head.
That session starts in the programme directory and can enter the goal's
worktree to finish it; the runner does not place it in a programme checkout.
See [mc-goals.md](mc-goals.md).

## Writing goals

`goal-verb.md`, included by the role, describes the verbs. The goal carries
the goal, contract, boundaries, documents and criteria with their checks.
Stages move forward; `ready` or `blocked` is a separate status. Phases order
work across the programme: all goals of a lower phase finish or are dropped
before any goal in a higher phase starts. Build sessions neither rewrite the
brief nor invent another unit inside it.

A goal names a work class (`fast` or `large`), not a pinned provider. The
catalog and observed capacity choose tool, model and effort at launch. Review
has its own catalog list, changed with `mc model add|remove review` or
`mc model set review`.

Review is an ordered list of candidates: it takes the first that can run on its plan now and is not the model the goal was built on, and that model only when no other can.

## Archiving a programme

`mc plan <programme> --archive` is a person's act. The runner archives
finished goals, not the programme above them. `archiveProgramme`
(`src/mc/archive-programme.js`) refuses any goal not done or dropped and
anything the planning area's release forecast would keep. It checks before
changing anything.

In each repository that holds `docs/project/<programme>/`, it removes that
directory and adds a `closed` row for the programme in `project_log.md`, in a
docs-only pull request. An existing archive PR is reused. Only after those
PRs land are the planning worktrees released. In layout 2 the programme's
directory is moved whole to `~/mc/archive/programs/<programme>/` (a dated
name if needed); its remaining documents are not deleted. A network failure
leaves the planning area intact so a later attempt can continue.

`--archive` refuses session-selection flags and requires an explicit name.
No automatic pass can decide that a programme's aim is over.

## How it is tested

`tests/mc/commands/plan.test.js` covers the paths, refusal inside a session,
programme picker, prompt, role body, resume and new launch without opening a
tool. `tests/mc/archive-programme.test.js` covers archive refusals and ordering.
