# docs/project — active plan work in memoro-cli

Plans are not kept here: they live under `~/mc/programs/<programme>/<project>/`, as in memoro (ruling 48),
and each project's `PLAN.json` there is what the runner acts on. Programme documents and rulings stay in `docs/project/`. The
`<project>` name is what `mc run` will call that project's branch and its
workarea; the planning session chooses it and creates neither. The section
below describes the same shape as memoro's `docs/project/README.md`; this
copy is the one kept current with mc (the register, the `workarea` blocker).

There is one programme here, `mc`. mc is built only for memoro me (D-0205);
projects that do not serve that do not belong under it.

## What a PLAN.json is

### Explicit versions

The fixed-step contract below is **mc-plan v1**, still the default. Its `send`
validation, appended final review, register, publish, merge and recovery rules
are unchanged. Empty v1 steps never opt into autonomous execution.

Explicit `mc-plan` **version 2** uses `execution.kind: "autonomous"`, a goal
revision and stable criterion IDs instead of fixed steps. Programme metadata is
descriptive context, not an approval authority. Use ordinary `mc goal` verbs
for guarded assignment operations, not legacy v1 edit verbs or raw PLAN edits.
Mutations check the active role/run and expected state revision under lock.
Goal assignments retain append-only history and completion is at verified
landing, with after-integration evidence measured as follow-ups. Independent
review records findings rather than implementing repairs. The durable planner
event journal remains, but headless queue consumption is unavailable and
programme status reports that pending events await a consumer.

`mc goal new`, `criterion add`, `send` and `revise` author and publish v2 goal
assignments. Sending an unblocked goal makes it ready; exact-revision
dependencies release through the existing scanner after verified landing.
`mc goal show|done` expose state and completion evidence. Programme status lists
v1 projects unchanged beside goals. Invalid v2 and unknown versions are
reported, never reinterpreted as v1/unplanned work or automatically archived;
a goal is archived with its programme only after verified landing and any
required follow-ups. No existing project is migrated. See
[the v2 contract, its v1 boundaries and rollout state](../technical/mc-autonomous-programmes.md),
[programme operations](../technical/mc-programme-operations.md)
and [revisioned storage and ownership](../technical/mc-autonomous-state.md).

### Fixed-step v1

Since `plans-in-mc` a plan lives under `~/mc/programs/<programme>/<project>/PLAN.json`,
with a top-level `repo` field naming the repository its steps run in. A plan of
the same name that was once here is history: ruling 48 took every repository plan
out, and they stay in git history.

Since `project-verbs` a plan is written only through `mc project new`, `edit`,
`criterion add`, `criterion edit`, `step add`, `step edit`, `send` and the
explicit `amend` exception below. Until it is sent it is
`DRAFT.json`, which nothing reads; `send` checks it whole and renames it to
`PLAN.json`. The verbs refuse a concrete step whose `--model` its plan's tool does not
run (`haiku` or `opus` on claude, `gpt-6.1-sol` or `gpt-6-luna` on codex,
`--tool codex`), the words
`Martin`, `by hand`, `manually` or `a person` in a done-when or a check, a
dependency written anywhere but `--after <repo>:<project>`, and an ordinary edit to a
sent plan's goal, contract or out of scope, or to a step that has started.

An authorized planning session can use `mc project amend <project>
--amendment-file <json> --reason "..."` while the first unfinished step stays
blocked on a decision or workarea. It validates the complete amended plan,
audits the authorization and changes only the contract, remaining step
instructions/model/checks and success criteria. Completed steps and the
register are untouched; active sessions and open PRs refuse the write. It
does not release the project: `mc step ready` remains a separate action.
See [the amendment contract](../technical/mc-project-amend.md) for the input
shape, evidence invalidation and failure behavior.

A plan is instructions for a headless session that has read nothing else, with
nobody watching. `mc run` hands it the step it is to do, and it opens a PR and
lands it through `mc merge` itself (ruling 21). That
is the whole test of a plan: can that session do this step, and know when it is
finished?

It is **one file**, `PLAN.json`, in the project directory — an overall part
first, then one entry per step carrying that step's instruction *and* its state.
It used to be prose with frontmatter, and the parts the runner depended on were
conventions nothing checked: a plan could be missing them and still be handed a
ninety-minute session, which then guessed. The shape is a schema now
(`src/mc/plan-schema.js` in memoro-cli), so a plan that cannot be run says so at
the door.

### The overall part

- `goal` — what is true when the project is done.
- `contract` — what may not change without Martin.
- `out_of_scope` — what this project does not do, named. A boundary nobody
  wrote down is one every session redraws.
- `success_criteria` — `{ met, criterion, check }`. The `check` is the half a
  criterion is usually missing: the assertion, the query, the measurement — and
  for anything with a surface, the measurement *in the running app*. "Done" is
  never the session's judgement of its own work. Whether a criterion is met is
  the register's, written by `mc project criterion met <project> <n>`: the
  file's `met` is not read; a criterion is met only when `mc project criterion
  met` has recorded it. A criterion that turns out not to be a step's is removed
  with `mc project criterion drop`, never set met.
- `documents` — `{ label, path }`.
- `runner` — optional: `tool`, `model`, `effort`, `check_in_minutes`,
  `stall_minutes`.
  Only what the runner actually reads; there is no field here that nothing
  enforces. `tool` is `claude`, the default, or `codex`, and it picks the
  provider the step models run on: `haiku` and `opus` on claude, `gpt-6.1-sol`
  and `gpt-6-luna` on codex. `effort` is one of `low`, `medium`, `high`,
  `xhigh`, `max`; it reaches claude as `--effort` and codex as
  `-c model_reasoning_effort=<level>`. What a key leaves unsaid is the
  runner's default for the session's kind — a claude step runs on `opus` at
  `medium`, and a plan session (`mc plan`) on `opus`
  (ruling 18, [`docs/technical/mc-run.md`](../technical/mc-run.md)
  § *The session*). Each step names its own model (below, ruling 42).

### The steps

`steps[]` is an order, and it is written **before** the work — a step session
may not write one, so a step nobody specified is a step nobody can run. Each
carries:

- `title`, and `done_when` — the sentence the runner calls the session's success
  criterion for its own PR. Every step has one, finished ones included.
- `instruction` — an array of paragraphs. Length follows the work: a step
  needing three pages of interface, order and edge cases gets three pages,
  because the under-specified step is the expensive one. Paragraphs rather than
  one string so a diff stays line-oriented for whoever reads the PR.
- `kind` — absent for a step; `review` for the plan's last step, which
  `mc project send` appends and nothing else writes (ruling 58). A review step
  measures every success criterion, closes what falls short, and lands the
  project's one pull request; a plan with one is a branch flow.
- `status` — `ready`, `done`, `blocked`, and `built` (the register's: a step
  before a review, on the project's branch and not yet landed) — with `pr` and `blocked_by`
  (`{ kind: "decision" | "project" | "workarea", name }`, required when
  stopped). `decision` waits on an answer, `project` on another project's plan.
  `workarea` is the runner's own and the only kind it writes: a step `mc run`
  could not start because of a fault in the workarea or on this machine that a
  person has to fix, with the name from its fixed list (`dirty-worktree`,
  `worktree-missing`, `branch-foreign`, `branch-unmovable`, `merge-uncommittable`, `role-missing`,
  `tool-missing`) and the workarea named in the step's last
  comment. It is answered by fixing the workarea and `mc step ready`, not by a
  decision.

  **Since 2026-09-12 these state fields are read from the file once and then
  live in the register** (`~/mc/runner/projects/<project>.json`, `src/mc/register.js`
  in memoro-cli — ruling 21): the plan on `main` says what a step *is*, the
  register where it *stands*, and every reader lays the second over the first.
  The register knows two states the file never carries: `running`, a session
  is on the step, and `failed`, its session ended without landing and `reason`
  says why. A transition is `mc step <status>`, never a pull request. The
  fields stay in the file for now so a plan written today still reads; they go
  from the schema when the last reader of them does.
- `runner` — `model` and `effort`. An ordinary step names a work class,
  `fast` or `large` (ruling 59). At launch mc picks a candidate for the class
  from the catalog (`mc model list`; changed with `mc model add|remove fast|large`
  and `mc model set review`) and from the subscription capacity it has seen, on
  included subscriptions only. The candidate's tool, model and effort are the
  session's, and a catalog edit never rewrites a plan. A step written now names a
  class and nothing else: the verbs refuse a concrete model, so no step waits on
  one model's spent usage while another candidate is free. A plan sent before
  that may still carry one — `haiku` and `opus` on claude; on a codex plan
  (`tool: codex`) `gpt-6.1-sol` and `gpt-6-luna` on codex — and runs on it as
  written (ruling 42, ruling 59, `canon/roles/_plan-writing.md`).
  The routing is in [`docs/technical/mc-run.md`](../technical/mc-run.md)
  § *Work classes and capacity*. Each key overrides the plan's `runner` on its own.
  `tool`, `check_in_minutes` and `stall_minutes` are the plan's alone and
  refused here by name.
  It is the plan author's, like `instruction`: a step session that changes its
  own step's `runner` fails on the way back in.
- `comments` — an array of paragraphs, possibly empty: whatever that step's
  session needs the next reader to know that the code in front of them does not
  show. This is where a session writes, and it is on the step rather than at the
  top of the plan on purpose. It was `what_the_code_taught_us`, a shared list of
  `{ title, body }` objects; on 2026-09-02 three sessions wrote the wrong shape
  into it, and because the shape is validated, one bad paragraph made the whole
  plan unreadable — `new-user`'s stayed unreadable on `origin/main` for a day,
  and the runner logged a skip line for it every round that nobody read
  (Martin, 2026-09-02: "Flytta in i steget: `steps[i].learned`", and the same
  evening: "den ska bli bara en 'comments' … det behövs någonstans att skriva
  kommentarer"). The name is plain on purpose: a field whose name is a doctrine
  is either left empty or filled with what it is not.

**A step is work the runner can take from start to finish**, and nothing else.
Investigation, measurement, design exploration, a test run to see what happens,
"find out whether" — none of that is a step. It is the planning session's, with
Martin at the terminal, and it is done *before* the plan is written, so that
every step stands on an answer the plan already carries. A step whose
instruction depends on what an earlier step will find is not a step either: if
the plan cannot say what step 3 does until step 2 has run, step 3 is not known
yet, and the plan ends at step 2 (ruling 19, Martin, 2026-09-12: *"Det som
läggs i ett projekts STEP ska vara en färdig körbar plan som runner kan ta från
a till ö. Om inte, så hör det inte hemma där."*). The test of every step is the
one at the top of this file: can a headless session that has read nothing else
do it, and know when it is finished? A step that has to stop and ask costs a
session, a failed step, and a person reading a transcript to find out why.

The plan has **no status of its own**: it is the state of the first step that is
not done. A plan whose steps are all done is done when every success criterion
is `met: true`, and `unmet` otherwise — the page and `mc status` name the
criteria by number (Martin, 2026-10-18: success criteria and done belong
together). The runner archives only a done plan. The runner looks at that
first unfinished step and no other — steps are an order, and skipping a stopped
one to reach a later `ready` step is how a plan gets half-built in an order
nobody chose.

In full, small:

```json
{
  "schema": "mc-plan",
  "version": 1,
  "goal": ["Project detail answers where a project stands."],
  "contract": ["Läget replaces project-timeline rather than joining it."],
  "out_of_scope": ["Trip detail, and every other entity detail surface."],
  "success_criteria": [
    { "met": false, "criterion": "The hero draws a visual object.",
      "check": "Seen on a project page in the running app, light and dark." }
  ],
  "documents": [{ "label": "Superseded", "path": "../../../plans/project-briefing-redesign.md" }],
  "steps": [
    { "title": "The purpose line", "status": "done",
      "done_when": "The description is edited in the hero.",
      "instruction": [], "comments": ["The hero hydrates twice: once on mount, once on theme."],
      "pr": 11085, "blocked_by": null },
    { "title": "The hero object", "status": "ready",
      "done_when": "A project page draws the object in light and in dark.",
      "instruction": ["Generate the light and dark siblings, register the token, wire the hero.",
                      "No entity hero draws one today: the render path swaps the icon ref, the entity path hydrates by writing it."],
      "pr": null, "blocked_by": null }
  ]
}
```

### What earns space

What the next session cannot see from the code in front of it: the trap, the
missing mechanism, the cost that is not in the diff, the order that matters.
Link rather than copy. What does not earn space is the case for the plan —
nobody reads a plan to be convinced of it; they read it to do the work.

Every claim in a plan is acted on without being checked, so name the file that
carries it, and only if you opened that file. A plausible-sounding claim from a
grep costs more than saying nothing, because it becomes the next session's
premise.

### Who writes what

A plan is written by a planning session: `mc plan <programme>`, Martin at the
terminal. It opens on a **programme**, not on one project — how many projects
come out of it, under what names is worked
out in the session, not decided by the command that opens it.

**The brief writes plans too**, under exactly these rules, for the proposals
Martin decides there (`canon/roles/brief.md`). A decision taken at the brief
already carries the reading the plan needs, and opening a planning session to
retype it is a second session's worth of cost for nothing. What stays the
planning session's is thinking a programme through, and reading a plan a step
has asked for a review of — `plan-review` is not the brief's.

**A proposal that becomes a project is archived when the project is created**
(ruling 22: moved to `~/mc/proposals/archive/`, which nothing lists).
Most projects start as a file in `~/mc/proposals/` — the helper's reading of a
digest, or a session's of the code — decided with Martin at the brief. The
session that writes the `PLAN.json` archives the proposals it consumed, in the
same move, and names them in the pull request: they are not in this repository,
so the PR body is the only place that record can live. Whatever a proposal held
that the plan needs — the measurement, the file and line, the reason the fix is
that one — has to be **in the plan first**, because no session reads
the archive. `~/mc/proposals/` holds what nobody has decided yet and only that; a file
left there after its project exists is a decision that gets taken twice.

**That session has no workarea and makes none.** It lives at
`~/mc/plan/<programme>/`, with a checkout of each repository on branch
`plan/<programme>` — mc's own directory, which `mc run` cannot see. What a
planning session and the runner share is a `PLAN.json` under `~/mc/programs/`, and nothing
else; the `<project>` directory name is what the runner will call that
project's branch and its workarea when it first steps it.

A step session edits its own step's `status`, `pr` and `comments`, and `met` on
the criteria it actually met — the criterion and its check are Martin's words.
It **never writes the plan's steps** — not a new one, not a rewrite of one that
has not run, not a deletion — and never `goal`, `contract`, `out_of_scope`, or
the criteria themselves. This is checked rather than asked: the runner compares
the file before and after, and a session that touched anything else fails on the
way back in. Everything a session may write is inside `steps[index]` and `met`,
and inside its own step only `status`, `pr`, `comments` and `blocked_by` — its
`instruction`, `done_when` and `runner` are compared like every other step's,
so a session cannot soften what it was asked to do or pick the model it runs on.

**The runner writes nothing into a plan.** When `mc run` meets a fault in the
workarea or on this machine that a person has to fix — a dirty worktree, a
branch it cannot move, a merge that will not commit, a missing role or tool —
it sets the first step that is not done to `blocked` with `blocked_by: { kind:
"workarea", name }` **in the register**, with one comment naming the workarea.
Until 2026-09-12 that was a docs-only pull request the runner opened and landed
itself, because the state lived in the plan on main. It never writes `ready`
and never retries: `mc step ready <project> <n>` once the workarea is fixed
([`docs/technical/mc-run.md`](../technical/mc-run.md) § *Blocked by the runner*).

When the code says a coming step is wrong, that is not a revision the step
makes: the step goes `blocked` with `blocked_by` saying what the answer has to
be about, the question goes in the pull request with one recommendation, and
the session stops. A plan comes back to the runner by its first unfinished step
being `ready`, and by nothing else.

**`closeout/` under a programme is the archive's, for projects archived from a repository before ruling 48.** It holds one JSON file per
archived project, `docs/project/<programme>/closeout/<project>.json`, written by
the runner in the same pull request that removes the plan: the goal, the steps
with the pull request, sha and date each landed with, and time, tokens and cost
per session. `closeout` is never a project name, nobody edits the files, and
nothing reads them but people
([`docs/technical/mc-tidy.md`](../technical/mc-tidy.md) § *The closeout*). When the
project had a README, it stays beside the record as `<project>.md`, and the links
into the removed directory are rewritten to these in the same pull request
(ruling 46).

**A project under `~/mc/programs/` is not written into `closeout/`.** Its closeout is `CLOSEOUT.json` beside its `PLAN.json` in mc, and its repository gets only its `project_log.md` row ([`docs/technical/mc-tidy.md`](../technical/mc-tidy.md) § *What archiving does*).

## Citing a decision

Decisions are raised as files under a `decisions/` directory at the root of the
session that raised them: `~/mc/<workarea>/decisions/` for a step session,
`~/mc/plan/<programme>/decisions/` for a planning one. Neither directory is
part of this repository and neither survives its session, so a document here
cites a decision **by name, never by path** — `` [`mc-1`](mc/rulings.md) ``,
not `` `~/mc/mc-utredning/decisions/mc-1.md` ``. A path out of the repository
is a citation no reader with a checkout can follow.

When a question is answered, carry the ruling into [`mc/rulings.md`](mc/rulings.md):
the question, the options, Martin's answer quoted verbatim, and the plan that
builds it. mc keeps no record of an answer — there is no decision file and no
answer line — so the plan and the ruling are the only two places it survives.
Carry it at the moment it is given.

The same rule covers any other working material a plan leans on. The programme's
design source, [`mc/utredning-2026-08-24.md`](mc/utredning-2026-08-24.md), was
cited by section number from four plans while living only in a workarea; that is
why it is in the repository.

This mirrors memoro's `docs/project/README.md` § *Citing a decision*.

Close-out: add a row to `project_log.md` and update the technical
documentation to describe what now exists. Removing the directory is not
yours to do — a plan that says `status: done` is archived by `mc run`'s chore
loop the next time it reads it: the directory goes, and the row is written for
it if the close-out step did not write one (`src/mc/archive-plan.js`). A plan under `~/mc/programs/` is archived 24 hours after it is done, or at once by `mc project archive`, and its directory stays: its `CLOSEOUT.json` is the mark (`src/mc/project-archive.js`).

Nor is removing the workarea. At the end of the chore pass that archived the
plan, `mc run` closes every workarea whose plan said `done`, whose worktree
has no uncommitted change and whose last row in `runs.tsv` ends `merged`:
the worktree is handed back, the local branch deleted, and whatever the
folder kept beside its checkout moved to `~/mc/runner/log/closed/<name>/`
(`src/mc/close-workarea.js`). A workarea with no plan is never
removed by a machine — it is listed in `~/mc/runner/unplanned-workareas.md`
and on the page, for Martin.

None of that reaches a planning session. `~/mc/plan/<programme>/` holds no
top-level checkout, so neither `mc run`'s `workareas()` nor `mc status`'s
`areasWithCheckout()` can see what is under it: no machine archives or closes
a planning session, and none lists it as a workarea without a plan.

**A programme is archived by hand, with `mc plan <programme> --archive`.**
Nothing can tell that a programme is over — one whose projects are all done is
also where the next piece of that work belongs — so this is typed, never
triggered. It refuses, touching nothing, while any plan under the programme is
still under `~/mc/programs/`, or while releasing `~/mc/plan/<programme>/`
would keep something (uncommitted work, commits main lacks, a shell standing
in it, a file somebody put there). Otherwise, in every repository whose
`docs/project/` holds the programme, it removes `docs/project/<programme>/` and
adds one `project_log.md` row for the programme itself (project `-`, outcome
`closed`) in a docs-only PR landed through `mc merge --docs`; only once that
has merged is the planning session released — worktrees handed back,
`plan/<programme>` deleted, its conversations and directory gone
(`src/mc/archive-programme.js`).
