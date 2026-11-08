# mc plan — a programme's interactive session

```
mc plan [<programme>] [--new|--resume [<id>]] [--codex|--claude] [--model <model>]
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

When `mc plan` opens a programme whose planning directory has no `README.md`,
it writes the fenced page from `canon/tasks/references/programme-readme.md`
before the session starts, and the opening prompt says it is a template to
fill in. An existing README is never touched.

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

### Resume selection and provenance

`openInWorkArea` discovers conversations from the tools' native stores under
its area root. In layout 2 that includes descendant goal worktrees: newest
same-tool conversation alone is **not** a safe plan-session selection.
For a role-aware entrance (including `mc plan`), automatic selection walks
newest first within the requested tool and resumes only positive evidence of
the same normalized role **and** programme. `plan` and `plan-session` are the
same identity; `brief` and `manager` share the existing identity alias too.
Cwd, labels, user messages, and the environment for the new launch do not
prove a historical conversation's authority. A compatible older plan can win
over a newer descendant review. Unscoped ordinary work-area opens retain
their existing selection; they do not establish role provenance.

Skipped candidates are explained on stderr. With no compatible conversation,
the opener starts fresh with the requested role instructions and opening
prompt. `--new` always starts fresh. `mc plan <programme> --resume` offers a numbered
list of compatible conversations from both tools (filtered by an explicit
`--codex` or `--claude`). `--resume <id>` selects an ID or unique prefix.
An explicit resume never falls back to a new conversation; a missing or
ambiguous ID fails and cancellation opens nothing. An explicitly selected incompatible or
unknown conversation is refused, with a fresh-session route (`mc plan
<programme> --new` for planning); it is not silently replaced by another id.
A named id still selects its own tool; tool/model flags retain their existing
precedence. Compatible continuation has no introductory user message.

Evidence is deliberately bounded, and missing evidence means **unknown**.
Codex identity reads have a separate 1 MiB bound because native tool schemas
can push the first developer message beyond the 64 KiB used for labels:


- **Codex:** the first 1 MiB of the native rollout must contain mc's
  versioned role/programme launch marker in a `response_item` developer
  message or a `turn_context.developer_instructions` field. A marker in user
  text, a cwd or a label is ignored. Conflicting markers are unknown.
- **Claude:** native transcripts do not prove the appended system prompt.
  A fresh role-aware launch supplies a UUID through `--session-id` and records
  it, cwd, role, programme and instruction channel in the existing `work.open`
  log. Selection reads at most the last 4 MiB of the current mc log and its
  single rotated predecessor, once per selection, for a matching instructed
  launch. Missing, incomplete, conflicting or rotated-away evidence is
  unknown. This is not a new conversation registry: discovery and ids still
  come from Claude's store, not the log.

Legacy histories without that evidence start fresh even if their opening
words claim the right role. No history is rewritten or migrated. Bounds can
also conservatively reject a genuine compatible history. SessionStart's cwd
role hint is not historical instruction provenance.

### Instruction channel

Instructions are `all-sessions.md` plus the `plan-session` overlay, assembled
by `instructionsFor`. Role-aware launches use Claude's
`--append-system-prompt` and Codex's `-c developer_instructions=<JSON string>`;
the latter carries the launch marker beside the instructions. They are native
instruction configuration, supplied on fresh launches **and compatible
resumes**, not ordinary resume text purporting to override historical
developer instructions. The older `-c instructions=` path elsewhere is not
accepted as plan provenance. In particular, Claude's system configuration is
reapplied rather than assumed to live in its transcript. The isolated tests
verify discovery and launch composition, not a paid provider turn.

Launches set `MC_ROLE=plan` (the shared identity also accepts `plan-session`)
and `MC_PROGRAMME`, clearing inherited goal/step/headless identity as before.
Decision logs record requested and identified role/programme, evidence source,
conversation id and resume/exclude/fresh/refusal, without copying transcript
or prompt content. Session ownership and headless restrictions are unchanged.

The plan session has full freedom toward the programme's aim: investigate,
write goals, build and land work itself, or take over a goal's branch when
that costs less than a new build session. It is interactive only: Martin is
at the terminal. The runner never starts a plan session (Martin, 2026-11-07);
a goal in `finish` gets a finish session and a blocked goal or a red merge a
mend session, each with its own role ([mc-goals.md](mc-goals.md) § *Finish
and mend*).
See [mc-goals.md](mc-goals.md).

## Writing goals

`goal-verb.md`, included by the role, describes the verbs. The goal carries
the goal, contract, boundaries, documents and criteria with their checks.
Stages move forward; `ready` or `blocked` is a separate status. Phases order
work across the programme: all goals of a lower phase finish or are dropped
before any goal in a higher phase starts. Build sessions neither rewrite the
brief nor invent another unit inside it. How a programme is designed before
its goals — its README (`canon/tasks/references/programme-readme.md`), the
decisions put to Martin in one sitting, the cut into phases, and every
finished goal set in `build` in its phase rather than parked in `draft` — is
`canon/tasks/designing-a-programme.md` (Martin, 2026-11-08).

A plan session writes a review or build follow-up as a goal without asking
Martin when its investigation is complete and its change applies a decided
standard (a `docs/technical/` document or a programme ruling) or repairs a
defect against one (Martin, 2026-11-08). What it still asks him is a new
product or policy choice, an exception to a decided standard, or a reserved
act, through `mc goal martin`, as `canon/tasks/asking-martin.md` says. The
reason: plan sessions put "write this goal now" questions to jev, which could
not settle them (on 2026-11-08, 67 jev calls showed `settled` below 0.70 on 20
such questions).

A goal names a work class (`fast` or `large`), not a pinned provider. The
catalog and observed capacity choose tool, model and effort at launch. Review
has its own catalog list, changed with `mc model add|remove review` or
`mc model set review`.

Review ranks usable subscriptions by provider priority, then headroom; ties avoid the build model, then follow catalog order.

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
programme picker, prompt, role body and the real discovery/launcher composition
for fresh, compatible resume and `--new`, with provider spawn replaced.
It also covers `a new programme gets its README from the programme template`
and `an existing README is left as it is`.
`tests/mc/work-open.test.js` uses isolated Codex rollouts and Claude stores
and launch evidence for descendant review, wrong programme, unknown identity,
explicit refusal, aliases and compatible continuation.
`tests/mc/archive-programme.test.js` covers archive refusals and ordering.
