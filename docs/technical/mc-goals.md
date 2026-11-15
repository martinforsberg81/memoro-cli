# mc goals

**Status:** current · 2026-11-07 · derived from `src/mc/goals.js`,
`src/mc/criteria.js`, `src/mc/goal-convert.js`, `src/mc/project-convert.js`, `src/mc/commands/goal.js` (`refusedMove`,
`queueGoal`), `src/mc/run.js` (`goalPass`, `runGoal`, `goalWork`,
`reviewRoute`, `afterReview`, `afterMend`, `goalWithoutWord`, `convertAfter`),
`src/mc/goal-archive.js`, `src/mc/merger.js` (`landJob`, `tellGoal`),
`src/mc/review-verdict.js` (`checkVerdict`, `trippedAreas`),
`src/mc/hooks.js` (`reviewStopDecision`), `canon/roles/build-session.md`
(its `goal` part), `canon/roles/review-session.md` (its `goal` part),
`canon/roles/mend-session.md`,
`canon/roles/plan-session.md` and `canon/verbs/goal.md`

A goal is mc's one unit of work, two files and a worktree: `GOAL.json`, the brief as
data, and `LOG.md`. It has no steps, no register and no owner. A build session
does the work, records each criterion it has checked as met, and publishes its
pull request; a review session on another model runs the checks and decides;
OK queues it for the merger, not OK sends it back to build, where a repair
build session fixes what review found and sends it to review again; the goal is `done` when it lands, and it
lands only with every criterion met. Only a merge failure (conflict, failed candidate check or moved judged head) starts mend. Legacy blocked work outside merge is reconciled to Martin without a diagnostic session (Martin, 2026-11-08). Interactive plan remains `mc plan`; the runner may also complete one next draft under *Next draft planning*.

A goal has two fields where it had one status (Martin, 2026-11-03: *"Status
måste innehålla även processen så att den inte går tillbaka."* *"Det kan
aldrig gå bakåt i ordningen."*): its **stage**, where in the process it is,
which only moves forward, and its **status**, whether that stage can run now.
A goal passes each stage once but for one move: a review that finds it not OK
moves it from review back to build. That return is bounded: the third
rejection stays in review for Martin (*What a review session does*). The
sessions a goal can start are bounded: planning, builds while they make
progress, reviews, then merge.
Mend is reserved for merge failures; pre-merge acceptance obstacles stay with build/review, while legacy blocked records are reconciled to Martin without launching.

```
stage:  draft → build → review → merge → done     (and dropped, from any)
        `finish` is a name kept for records written before 2026-11-15; no goal moves into it
status: ready | blocked | Martin

draft    ── the plan session completes its brief ────────────▶ build
build    ── build session: done with the task ────────────────▶ review
build    ── legacy blocked state ──────────────────────────────▶ build · Martin
build    ── three sessions without a word (runner) ───────────▶ build · Martin
build    ── three sessions without progress (runner) ──────────▶ build · Martin
build    ── mc goal defect (build session) ───────────────────▶ build · Martin
review   ── mc goal defect (review session) ──────────────────▶ review · Martin
review   ── review: OK, mc goal stage merge (queues its head) ▶ merge
review   ── review: a NOT OK line, mc goal stage build ───────▶ build (a repair build)
review   ── the third rejection (mc goal stage build) ─────────▶ review · Martin
review   ── no open pull request (runner, first time) ─────────▶ build
review   ── no open pull request (runner, second time) ────────▶ review · Martin
finish   ── an old record, in finish · ready (runner) ─────────▶ build
review   ── the review died (runner) ─────────────────────────▶ review · ready, reviewed again
review   ── a second review died (runner) ────────────────────▶ review · Martin
merge    ── merger landed ────────────────────────────────────▶ done
merge    ── first/second failed merge ────────────────────────▶ merge · blocked
merge    ── mend repairs, gates and returns ready ────────────▶ merge · ready
merge    ── every pull request closed, ready (runner) ────────▶ merge · Martin
merge    ── third failed merge ──────────────────────────────▶ merge · Martin
any pre-merge blocked ── legacy migration, no session ─────────▶ the same stage · Martin
any      ── Martin waits for the desk; ready keeps the stage
any      ── person, interactive Martin or decision may move backward ───▶ an earlier stage
```

## Layout

### Integrating main into a goal

A goal keeps one branch, one worktree per repository and its existing pull
request through delivery. Main advancing is not, by itself, a reason to
synchronize it. Integration is ordinary delivery work when it resolves a
concrete publication or merger conflict, brings in a named already-landed
prerequisite, or resolves a demonstrated acceptance obstacle caused by an
upstream change. A textual merge conflict is not required for a dependency
or acceptance integration.

The owning build or mend session, or the interactive session taking
over the goal, establishes the need from code, gate evidence and landed
commits. Before merging, record the obstacle, prerequisite commits and fixed
main revision in LOG.md. Merge that revision into the existing worktree,
preserving history and both intents; do not rebase, force-push or create
another checkout. Reconcile generated artefacts against the intended contract,
not by accepting every newly measured value. A review session does not edit
or integrate; it sends necessary repair back to build.

Integration does not expand the goal's authored scope or protection commission.
Consume shared repairs from their owning delivery; do not repair shared
components in passing. Measure authored scope against the recorded merge base
of the judged HEAD and frozen acceptance base, so integrated upstream work
is not attributed to the goal. An incorrect shared base-relative check still
belongs to its owner; integration does not certify that check as repaired.

After integration, run the affected criterion checks and complete final-tree
whole-selection acceptance under the publication procedure before publication
and the normal review handoff. Record the judged head, frozen base, logs and ran/reused provenance.
The merger measures the combined candidate and reuses the session’s evidence;
the session’s acceptance remains required because it is what the merger reuses.
This procedure authorizes no test waiver, budget change, product-scope change,
admin override or deployment. Only a remaining product/policy choice or reserved
act goes to Martin; the need for ordinary integration alone does not.

```
~/mc/programs/<programme>/goals/<goal>/GOAL.json  the brief, its criteria, its stage and status
~/mc/programs/<programme>/goals/<goal>/REVIEW.md  the latest review's verdict, in the fixed form; REVIEW-<round>.md is each round's copy
~/mc/programs/<programme>/goals/<goal>/LOG.md     one entry per session, newest last
~/mc/programs/<programme>/goals/<goal>/<repo>/    a worktree on goal/<goal>, from origin/main
~/mc/programs/<programme>/goals/.archive/<goal>/  an archived goal (mc goal archive; dropped immediately when safe, done after 24 h), its worktrees gone
~/mc/programs/<programme>/goals/goal_log.md       one row per archived goal
```

One worktree per repository the goal names, made at the goal's first use: the
runner makes it before the first session on the goal (build, review
or mend), and `mc goal new` makes none. `mc tidy` releases a checkout no
session can use; its branch stays, and the next use re-adds it on that branch.
Anyone may work in one: a person, the interactive plan session, or the
runner's sessions on the goal. `<programme>` must be a directory under
`~/mc/programs/`; `<programme>` and `<goal>` are lower-case letters, digits and
hyphens. mc keeps nothing else for a goal.

## GOAL.json

One JSON object, written only by the `mc goal` verbs (*The verbs*) and checked
by `validateGoal` (`goals.js`) at every write: an invalid GOAL.json is never
written, and a write that would make one is refused with the field named.

```json
{
  "schema": "mc-goal",
  "version": 1,
  "stage": "build",
  "status": "ready",
  "phase": 2,
  "repos": ["memoro-cli", "memoro"],
  "class": "fast",
  "created": "2026-11-01T20:00:00Z",
  "prs": ["memoro#14761", "memoro-cli#1238"],
  "title": "Title",
  "goal": ["A paragraph.", "Another."],
  "contract": ["What may not change without Martin."],
  "out_of_scope": ["What this goal does not do."],
  "success_criteria": [{ "criterion": "What must be true", "check": "How it is checked", "met": false }],
  "documents": [{ "label": "What the reader is sent to", "path": "docs/technical/mc-goals.md" }]
}
```

- `stage` — `draft`, `build`, `review`, `merge`, `done` or
  `dropped` (`finish` is still read, as the name of a stage old records were in, and no move goes into it) (*Stages*). A goal always starts in `draft`: `mc goal new
  --stage build` is refused (*Plan review*). `draft` was written `plan` until 2026-11-07 (Martin: the
  stage names the goal's state; plan is the session that writes drafts): a
  GOAL.json or a LOG.md heading saying `plan` reads as `draft` (`readStage`),
  `mc goal convert` and the runner's `convertAfter` rewrite the GOAL.json once
  with an entry `stage draft, from plan (the stage was renamed 2026-11-07)`,
  and LOG.md history stays as written. `merging` reads as `merge` the same way.
- `status` — `ready`, `blocked` (legacy pre-merge values are reconciled directly to Martin; merge failures alone wake mend), or `Martin` (waiting for Martin). An unknown stage or status is refused with
  its field named. A GOAL.json from before stages has one `status` (`open`,
  `review`, `blocked`, …) and no `stage`; it does not parse, and says `mc
  goal convert` gives it one (*Converting a status into a stage*).
- `phase` — a whole number from 1 (*Phases*). A GOAL.json without one is in
  phase 1; `renderGoal` always writes it.
- `repos` — repository names in order. The first is where a session starts,
  and the lane that serves it takes the goal.
- `class` — `fast`, `medium` or `large`, routed through the model catalog (ruling 59) for the goal's build sessions only; review, mend and next-draft plan run on their own catalog lists, whatever the class (`docs/technical/mc-run.md`, *Work classes and capacity*).
- `created` — an ISO instant written by `mc goal new`, or null.
- `prs` — the pull requests that carry the goal's work, as `<repo>#<n>`.
  `mc publish` writes the one it opens or updates (*Done when its work has
  landed*), and `mc goal pr` names others.
- `goal`, `contract`, `out_of_scope` — arrays of paragraphs.
- `success_criteria` — `[{ criterion, check, met }]` (`validateCriteria` in
  `src/mc/criteria.js`): every criterion a `check`, `met` true or false, no other key, and at
  least one criterion. `mc goal new`'s skeleton has none yet, and parses as a
  draft: the runner starts no session on a goal in `build` with no criterion,
  and it cannot go to review.
- `documents` — `[{ label, path }]` (`validateDocuments`).

**Version 2.** A GOAL.json of `"version": 2` is what `mc goal new` writes;
version 1 is what `mc goal new --structure 1` and the converters write, and what
a file without a `version` is. Nothing that exists changes version, and version 1
is read, written and shown exactly as above. Version 2 has the same header
(`stage` to `prs`, `title`) and `success_criteria` and `documents`, and replaces
`goal` and `contract` with numbered parts, in the order `renderGoal` writes them:

```json
{
  "schema": "mc-goal", "version": 2, "stage": "build", "status": "ready", "phase": 1,
  "repos": ["memoro-cli"], "class": "large", "created": "2026-11-14T10:00:00Z", "prs": [], "title": "Title",
  "aim": ["Why the goal exists."],
  "outcome": ["What is true when it lands."],
  "problem": [{ "id": "B1", "text": "What is wrong.", "basis": "measured" }],
  "premises": [{ "id": "P1", "claim": "…", "source": "…", "basis": "read", "at": "4daf75f3" }],
  "decisions": [{ "id": "D1", "text": "…", "by": "Martin", "on": "2026-11-14" }],
  "change": [{ "id": "C1", "where": "src/mc/goals.js", "what": "…" }],
  "latitude": ["What the build chooses."],
  "preserve": [{ "id": "V1", "text": "…", "upheld_by": "criterion 1" }],
  "obligations": [{ "area": "memoro-cli/documentation", "stand": "touched", "text": "…", "standard": "memoro-cli/docs/technical/mc-goals.md#GOAL.json" }],
  "risks": [{ "id": "R1", "text": "…", "settled_by": "criterion 1" }],
  "success_criteria": [{ "criterion": "…", "check": "…", "evidence": "…", "met": false }],
  "protection": ["The test protection the goal commissions."],
  "out_of_scope": [{ "id": "X1", "text": "…", "owner": "…" }],
  "documents": [{ "label": "…", "path": "…" }],
  "ids": { "B": 1, "P": 1, "D": 1, "C": 1, "V": 1, "R": 1, "X": 1 }
}
```

- `aim`, `outcome`, `latitude`, `protection` — arrays of paragraphs, possibly
  empty. `mc goal new` writes them empty.
- `problem` (B), `premises` (P), `decisions` (D), `change` (C), `preserve` (V),
  `risks` (R), `out_of_scope` (X) — items. Each has an `id` (its part's letter
  and a number, shown `B1`, `C2`), a text (`claim` for a premise, `what` for a
  change) and the fields its part names (`goal-parts.js`, `ITEM_PARTS`); no
  other key. Every item part may be empty; validation requires no part to have
  content. `mc goal show` prints OUTCOME, CHANGE, OBLIGATIONS and CRITERIA as
  `none yet` when they are empty and leaves any other empty part out.
- `obligations` — one entry per rule area (`area`, `stand` `touched` or
  `untouched`, `text`, and an optional `standard`
  `<repo>/<path>#<section>`, on either stand). A second write for an area replaces the first.
  An area is written `<repo>/<id>` where the repository declares rule areas
  (*Rule areas*); validation of the file takes any non-blank word, and only
  `mc goal obligation set` checks it against the declarations.
- `success_criteria` — as in version 1, with an optional `evidence` (what the
  build logs for the criterion).
- `ids` — for each part letter, the highest number ever given. A new item takes
  `ids[letter] + 1` and removing an item never lowers it, so an id that was
  given is never given again, and a reader citing `D2` cites the same thing
  after any later edit.

`renderGoal` writes every part of either version; a write by any verb
(`addPr`, `setGoalState`, `updateGoal`, `phaseGoals`) keeps the parts it was
not asked to change. `mc goal convert` writes a version 2 goal in the legacy
stage `plan` as `draft` with every part. An old `mc` reads a version 2 file as
a problem (`version`) and starts nothing on it — it fails closed — so the
installed mc is updated before a version 2 goal is made.

An unknown key, a wrong schema or version, or a bad field is a problem named
by its field; an `after` (from before phases) is named with `mc goal convert`,
which gives the goal its phase (*Phases*). A GOAL.json that does not parse is listed by `mc goal list` with
its problems, and the runner never starts it.

**Seen, not only stored.** `mc goal show` renders a goal as text
(`renderGoalText`): the title, then GOAL, CONTRACT, OUT OF SCOPE and DOCUMENTS,
then `CRITERIA <met>/<all>` with each criterion numbered, ✓ or ✗, and its
check. A version 2 goal is shown in its part order — AIM, OUTCOME, PROBLEM,
PREMISES, DECISIONS, CHANGE, LATITUDE, PRESERVE, OBLIGATIONS, RISKS,
CRITERIA, PROTECTION, OUT OF SCOPE, DOCUMENTS — each item with its id; OUTCOME,
CHANGE, OBLIGATIONS and CRITERIA say `none yet` when empty and any other empty
part is left out. An item's fields are shown with the spelling of the flags that
write them (`upheld-by`, `settled-by`), as the log entries of `item set` and
`item remove` give them, not as the JSON keys (`upheld_by`, `settled_by`). That text is the brief the runner gives a goal's build, review and plan
session, after the lines that say where the goal is (`goalPrompt`,
`goalReviewPrompt`, `goalPlanPrompt` in `run-plan.js`). `mc goal list` and the
goal rows on the page say `criteria <met>/<all>`; the page's is green when all
are met.

## LOG.md

Each session adds one entry, newest last:

```
## 2026-11-01T21:30Z · claude claude-haiku-5-5 · build · ready

Done: what the session did
Comment: what a reader should know
Next: what the next session should do
```

- The heading is `## <at> · <tool> [<model>] · <stage> · <status>[ · by <role>]`: `<at>` is UTC to the
  minute; `<tool>` is `MC_TOOL`, `person` or `runner`; `<model>` is `MC_MODEL`
  when set; `<stage> · <status>` is where the goal is after the entry. An entry
  written before stages has `· <status>` alone, and is read with no stage.
  `· by <role>` names the writer from `MC_ROLE` alone: `build`, `review`,
  `plan`, `manager`, else the role's name before its `:`. `MC_TOOL=person` or an
  unset `MC_TOOL` does not suppress it; no role, or a word containing whitespace,
  writes none. This attribution does not change stage/person authorization.
  It is not the stage: a build
  session that moves a goal to `review` writes `· review · ready · by build`.
- The labels are `Done:`, `Comment:` and `Next:`, in English like the rest of
  the goal. A log written before 2026-11-03 has `Gjort:`, `Kommentar:` and
  `Nästa:`; the parser reads those as the same fields, so no log is rewritten.
  A label's text runs on until the next label or heading, so a field may take
  several paragraphs.
- A heading that does not match the form is skipped with its lines.
- `mc goal new` writes the first entry: `draft · ready` (or `build · ready`), `Done: created`.
- A session count is every entry whose tool is neither `runner` nor `person`.
- The **last build entry** is the last entry a session wrote in `build`, or
  the one that moved the goal to `review` (`lastBuildEntry`); a review's own
  entry names `merge` or `build`. Its `<tool> <model>` is the model a
  review may not run on.
- A review's entry is one line, naming the stage and the files it wrote.
  The merger writes `Done: landed #<pr> as <sha>`, or `Done: merger answered
  red on #<pr>` (`moved` for a head past the judged one, `redMergeText`).

## Rule areas

A repository declares its rule areas in `.mc/areas.json` on `main`, so that an
obligation names an area both sides know. The declaration is read from the
repository's `origin/main` (or the revision `--at` names), as `.mc/ios.json` is,
because a goal is written before its worktree exists and the areas that bind a
goal are main's.

```json
{
  "schema_version": 1,
  "areas": [
    {
      "id": "documentation",
      "name": "Documentation",
      "covers": "What a change must say in the repository's own words.",
      "standards": ["docs/technical/mc-goals.md"],
      "paths": ["docs/", "canon/"],
      "questions": [{ "when": "a behaviour changes", "ask": "Does docs/technical say what runs?" }]
    }
  ]
}
```

- The file is `schema_version` 1 and a non-empty `areas`; no other key.
- An area has exactly `id` (lower-case letters, digits and hyphens, starting
  with a letter, unique in the file), `name`, `covers`, `standards` (a non-empty
  array of repository paths), `paths` (an array, possibly empty) and
  `questions` (a non-empty array of `{ "when", "ask" }`). A blank text, a
  missing field or an unknown key makes the file invalid.
- An obligation's `area` is `<repo>/<id>`, `<repo>` being the repository that
  declares it (`memoro-cli/documentation`).
- A repository without the file declares no areas and behaves as it did.
  The file is absent when git says the path is not in the revision; any other
  git failure — a revision that does not exist, an unreadable repository — is
  an error, never "declares none".
- Nothing requires a stand for an area, and no brief or goal text carries the
  declarations: `mc goal show` does not render them.
- `mc goal areas` may be run by plan, a person, the learning role and the
  `desk-prepare` role (which only reads: its other goal verbs are refused), and
  by a build, review or mend session.

**`mc goal areas`** prints each declared area as a block — `<repo>/<id>`, its
name, what it covers, standards (`(missing)` after one that is not in the
revision), paths and questions. For a repository that declares none it prints
one line saying so (exit 0); an unknown repository name exits 2. For a goal it
prints the blocks of every goal repository that declares areas, each with the
goal's stand for it (`stand: touched — <text> [<standard>]`, or `no stand`),
then the obligations whose area no repository declares, and ends
`<n> of <m> areas have a stand`. A version 1 goal exits 2; a goal that cannot be
read, a repository that is not known and a declaration that cannot be read or
is invalid exit 1.

**`mc goal obligation set`** takes, for a goal whose repositories declare any
area, only a declared `<repo>/<id>`: any other word is refused (exit 2, nothing
written) with the declared areas listed. A goal none of whose repositories
declares areas takes any word, and `<repo>/…` is accepted for a goal repository
that declares none. A declaration that cannot be read or is invalid makes the
write fail (exit 1); the declaration is read once per write. When the goal's
repositories declare any area, a refusal lists each repository's areas, and
names one that declares none as `<repo>: declares none, any <repo>/… is taken`.
After a `set` the verb ends with `no stand yet: <areas>` for the declared areas
that have no obligation, or `every declared area has a stand` when none lacks
one; for a goal whose repositories declare no area it prints neither.

## The verbs

Twenty-one verbs: `stage` moves the stage; `blocked`, `ready`, `done` and
`drop` set one field each.

- **`defect [<p>/<g>] --part "…" --found "…" [--evidence "…"|--evidence-file <f>] [--next "…"|--next-file <f>]`** —
  the goal's own text is wrong (a criterion that cannot hold, a check that
  does not test it, a check a headless session cannot run because it passes
  through a reserved act or needs someone at a terminal, a premise the code
  contradicts). Appends one entry with
  status `Martin` and the comment `goal defect: <part> — <found>`, plus an
  `Evidence:` line when given (redacted like any log text); the stage does not
  change. It asks nobody (no jev, no ledger) and offers no options: there is no
  choice, the text is wrong. A build or review session may report it
  only for its own goal and only in its own stage; a person and the plan role
  may name any unfinished goal. A finished goal (`done`, `dropped`) is refused
  (exit 1); a mend session, and a build or review session on a goal in
  another stage, are refused (exit 2); a call without `--part` or `--found`,
  or with a blank one, exits 2, says how to call it again and writes nothing.
  The session ends with it: `goalSession` returns null for a `Martin` goal, so
  the runner starts nothing on it, and the desk opens one item whose label is
  the entry's first line (`deskItemQuestion` takes the `Martin` entry of
  its minute, so another entry in the same minute does not hide it).

- **`areas <repo> | <p>/<g> [--at <rev>]`** — shows rule areas (*Rule areas*).
  Given a repository mc knows it prints that repository's declaration at `<rev>`
  (`origin/main` by default); given a goal, the declarations of the goal's
  repositories and, for each area, the goal's obligation for it. `MC_GOAL`
  stands in for the argument. Plan, a person and the learning role may run it;
  so may a build, review or mend session, which only reads.

- **`new <p>/<g> --repo <r>[,<r>] --class fast|medium|large --title "…" [--phase <n>] [--stage draft] [--structure 1|2]`** — makes a
  goal, refused unless its flags are valid and its names are new. It writes
  version 2 (numbered parts) unless given `--structure 1`, which writes version 1
  (goal and contract prose); it prints one hint for the version it wrote. It is in
  stage `draft` (awaiting planning; see *Next draft planning*; `--stage build`
  exits 2 and creates nothing: write the goal in draft and move it with
  `mc goal stage` after its reading), and in phase `<n>`, 1 by default; a phase more than one past the programme's
  highest is refused (`phase 4 would leave a hole — mc's phases run to 2, so 3
  is the highest a goal may take`). Each
  repository is fetched first; then GOAL.json — a skeleton with the title and
  no criterion — LOG.md, and a worktree of each on
  `goal/<g>` from `origin/main` (or that branch as it stands, when it exists).
  **One branch, built to the end**: the goal stays on this branch. Main
  advancing alone requires no synchronization; necessary dependency,
  acceptance or conflict integration follows *Integrating main into a goal*.
- **`set <p>/<g> title|goal|contract|out-of-scope --text "…"`** — replaces that
  field. A prose field takes a paragraph per block between blank lines, and an
  empty text clears it; an empty title is refused. Build, review and
  mend sessions cannot rewrite the brief; plan, interactive Martin, decision and a person
  may.
- **`set <p>/<g> title|aim|outcome|latitude|protection --text "…"`** — the
  same for a version 2 goal. `goal`, `contract` and `out-of-scope` belong to
  version 1; each verb of a version only takes its own goals and refuses the
  other's (exit 2, nothing written).
- **`item add <p>/<g> problem|premise|decision|change|preserve|risk|out-of-scope --text "…" <flags>`** —
  appends an item to that part of a version 2 goal and prints its id. The part
  takes its own flags: problem `--basis measured|reported|inferred`; premise
  `--source`, `--basis read|measured|inferred`, `--at`; decision `--by`, `--on`;
  change `--where`; preserve `--upheld-by`; risk `--settled-by`; out-of-scope
  `--owner`. `--text` is a premise's claim and a change's what.
- **`item set <p>/<g> <id> [--text "…"] [<flags>]`** — changes what is given and
  keeps the rest, logging the item as it was and as it is. **`item remove
  <p>/<g> <id> --reason "…"`** takes it out, logging it and the reason; its id
  is not given again (`ids`).
- **`obligation set <p>/<g> <area> --stand touched|untouched --text "…" [--standard "<repo>/<path>#<section>"]`**
  and **`obligation remove <p>/<g> <area> --reason "…"`** — write or take out
  the goal's obligation for one rule area, logged. `set` checks the area
  against the goal's repositories' declarations (*Rule areas*); `remove` takes
  any area the goal holds. After a `set` it names the declared areas that still
  have no obligation.
  The item and obligation verbs write the brief like `set`: a build, review
  or mend session is refused (exit 2, nothing written), and so is the
  learning role on a goal it did not create; it may use them on a goal it
  created in its session, as it may `set` and `criterion add`. Plan,
  interactive Martin, decision and a person may. A version 1 goal is refused
  them.
- **`document add <p>/<g> --label "…" --path "…"`** — appends a document;
  build, review and mend sessions cannot change the brief.
- **`criterion add <p>/<g> --criterion "…" --check "…" [--evidence "…"]`** — appends a criterion,
  not met. `--criterion` and `--check` are required: a criterion without a check is refused. `--evidence` is a version 2 goal's.
  Build, review and mend sessions cannot add acceptance criteria;
  plan, interactive Martin, decision and a person may.
- **`criterion met [<p>/<g>] <n> [--evidence "…" | --evidence-file <path|->]`** — records criterion `<n>` (1-based)
  as holding, after its check was run at the current head, with the evidence of that run
  (*Evidence and heads*). A number the goal has no criterion for is refused.
- **`criterion unmet [<p>/<g>] <n>`** — takes the mark back and drops the criterion's evidence record.
- **`evidence [<p>/<g>] <id> --text "…" | --file <path|->`** — records evidence for a preserve id or
  the area of a touched obligation (*Evidence and heads*). An unknown id is refused, listing the ids.
  Build, person, plan, decision and interactive Martin may; review, mend, plan-review, desk-prepare and
  learning are refused. It writes no LOG.md entry.
- **`criterion set [<p>/<g>] <n> [--criterion "…"] [--check "…"] [--evidence "…"]`** — rewrites
  the criterion's text, check or evidence (kept when not given) and leaves it unmet, logging the old and new
  text. A build, review or mend role is refused, from `MC_ROLE` alone.
- **`criterion remove [<p>/<g>] <n> --reason "…"`** — removes the criterion and
  renumbers those after it, logging its text, check, met state and reason. Its evidence record is dropped and
  the later records follow their criteria down one number.
  The same goal-session roles are refused; the only criterion cannot be removed.
  A criterion verb's refusal of its arguments exits 2 and writes nothing;
  a missing or unparsable GOAL.json remains exit 1.
- **`convert [<p>]`** — turns every goal of the programme (of every programme
  when none is named) still written as GOAL.md into GOAL.json (*Converting a
  GOAL.md*), then gives every goal still written with `after` its phase
  (*Converting after into phases*) and every goal written with one status its
  stage (*Converting a status into a stage*).
- **`from-project <p>/<project>`** — turns a live project into goals, once
  (*From a project*).
- **`phase [<p>/<g>] <n>`** — moves the goal to phase `<n>`, at most one past
  the highest of its programme's other goals, with an entry `Done: phase <n>`;
  then the programme's phases are renumbered (`renumberPhases`), so a phase
  the move left empty closes up and the line names each goal that moved.
- **`log [<p>/<g>] [--done "…"] [--comment "…"] [--next "…"] [--stage <s>] [--status ready|blocked]`** —
  appends one entry; at least one field is needed. `--stage` and `--status`
  also set them. The goal is `MC_GOAL`'s when none is named. `--status Martin`
  is refused (exit 2, nothing written) with a return instruction pointing at
  `mc goal martin`: a question for Martin carries its options.
- **`stage [<p>/<g>] <stage> [--reason "…"]`** — moves the stage
  (`log --stage <stage> --comment <reason>`); a stage moved to is `ready`.
  `merge` records the review's decision (or a mend
  session's requeue) and queues every registered PR, without head or criteria checks. A queue failure preserves
  the decision for retry and runner recovery. Existing `merging` records and
  log entries are read as `merge`; new writes use `merge`.
- **`blocked|ready [<p>/<g>] [--reason "…"]`** — sets the status; the stage stays.
- **`hold [<p>/<g>] --reason "…"` · `release [<p>/<g>] [--reason "…"]`** — an interactive session's hold. `hold` writes `.hold.json` (`by`, `tool`, `at`, `reason`) in the goal's directory and a log entry; stage and status stay, so nothing is asked of Martin and no desk item opens. The runner starts no session on a held goal — delivery, plan or decision — and when a session that was already running ends on a goal that is held, it sets no stage or status on the goal and writes no entry: the hold's owner decides the goal's state. A running session, the merger and landing are not stopped. `release` removes the file and logs each worktree's state: changed files, commits past `origin/main`, last commit. Both are refused with `MC_HEADLESS=1`. A draft made by `mc goal new` without `MC_HEADLESS=1` is held from creation (`created: true` in the file); a stage move out of `draft` by a caller without `MC_HEADLESS=1`, or `release`, frees it. `blocked` is not a hold: outside merge the runner reconciles it to Martin.
- **`martin [<p>/<g>] --kind technical|product --reason "<question>" --option "<key>: <text>"… --recommend <key>`** —
  the compatible goal-bound question command. Optional evidence, documents,
  reserved acts, caller validation, recording and routing are specified once
  in [mc-jev.md](mc-jev.md). Who may set `Martin` (`refusedMove`) is unchanged,
  and so are the runner's own recovery settings of `Martin`.
- **`done [<p>/<g>] [--reason "…"]`** — stage `done`, a person's (or plan's) act;
  the merger sets it when the pull request lands.
- **`drop [<p>/<g>] --reason "…"`** — abandons delivery: stage `dropped`, never
  `done`; it holds no later phase back. The reason is required. Only a person, interactive Martin, decision
  or a plan session drops a goal. After persisting the stage, the command closes
  open PRs owned only by this goal, removes their queued/red merge work, and
  archives immediately when the shared archive safety checks pass. PRs carried
  by another unfinished goal remain open and queued, with that ownership noted.
  GitHub uncertainty, close failure, a live runner session, dirty worktrees, live owners or unpushed
  commits retain the dropped goal and evidence for the next retry; no mend or
  build session starts.
- **`pr <p>/<g> <repo>#<n>…`** — the pull requests named carry the goal: each
  is added to `prs` once, with an entry `Done: carries <repo>#<n>`. For work
  published before `mc publish` wrote `prs`, or from where it could not tell
  the goal.
- **`archive <p>/<g>…`** or **`archive <p>`** (every done or dropped goal of the
  programme) — a finished goal leaves `mc goal list` and the page. Refused, by
  name and reason and with nothing touched, for a goal that is not `done` or
  `dropped`; whose worktree has
  uncommitted changes; with an open pull request on `goal/<g>` or in `prs`;
  and, for a dropped one, whose branch has commits no remote holds. Otherwise
  each worktree is removed with `git worktree remove` and the local branch
  `goal/<g>` deleted, the directory moves to `goals/.archive/<g>/` (a
  dot-directory, so no reader lists it), and `goals/goal_log.md` gets a row:
  date, goal, status, pull requests, the last `Done:`. Then the programme's
  phases are renumbered (*Phases*): when the goal was the last of the lowest
  phase, every goal left moves one phase down, and the line names each. The runner does the same
  by itself immediately for dropped goals during every ordinary reconciliation,
  including old dropped goals without a stage timestamp. Done goals retain the
  24-hour hold (`ARCHIVE_HOLD_MS`), counted from the log entry that set the
  stage (`stageSince`). A refusal the runner gets is
  written once into the goal's LOG.md, as a runner entry, and not again at
  every pass. A programme is never archived by the runner.
- **A goal's branch is made when the goal can start.** A goal in a later phase
  got its branch at `new`, before the phases ahead of it landed. Before the
  runner starts its first build session (no build entry in its log yet), and
  when it goes to `build` by `stage build` or `log --stage build`, each
  worktree is fetched, and one whose branch has no commits past
  `origin/main` is moved to `origin/main` as it is now (`git reset --keep`) —
  that branch made again. A branch with commits of its own is never moved,
  nor one with uncommitted changes `--keep` will not carry; each repository
  says which (`remade from origin/main — it had no commits of its own, and
  main has 12 more`, `left as it is — 3 commits of its own`), and nothing
  here fails the move (`remakeUnbuiltBranches`, `goals.js`). A repository
  without a worktree says `no worktree yet — the runner remakes the branch
  from origin/main at the first session`; it makes no git call.
- **Forward only, each stage its owner, except the desk roles** (`refusedMove`). A session is a
  caller with `MC_GOAL` set and `MC_TOOL` not `person`. Ordinary sessions cannot move a
  stage backward. A person, interactive `MC_ROLE=martin` or unattended `MC_ROLE=decision` may; the entry names
  the actor (`moved back from merge to review by martin`). The interactive plan session (`MC_ROLE=plan`)
  makes any forward move and sets any status. A mend session (`mend-session`) exists only for merge failures and requeues a goal already in `merge` with `mc goal stage merge`; every stage move is refused. Build moves `build` to `review`, may set `blocked` for compatibility, or set `Martin` directly for an unresolved design choice/reserved act. Review moves `review` to `merge` or `build`, may set `Martin` directly, and requires REVIEW.md in its fixed form, with every line OK for `merge` and a NOT OK line for `build`. Nobody moves a goal into `finish`: `mc goal stage finish` is refused, naming `mc goal stage build`. A session other than plan is refused `review` while a
  criterion is not met, or while the goal has none: `mc: mc/g is not moved to
  review — criterion 2 is not met — run its check and record it with mc goal
  criterion met mc/g 2` (`unmetGoalWords`). A build session's move to review is also refused without
  evidence at the head it publishes (*Evidence and heads*). The session decides when to merge.
  Interactive Martin and unattended decision also have validated goal-field and criterion set/remove,
  drop and any-stage authority. Neither can make a criterion met administratively
  or bypass review, acceptance, publication or merge evidence. `MC_HEADLESS=1`
  Martin authority is refused; decision authority is allowed, but headless deploy, admin, production-data and credential hooks remain enforced. Decision may use `mc ask` at any active stage, not just the stage of a delivery role. Its mutations log `by decision`; criterion rewrites remain unmet until checked. Build, review and mend retain their ordinary limits.
- **`show <p>/<g>`** — a status line (`<p>/<g> · stage · status · phase <n> · repos · class ·
  criteria <met>/<all> · created …`, with `· prs …` when set), the goal as text (*Seen, not only stored*), the last three entries, and
  each worktree's changed files, commits past `origin/main` and last commit date.
- **`list [<p>]`** — each programme's goals under a line per phase,
  `<p> · phase <n> · in progress` for the phase the programme is in, `· done`
  for one before it and `· after phase <n-1>` for one after it; under it,
  indented, one line per goal: `programme/goal · repos · stage · status ·
  criteria <met>/<all> · n sessions · the last entry's Next` — `—` for a `done` or `dropped` goal,
  whose last next action is over. A goal waiting for Martin reads `<stage> · Martin,
  waits on a person` (`waitsOnPerson`); a goal in `build` with no criterion
  `build · ready, no criteria — not started`. A goal that
  does not parse has no phase and is listed last, with its problems.

## Converting a GOAL.md

Goals written before 2026-11-03 are a `GOAL.md`: front matter between `---`
lines, then Markdown. `mc goal convert [<programme>]` (`src/mc/goal-convert.js`,
the one reader of GOAL.md left) turns each one not under `goals/.archive/` into
GOAL.json and removes the GOAL.md:

- the front matter's `repos`, `class`, `created` and `prs` become
  fields, and its `status` a stage (*Converting a status into a stage*); the `# ` line is the title;
- `## Goal` is `goal`, `## Contract` is `contract` and `## Out of scope` is
  `out_of_scope`, a paragraph per block between blank lines;
- each top-level bullet or numbered item of `## Criteria` is a criterion, whose check is the
  text after its `*Check:*`, or the whole bullet when it has none;
- any other section is kept as paragraphs of `goal`, after its heading;
- a goal in `review` or `done` has every criterion `met: true` — a session has
  judged them — and any other `met: false`.

A GOAL.md whose front matter does not read, or one beside a GOAL.json, is
left as it is and named on stderr (exit 1). The plan session in `mc` runs the
conversion for every programme once, then rewrites the checks and translates
the Swedish prose by hand.

## From a project

Until 2026-11-03 mc had a second unit of work, the project: a `PLAN.json` of
steps under `~/mc/programs/<programme>/<project>/`, with its state in a
`STATE.json` beside it. A goal carries everything a plan did; a plan's steps
are goals in consecutive phases. `mc goal from-project <programme>/<project>`
(`src/mc/project-convert.js`, the one reader of PLAN.json and STATE.json left)
turns a live project into goals:

- one goal per step not `done` (STATE.json's status laid over the plan's),
  named `<project>-<n>` after the step's number. The first is in the phase its
  programme is in now (`currentPhase`; 1 when no goal of it is left to
  finish), and each after it one phase later, so the steps still run one after
  the other — and a later step waits on every goal of its programme in the
  phase before it, not only on its own project's (*Phases*); `mc goal phase`
  moves one;
- a step blocked on another project of the same programme goes one phase past
  that project's last goal, which must be converted first (until then the
  conversion is refused); on a project that is finished, or whose last goal
  is done or dropped, it waits on nothing. One blocked on a project converted
  in another programme is `build · blocked`, its first entry naming that goal:
  a phase waits only on its own programme's goals;
- the step's `title` is the goal's title, its `instruction` the goal, its
  `done_when` a criterion — the title, checked by `done_when`. The project's
  contract, out of scope and documents go to every goal, its success criteria
  to the last, `met` as STATE.json held them. `class` is the step's work class,
  or the plan's, or `large`;
- a `built` or `landing` step with a pull request is a goal in `review ·
  ready` carrying it, its criterion met; a `blocked` step is `build · blocked`,
  its first LOG.md entry the blocker; any other is `build · ready`. The first
  entry says the step and the phase, `Done: converted from project <p>/<project>,
  step <n>, phase <m>`;
- a step with a branch of its own in STATE.json has its goal's worktree on
  that branch — the local one, or a local branch of that name from origin's —
  so its pull request stays the goal's; any other goal's worktree is
  `goal/<name>` from `origin/main`. The runner's review, `mc goal stage
  merge` and `mc goal archive` read a goal's branch from its worktree
  (`goalBranch`), and the page finds its pull request by the ones GOAL.json
  says carry it as well as by `goal/<name>`;
- a branch-flow project — its last step `kind: review` — is one goal, named
  after the project, on the project's branch: the project's goal and every
  remaining step's instruction as its text, every remaining step's criterion,
  in `review · ready` with the pull request when every step before the review
  is built, else `build`.

A project with every step done, or archived (a `CLOSEOUT.json` beside its
plan), is refused and left as it is on disk; nothing else in mc reads it. So
is a project whose goals already exist, and one whose branch is checked out in
another worktree — with nothing written. The answer names each goal made with
its stage, status, phase, branch and pull request:
`mc: mc/mixed-2 · review · ready · phase 1 · mixed-2 · carries memoro-cli#41`.

## Phases

Martin, 2026-11-03: *"GOAL ska också kunna delas in i faser: En fas innebär en
grupp mål som ska vara samtliga 'done' innan goals i fas 2 kan påbörjas."* and
*"Vi använder phases alltså behövs inte waiting."* A goal's `phase` says when
it may start; its stage does not change for it.

- **Gated by phase** (`currentPhase`, `phaseOpen` in `goals.js`). The phase a
  programme is in is the lowest phase of its goals that parse and are neither
  `done` nor `dropped`. The runner picks no goal in a higher phase — not for a
  build, a review or plan — until every goal of the programme in a lower phase
  is done or dropped. The goals of one phase run side by side. A goal that does
  not parse has no phase and holds nothing back.
- **No holes, lowest is 1** (`phaseMoves`, `renumberPhases`). `mc goal new
  --phase` and `mc goal phase` take at most one past the programme's highest.
  When a goal is archived — by `mc goal archive` or by the runner — and when
  `mc goal phase` moves one, the programme's phases are renumbered so they run
  1, 2, … in the order they had: when the last goal of phase 1 leaves, phase 2
  is phase 1 and phase 3 phase 2 (Martin: *"när goals/faser arkiveras så får
  n+1 n istället"*). A renumbering writes GOAL.json only, no log entry.
- **Seen.** `mc goal list` groups by phase and names the phase in progress;
  `mc goal show` gives the goal's phase. On the page a goal in a phase not yet
  reached is in the waiting colour (yellow, `docs/technical/mc-ui.md`)
  and leads its tail with `phase <n> — after phase <n-1>`; its row in `mc
  --json` (`programmes[].goals[]`) carries `phase` and `held`.

### Converting after into phases

Until 2026-11-03 a goal named the goals it started after in `after`, and was
`waiting` until they landed. `phaseGoals` (`goal-convert.js`, the one reader of
`after` left) turns each goal still written so into a phase by the depth of its
chain: a goal whose `after` has all landed — `done`, `dropped`, or no goal any
more — keeps its phase (1 when it had none), and a goal after one that has not
is one phase past the latest of them; so a chain a ← b ← c of goals not yet
landed is phases 1, 2, 3. `after` is removed, a `waiting` goal is `build ·
ready`, and a goal whose phase or stage changed gets an entry `Done: build ·
ready, from waiting; phase <n>, from after <names>`. The programmes touched are then renumbered. `mc goal convert` runs it
(as `person`), and the runner runs it before it picks goals and before it
archives (`convertAfter` in `run.js`, as `runner`), so a GOAL.json with `after`
never stays one; with nothing to convert nothing is written.

### Converting a status into a stage

A goal written before stages has one `status`. The same pass (`phaseGoals`,
`stageOfLegacy` in `goal-convert.js`) gives it `stage` and `status` from that
status and its log, with an entry `Done: <stage> · <status>, from <old>`:

- `open` and `waiting` → `build · ready`;
- `review` → `review · ready`, or `merge · ready` when the runner's last word
  was `queued #<pr> at <sha> for the merger`;
- `blocked` → the stage its log says it was blocked in, `· blocked`: a red
  review's verdict is `build`; the merger's red or a queued green is
  `merge`; the runner's word on a review (no verdict, no pull request, a
  moved head) or an entry in `review` is `review`; anything else — a build
  session's question, three sessions without a word, an entry in `open` — is
  `build`. The runner's `plan session ended …` entry and a person's block are
  read past;
- `done` and `dropped` stay as they are, `· ready`.

## How the runner takes a goal

A free lane takes a goal's session: `pickWork` (`lane-pick.js`) orders the
candidates ([mc-run.md](mc-run.md), *What a free lane takes*), and
`goalPass` in `src/mc/run.js` takes the pick:

1. **Pick.** After goals written with `after` or one status are converted
   (*Converting …*), of the goals the runner starts a session on
   (`goalSession`, `goals.js`) — `build · ready` with a criterion (a build),
   `review · ready` (a review), `build · ready` after a rejection (a repair build), unqueued
   `merge · blocked`, and legacy `merge · ready` whose last entry is the merger's red and none of whose pull requests
   is in the merger's line (a mend session) — no delivery session on `draft · ready` or
   `Martin`. The next-draft assignment is added separately to the candidates. Eligible work is in the phase their programme is in or an earlier one
   (*Phases*), and not held, on any repository (a lane serves them all), the
   one whose last entry is oldest. A review that cannot run now (step 3) is
   left out of the pick, so it does not stand in front of every other goal;
   why is said once in `runner.log`. No entry means oldest of all; a tie goes
   to the first listed. Held means a current file named
   `goal:<programme>/<goal>` exists, or the lane claimed it this tick. A goal
   keeps no slot between its sessions.
2. **Worktrees.** A repository's worktree that has gone is made again on
   `goal/<goal>`, as `mc goal new` makes it. Before a goal's first build
   session, a branch with no commits of its own is remade from `origin/main`
   (`remakeUnbuiltBranches`).
3. **Launch.** A goal in `build` gets a build session with the `build-session:goal`
   role (`canon/roles/build-session.md`, its `goal` and shared build parts), in
   the first repository's worktree, with the goal's class routing, model and
   billing as any headless session has them. A goal in `review` gets a review session with
   the `review-session:goal` role instead, on a review candidate (`mc
   model`). Review ranks usable subscriptions by provider priority, then headroom; ties avoid the build model, then follow catalog order. Build-model diversity is a tie rule, not a reason to abandon a preferred provider or roomier subscription. With no
   candidate on its plan it uses the API
   reserve as a class does (`docs/technical/mc-run.md`, *Work classes and
   capacity*). The models are compared as the catalog spells them, which is
   how `MC_MODEL` writes them into the heading. The review is told its pull
   request and head: the open pull request on `goal/<goal>`, asked of GitHub
   before the launch, and `MC_REVIEW_HEAD`, `MC_REVIEW_PR` and
   `MC_SESSION_STARTED` are set for it. With none, the goal goes to
   `build · ready` with a runner entry that names the missing pull request
   the first time, and to `review · Martin` the second (a review session's entry
   between the two resets the count). A repair build gets a build session on the
   `finish` catalog list (a list name kept; it is not the goal's class); merge failures alone get a mend session (`mend-session`) on the mend list; next-draft planning runs on the plan list. None of them uses the goal's class, and none borrows a class's candidates when its own list has none usable. Legacy blocked goals outside merge are reconciled to Martin, retaining prior evidence without a diagnostic launch. `MC_ROLE`,
   `MC_GOAL`, `MC_REPO`, `MC_WORKAREA` and `MC_TOOL` are set for every kind.
   If the role's file is missing on the machine, the goal is skipped.
4. **Silent build.** A build session that leaves no entry gets one from the
   runner: tool `runner`, stage and status unchanged, `Comment: session ended
   without a log entry (exit <n>, <s> s)`. A worktree that could not be made
   gets one too. When the last three entries in `build` are all the runner's,
   the goal is set `build · Martin`, and the stage stays build.
   That is the guard against a session that fails the same way every time;
   there is no attempt counter.
5. **After a review** (`afterReview`). The review decides with `mc goal stage
   merge` or `build`; mc checks REVIEW.md's lines when the move is made, and the
   runner reads neither its words nor the verdict. A first crash leaves `review · ready` for the bounded retry; a
   second crash sets `review · Martin`. A dirty review refusal also sets Martin
   and preserves the worktree paths; it is not sent to mend.
6. **After a repair build.** A build session on a goal moved back by a review
   is the same session as any build (`afterBuild`): it moves the goal to
   `review` or the three-silent-sessions and no-progress counts apply. Its
   prompt names REVIEW.md and the NOT OK ids.
7. **After a mend session** (`afterMend`) in merge only: a completed repair
   returns `merge · ready`. An already queued PR remains with the merger; a
   missing queue entry is restored by the runner, including a previous red job.
   The first and second failed merge results set `merge · blocked` and start
   mend. The third failed merge result sets `merge · Martin` without another
   mend. Count actual merger failure entries in this merge stage, not mend
   launches or ready handoffs; an interactive ready entry starts a new cycle.
   Pre-merge blocked records migrate to Martin without a diagnostic launch.

Each session is a row in `runs.tsv` named `goal:<p>/<g>`, of kind
`build-goal`, `review-goal`, `repair`, `mend` or `plan` (`finish` in rows from before 2026-11-15); rows from before say
`goal` (read as the build they were). `plan` now names the next-draft assignment;
older `plan` rows retain their historical headless planning meaning. On the page
it is a `BUILD`, `REVIEW`, `REPAIR`, `MEND` or `PLAN` row (`FINISH` for an old row) under its goal.
A build waits behind every review for a free lane; a repair build
and merge-failure mend rank as finish ranked, before review; no pre-merge mend exists ([mc-run.md](mc-run.md) § *The pick*).

## Repair and mend

The broad headless plan role was retired on 2026-11-07. Interactive planning
remains `mc plan`; next-draft planning returns under the bounded assignment
below (Martin, 2026-11-09). Goal delivery recovery stays with two roles:

- **A repair build** (`MC_ROLE=build-session:goal`, `canon/roles/build-session.md`)
  takes a goal in `build · ready` that a review moved back, after the last
  move into draft and with no person's move since. It reads REVIEW.md, fixes the
  NOT OK items, runs every criterion's check again and records it at the new
  head (*Evidence and heads*), runs `mc gate`, publishes and moves the
  goal to `review`. It changes code within contract, not goal text or product
  scope, and resolves its own acceptance obstacles; an unresolved design
  choice or reserved act goes directly to Martin. It runs on the `finish`
  catalog list. Three such sessions without a word set the goal Martin, the stage stays
  build. `finish` is a name kept for old records: a goal found in `finish · ready`
  is moved to `build · ready` by the runner, with a log entry, before any session starts.
- **A mend session** (`MC_ROLE=mend-session`, `canon/roles/mend-session.md`)
  owns the reported merge failure through its repair and final handoff. It
  diagnoses from the current goal, merger evidence and judged revision, and
  may change code, commissioned tests, fixtures and documentation within the
  contract. Necessary integration follows *Integrating main into a goal*;
  a delivery retry may require no source change or commit. It does not change
  goal text, acceptance, product/privacy policy or test protection scope.
  After a content-changing repair it establishes affected criterion evidence
  and completed whole-selection acceptance under the publication procedure
  on the final judged worktree before authorizing landing through the round. An unchanged retry may retain still-valid
  evidence under the existing reuse rules. Explicitly approved verification
  exceptions keep their exact scope; the merger’s reuse does not replace this acceptance.
  It publishes repairs with `mc publish --no-merge`, records cause, repair and
  evidence, then requeues every registered PR with `mc goal stage merge` and ends in the same turn.
  A `ready` completion lets the runner restore missing delivery. Before
  publishing or requeueing, it rereads the goal and preserves any intervening person decision: it cannot
  clear Martin's hold or reactivate a completed/dropped goal. These are session
  obligations, not a claim that the requeue command enforces every boundary.
  Main's red is never a mend's: the merge round runs untouched red files at
  its base, goes on past those red there by name and writes a `main-health`
  repair goal, an ordinary `build · ready` goal the runner takes like any
  other ([`mc-merge.md`](mc-merge.md) § *The merge judges the pull request
  against main*, Martin 2026-11-10).
  A queued PR remains the merger's. The failure limit counts merger results:
  failures one and two run mend and retry, failure three waits on Martin.
  Mend's ready handoff does not reset that count. An obstacle outside its
  authority uses goal-bound `mc ask` with evidence under the question contract
  in [mc-jev.md](mc-jev.md). Pre-merge blocked goals
  never start mend: legacy records are reconciled to Martin without a diagnostic
  launch. Build/review own their acceptance repairs.

Both run in the goal's first repository's worktree, a repair build on the finish list
and mend on the mend list (never the goal's class), with billing like a build, with `MC_GOAL`, `MC_REPO` and
`MC_WORKAREA` set; their `mc goal stage merge` writes the merge handoff file
that ends the session and releases its lane. Neither performs Martin's acts:
deploy, production data, credentials or admin override. The programme turns
headless plan also ran (`no_goals_remaining`, `daily_proposals`) are
disabled: their instructions were too poor to use (Martin, 2026-11-07), and
`programme-plan.js` and `MC_PLAN_REASON` remain removed. Next-draft planning
below uses the existing goal-session mechanism instead.

## What a build session does

The role is `canon/roles/build-session.md`, started as `build-session:goal`:
what every headless build does is written once, in the shared part, and the
`goal` part keeps only what is a goal's — its
brief, LOG.md and the criterion verbs. It keeps the existing goal branch;
main advancing alone does not justify a catch-up merge. A concrete conflict,
landed prerequisite or demonstrated upstream acceptance obstacle follows
*Integrating main into a goal*, including final-tree acceptance. It works item
after item until the criteria hold, and ends at a boundary between two only when the work is
done, when it is blocked, or when its turns cost more than a fresh session
reading the log would — a finished part that reads well is not a reason to
stop. It runs `mc gate` and commits, then runs each criterion's check at that
committed head and records the ones that hold with
`mc goal criterion met <n> --evidence "…"`, and a preserve item or touched obligation with
`mc goal evidence <id> --text "…"`; a commit or an integration of main after a
mark makes every mark stale, and every check is run and recorded again. Then it
publishes with `mc publish --no-merge` (without the flag mc still queues nothing for a goal
before stage `merge`). It ends with `mc goal log` and does one of two things:
`--stage review` when every criterion is met and the pull request carries
them, or, when the goal's own text is wrong, reports it with `mc goal defect`
and ends (*The verbs*). An acceptance obstacle it cannot repair within its
scope goes to Martin with `mc goal martin` (or goal-bound `mc ask`) and its
evidence; it is not a goal defect, since the goal's text is not what is wrong.
Questions use goal-bound `mc ask` under the question contract in
[mc-jev.md](mc-jev.md). No build exit goes through pre-merge mend.

**A build that makes no progress stops.** After each build session that spoke
(and did not end by quota, login or interruption), the runner reads the goal's
heads (`git rev-parse HEAD` of each repository worktree) and its met count. A
session is *without progress* when it wrote a log entry, left the goal
`build · ready`, did not raise the met count and left every head unchanged.
The third such session in a row ends the goal's builds: the runner writes one
entry with status `Martin` whose comment begins `no progress:` and carries the
heads, the criteria count and the last `Next`; `goalSession` then returns null,
so no fourth session starts, and the desk item's label is that line (sort
`mechanical`). A commit, a higher met count, or any change of stage or status
starts the count again. The runner's own lines about it (`no progress this
session (n of 3)`, `progress again: …`, `session not counted for progress: …`)
are skipped by both counts: they are not a session's word, so a no-progress
session followed by two silent ones does not set Martin, while three silent
sessions with nothing between still do. An unreadable head, and a quota, login
or offline ending, are not counted. The stopped goal loses nothing: its branch,
worktree, pull request and log stay, and `mc goal ready` after the desk has
amended the text continues it. Progress is never stopped: the count looks
only at sessions that did nothing. `blocked` is for
compatibility only: a `blocked` goal before merge, left by an older session, is
reconciled to Martin by the runner without a session and wakes no mend. A build session
publishes; it never authorizes PR landing, sets `done` or moves the goal
anywhere else. Necessary main integration is distinct from PR landing.

## What a review session does

The role (`canon/roles/review-session.md`, its `goal` part) judges and never builds: it does not
edit, commit, push or comment-fix. It reads the goal (its prompt carries it,
rendered), LOG.md and the pull request's diff against `origin/main`, and
checks, in order:

- **Goal** — each criterion: it runs the criterion's check itself (`mc gate`,
  `mc`, `mc shot`, the code) and answers red when one does not hold, whatever
  its `met` says. A builder's claim — `met` included — is not evidence.
- **Structure** — the change fits where it sits, no duplication, the right
  altitude, readable names, the documents the goal names updated.
- **Bugs** — edge cases, error paths and regressions in what the diff touches.

Martin, 2026-11-03: *"Vi ska utnyttja reviewen till input utan att betala för
output som ingen läser."* Its output is exactly three things:

- **The stage, always one of two.** OK: `mc goal stage merge`, which queues
  all registered pull requests for the ordinary measured round. Before authorizing
  it, the review session must complete `mc gate --whole-selection`
  on the judged worktrees: GREEN, or only adjudicated untouched-baseline
  `SETTLED` failures (Martin, 2026-11-11). The latter does not hold delivery
  for an owning repair and does not turn the incomplete receipt green. Record
  failed members, named baseline failures and frozen base. The round reuses
  valid passing evidence and independently measures the rest on its current
  base, without re-checking criteria or the reviewed head. See the canonical
  [publication and landing procedure](../../canon/tasks/publish-and-merge.md).
  Not OK: `mc goal stage build`.
  Either way `REVIEW.md` is written first, in its fixed form (below).
- **One proposal, always** — whichever stage, one file in
  `~/mc/programs/<programme>/proposals/` with what it noticed beyond the goal.
  The programme's interactive plan session takes a stand on it.
- **One line in LOG.md**, the stage verb's `--reason`, naming the files it wrote.

Nothing else: no comment on the pull request, no long entry. **A review never
ends in `review`.** Claude Code's Stop hook runs `mc hook stop`
(`reviewStopDecision`, `hooks.js`): for a session with `MC_ROLE=review-session:goal`
it refuses the end — `{ "decision": "block", "reason": … }` — while the goal is in
`review` or no `.md` has been written in the programme's `proposals/` since
`MC_SESSION_STARTED`, naming what is missing. A goal moved to `merge` or `build`, `blocked` or in `Martin` is not held (a third rejection stays in review, set Martin): the review
has asked, and the question is Martin's. Any other session ends as it will. A review that dies anyway leaves the goal `review · ready` (*How the
runner takes a goal*, step 5).

### The verdict, the rounds and the tripped areas

REVIEW.md is written before either move and holds one `head: <repo> <sha>` line
for each repository of the goal, then one line per item: `<id>: OK` or
`<id>: NOT OK — <what and where>`. The ids are `criterion <n>`, each preserve id
(`V1`…), `obligation <area>` for each touched obligation, `untouched <area>` for
each tripped area (below), and `change`, `out-of-scope`, `protection` and `bugs`.
A version 1 goal has the criterion lines and the head lines only. Free text may
follow. `mc goal stage merge|build` from a review session checks the file
(`checkVerdict`, `review-verdict.js`) and refuses, naming each id or line at
fault, when: the file is missing; a repository's head line is missing or the
first repository's is not `MC_REVIEW_HEAD`; an id is missing, repeated or not
the goal's; a line is not in form. `merge` is also refused while a line is NOT
OK, and `build` while all are OK. Neither the judgement nor the reasons are read.
After either move REVIEW.md stays and `REVIEW-<round>.md` is its copy, the round
being the count of reviews since the goal's latest move into draft.
`mc goal stage finish` is refused for every caller, naming `mc goal stage build`.

**Tripped areas.** An obligation that stands `untouched` is a tripwire: when the
branch's diff against `origin/main` (`git diff --name-only origin/main...<head>`,
in each repository of the goal) holds a file under one of the area's paths, the
area is tripped, and the verdict needs an `untouched <area>` line. One function,
`trippedAreas` (`review-verdict.js`), decides which areas are tripped; the review
prompt lists them with their files and the move to merge or build requires their
lines, so what the reviewer is told and what mc requires are the same list. A
file under a touched area's paths is not listed.

**Rounds.** A rejection moves the goal `review → build` with the reviewer's
`--reason`; a repair build session (*Repair and mend*) fixes the NOT OK items
and moves it to `review`. The next review is narrow: its prompt names the earlier
review's heads and failed items, and it judges those and what changed since,
copying every other line as `<id>: OK — carried from round <n>`, which counts as
OK. An old REVIEW.md with no head line gives a whole review. The **third**
rejection does not move: `mc goal stage build` with a NOT OK line exits 0,
leaves the stage `review`, sets status `Martin` with a comment that the goal was
rejected a third time and queues nothing. A move to `finish` in a log from before,
and the rejections before the goal's latest move into draft, are not counted
(`rejections`, `goals.js`). A goal moved to `merge` and back to `build` by a
person after a rejection is not a repair (`isRepair`: the latest rejection, or the
runner's move of an old `finish` record to build, must be later than the latest move
to `merge`), nor is one the runner returned to build for want of a pull request.

## Evidence and heads

A goal goes to review only with evidence for every item, run at the head it
publishes (`src/mc/goal-evidence.js`). The records are in `.evidence.json` in
the goal's directory, beside GOAL.json and LOG.md, not in the goal's text: the
brief (`renderGoalText`) and the plan review's hash (`goalHash`) never hold
them, and no LOG.md entry is written for one (the runner reads LOG.md to tell
whether a session spoke). A record is kept under the id the review's verdict
uses — `criterion <n>`, a preserve id (`V1`) or `obligation <area>` — and holds
`{ at, tool, model, role, heads, text }`: the head of every worktree of the
goal, the time, the writer's tool and model, and the evidence text. A
criterion's record also holds the criterion's text; a record whose text is not
the criterion's now counts as none.

- **Marks.** `mc goal criterion met <n> --evidence "…" | --evidence-file <path|->`
  (`-` is stdin, read verbatim) records the mark and the evidence. A build
  session's mark is refused when a worktree is dirty (`<repo> has uncommitted
  changes — commit them, run the check at that head, then record it`) or
  absent, and, for a version 2 goal, when no evidence is given; a version 1
  goal needs none. A person, plan, decision or interactive Martin is accepted
  without worktrees and records the heads that exist.
- **Other items.** `mc goal evidence <p>/<g> <id> --text "…" | --file <path|->`
  records a preserve id or the area of a touched obligation. An unknown id is
  refused, listing the ids. Build, person, plan, decision and interactive
  Martin may; review, mend, plan-review, desk-prepare and learning are refused.
- **Dropping.** `criterion unmet` and `criterion set` drop the criterion's
  record; `criterion remove` drops it and renumbers the later ones.
- **The move to review.** A build session's `mc goal stage review` and
  `mc goal log --stage review` are refused, each item named, unless every
  criterion has a record at the current head of every worktree; every worktree's
  HEAD is `refs/remotes/origin/<its branch>` (the refusal names `mc publish
  --no-merge`); every repository has a worktree; and, for a version 2 goal,
  every preserve item and every `touched` obligation has a record (an
  `untouched` one is not asked). Martin, decision, a person and plan keep the
  check on criteria and parts only. mc judges presence and head, never whether
  the evidence is good: that is the review's.
- **Rejection.** A review's move back to build removes the records of the items
  its REVIEW.md marks NOT OK (`criterion <n>`, a preserve id,
  `obligation <area>`), so the repair gives them new evidence. The repair's
  commit makes every other criterion's mark stale, so the repair build runs
  every criterion's check again and records it at its new head; preserve items
  and obligations judged OK keep their records. A person's move back and the
  third rejection remove none.
- **Reading.** `mc goal show` prints an EVIDENCE part, one entry per record with
  its heads, time, tool, model and text, and marks `stale` beside a met
  criterion whose record is at another head. A review reads the evidence there.

## Done when its work has landed

Martin, 2026-11-03: *"När ett goal steg landas så måste status uppdateras
automatiskt till 'done'"*. Until then only a landing of the goal's own
`goal/<g>` pull request, queued by its green review, set `done`; work landed
from other branches — `ios-release/mc-asc` landed in six pull requests across
memoro and memoro-cli — left the goal for a person to close by hand.

- **A pull request carries its goal.** `mc publish` writes the pull request
  into the goal's `prs`, with an entry `Done: published <repo>#<n>` carrying
  `· by <role>` like every session entry, when it
  knows the goal: `--goal <p>/<g>`, else `MC_GOAL`, else the goal whose
  worktree it stands in (`goalOfPath`), else the one goal named as a
  `goal/<g>` branch is. A `--goal` that is no goal is refused before the push;
  found any other way, a goal that is not there is none. `mc goal pr` adds one
  by hand.
- **The merger tells the goal whoever queued it.** A job's goal is its own
  (`job.goal`, the review's `mc goal stage merge`), else the goal whose `prs` name it
  (`goalOfJob`, merger.js, over `programsGoals`). So a pull request a person
  queues with `mc merge`, or one `mc publish` queued, is the goal's too — but
  only in stage `merge`: before it, `mc publish` queues nothing and `mc merge`
  refuses (*No merge before stage merge*, below), so a person queues a goal's
  pull request with `mc merge` only after `mc goal stage merge`, never to skip it.
- **Done when all have landed.** Landed, and the goal carries no other pull
  request: stage `done`. Landed while it carries others: an entry with no
  change (`… the goal carries memoro-cli#1238 too — done when every one has
  landed or closed`). The runner's `settleLanded` pass (run.js), at most every
  five minutes, asks GitHub for the state of each pull request of every goal
  that is not finished and carries any, and sets `done` when at least one is
  merged and none is open or unknown (`prsLanded`) — however each
  landed: the merger, `mc merge --docs`, `--admin`, or on GitHub. A pull
  request GitHub cannot say about leaves the goal as it is. A pull request
  closed without merging is settled, not waited for: its entry's comment
  names it (`closed without landing: …`), and the runner and `mc goal stage
  merge` never queue it (`… closed without merging — not queued`). A goal
  whose every pull request is closed is not done. In `merge · ready`, the runner
  sets it `merge · Martin` once, with a comment naming the closed pull requests,
  and says nothing further for it. A goal with any open or unknown pull request,
  in another stage, or already blocked is unchanged. A pull request already
  merged is not queued either (`… already merged — not queued`); it counts as
  landed through `prsLanded`.
- **Review stays on the first repository.** A goal's review session is told
  the open pull request on `goal/<g>` in its first repository, as before; a
  second repository's pull request carries the goal and lands it, but is not
  reviewed by the goal's review. A goal across two repositories whose second
  half needs review publishes it from that repository's worktree, and plan or
  a person reads it.

## The merger

A session sends a goal to `merge`. Every registered PR lands through the ordinary
measured round on the current base, reusing the session’s whole-selection receipt
(exact when tree and selection match, delta for selected main movement) and
measuring the rest. The squash is pinned to the head the round measured. The
merger does not re-check criteria or the reviewed head. Each landing is
recorded in LOG.md under the shared lock; when the last PR lands the goal is
`done`. A first or second failed merge sets `merge · blocked` and starts merge-only
recovery when the PR is not already queued. Mend returns it to `merge · ready`
for delivery again. The third failed merge sets `merge · Martin`. Failure
counting uses merger results in LOG.md, not mend-session starts; an interactive
ready entry starts a new cycle. An in-scope repair that cannot be completed
still uses the existing escalation path.
A pushed head leaves the queue with the goal still in merge for mend to re-judge
it. Ordinary requeue, offline backoff and dropped-goal ownership checks apply.
The merger does not resolve content conflicts.
The runner recovers missing queue entries after interruption; it executes the
existing decision and does not move a goal to `merge` on its own.

## Plan review

A goal leaves `draft` (to `build`, or to a later stage a plan or person names)
only when it is complete and a fresh session has read it. Moving it to
`dropped` is not checked. The gate is in `logEntry`, after `refusedMove`, so
`mc goal stage`, `mc goal log --stage` and the status verbs share it; a refused
move exits 1 and writes nothing.

- **Parts** (version 2 goals only). The refusal names every lack at once: an
  empty outcome, no change item, no criterion, a declared rule area without a
  stand, a stand whose `--standard` path is not on origin/main of the repository
  it names. A question mc cannot answer (a git failure, an unknown repository, a
  failing declarations read) refuses with the reason. Items saying `every`,
  `only` or `no other` (whole words) without a premise id are not refused; they
  are listed for the reader.
- **Reading** (both versions). The latest reading must be OK and judge the
  current text, or two readings since the goal last entered draft must be
  stored and `mc goal stage … build --reason "…"` be given; the log entry then
  carries the reason and both verdicts. `log --stage` has no reason flag and is
  refused in that case, naming the stage verb.
- **The text's hash** is sha256 of `renderGoalText` with every criterion's met
  set false, so met marks, stage, status, phase, repos, class, prs, the log and
  the hold are not part of it; any other edit asks for a new reading.
- **`.plan-review.json`** in the goal directory holds append-only records:
  verdict, hash, round, tool, model, time; a move into draft from another stage
  appends a marker. Readings and rounds count from the last marker. The goal
  file format does not change. `PLAN-REVIEW.md` is the latest reading's text; an
  earlier one is kept as `PLAN-REVIEW-<round>.md`.
- **The call**: `mc goal plan-review <p>/<g> [--avoid <tool>:<model>]`, for a
  goal in `draft`, from a caller `refusedMove` would let move it draft→build
  (a build, review, mend, desk-prepare or plan-review session is
  refused). The learning role runs one reading per goal it wrote. At most two
  readings per stay in draft; a refused call exits 2 and launches nothing.
  Exit 0 is OK, 1 is not OK, no verdict, a timeout (even after a verdict),
  a changed file or unproven checkout cleanup.
- **The reader** runs on the review list, never on the author's model while
  another candidate can run (the author is the caller's `MC_TOOL`/`MC_MODEL`,
  else `--avoid`; with neither, nothing is excluded and the call and the record
  say the author is unknown). It is a child of the call with a 20-minute limit,
  no runner lane, in a read-only checkout with a unique path per call. The call
  removes only the directory it created, rechecking its device, inode and birth
  time before cleanup; a replacement or uncertain identity is retained and named.
  A dead or expired launch leaves no reading; the next call uses its own path
  and leaves any abandoned checkout untouched. Its cost is
  a run row `goal:<p>/<g>`, kind `plan-review`, in the desk's runs: plan cost in
  `mc landed`, never the goal's own, and not the desk budget.
- **The verdict** is recorded only by the launched session: `mc goal plan-review
  <p>/<g> verdict ok|not-ok` needs `MC_ROLE=plan-review`, the launch's goal, the
  token (only its sha256 is stored, in `.plan-review-launch.json`; the token goes
  only in the child's environment), a live launch and a `PLAN-REVIEW.md` written
  after the launch whose first line is `OK` or `NOT OK` matching. A reading during
  which GOAL.json, LOG.md or `.hold.json` changed is discarded. From this role
  `mc goal` accepts `show`, `list`, `areas` and the verdict only, and `mc ask` is
  refused.
- **Show and areas.** `mc goal show` says where the review stands (none, OK for
  this text, OK for an earlier text, not OK with the round). `mc goal areas
  <p>/<g>` proposes a stand for each area without one: touched, naming the change
  items whose `where` holds a path under the area's paths (or a directory above),
  otherwise untouched. The proposal is advisory.

## Stages

Each stage has one owner, and a goal passes each once:

- `draft` — a plan session writes the goal, interactively or through the
  next-draft assignment below. The plan session moves it to `build`
  when it is complete and has an OK reading (*Plan review*). (Named `plan` until 2026-11-07.)
- `build` — the runner's build sessions, while it is `ready`; legacy `blocked` outside merge reconciles to Martin without a launch. Three sessions in a row without a commit or a criterion met stop it with `no progress:` and `Martin`; a build session that finds the goal wrong reports it with `mc goal defect`, also `Martin`.
- `review` — one review session decides; one that dies is run again once, a second crash or dirty refusal waits directly on Martin. A review that finds the goal wrong reports it with `mc goal defect`.
- `finish` — no longer entered. A goal found in it (`finish · ready`) is moved to `build` by the runner with a log entry; with REVIEW.md it gets a repair build.
- `merge` — the merger's; the runner starts no session, except one mend session for an unqueued merge failure.
- `done` — set by the merger or the runner when every pull request the goal
  carries has landed, or by a person. Final.
- `dropped` — delivery abandoned (`mc goal drop`), by a person, plan, decision or interactive Martin, from any
  stage. Final; it holds no later phase back, and is immediately finalized and
  archived when cleanup is safe. A dropped goal never wakes a mend session or
  accepts an old merger answer.

`Martin`, in any stage, starts no delivery session; its desk item goes through preparation and the decision pass ([mc-martin.md](mc-martin.md)). The existing display still says it waits on Martin: `mc goal list` says `<stage> · Martin, waits on
a person`, and the page leads the row's tail with `waits on a person` and the
last entry's comment, in the colour of what waits on a person. `mc goal ready`
sets it ready in the same stage. A person, interactive Martin or decision may move a stage backward. The
page's goal rows, `mc goal show`, `mc goal list` and `mc --json`
(`programmes[].goals[]`, with `stage` and `status`) all say `stage · status`.

## What a goal does not have

- **Criteria, not tasks inside the goal.** Criteria are data in GOAL.json,
  met when a session has run the check. Split ordered work into goals in phases.
- **No register.** mc writes GOAL.json, LOG.md, the current file while a
  session runs, and the `runs.tsv` row. Nothing else.
- **No owner, lease, revision or capability report.** Anyone may work in the
  worktree; the last entry says what was done.
- **Another model reviews, when one can.** The review is a session of its own
  role on a review candidate; the last build entry's model only when no other
  candidate can run on its plan.
- **No merge by a build session.** A build session publishes with
  `--no-merge`; a review session publishes nothing. A review's `mc goal stage
  merge` executes its decision for all registered PRs; a mend session requeues a red merge with it.
- **No merge before stage merge — mc refuses it.** A goal's pull request
  reaches the merger only when the goal is in stage `merge`, and the code
  holds it, not only the role text. `mc publish` for a publication that
  carries a goal in draft, build or review (or whose stage cannot be
  read) queues nothing, with or without `--no-merge`, exits 0 and prints one
  line naming the goal, its stage and `mc goal stage merge`; under `--json`
  its `next` is `mc goal stage merge <programme>/<goal>`. `mc merge` refuses
  with exit 1, before any round, landing or queue write, a request that names
  a pull request carried by such a goal — registered in its `prs`, or found by
  its head branch `goal/<g>` — whatever the caller, for several pull requests
  (none is queued), `--docs` and a documents-only pull request alike.
  `--admin`, `--check` and `mc merge watch` are not touched. `mc goal stage
  merge` queues through `queueMerge`, not through `mc merge`, so the hand-off
  works. A job already queued when its goal is moved back from `merge` still
  lands (a known gap of the merger).
- **No close-out document.** `mc goal archive` moves a finished goal aside
  and writes one row; nothing is written into a repository.

## Next draft planning

Martin, 2026-11-09 supersedes the prohibition on all headless programme planning:
when a programme has at least one draft and all its goals are `draft`, `done`
or `dropped`, the runner may start one plan session to complete its next draft.
Any build/review/merge goal excludes it, regardless of status; unreadable
goal data excludes it too. Empty programmes and programmes with no drafts launch
nothing. `dropped` has the same terminal meaning as in phase eligibility.

The next draft is selected by ascending phase, creation instant, then name.
Compare creation instants chronologically regardless of offset or precision;
missing dates sort before dated goals, and equal or missing instants tie by name.
The selected draft must be ready and not held; one waiting on Martin or held holds planning rather than being bypassed. A draft created without `MC_HEADLESS=1` is held from creation (Martin, 2026-11-15; `hold` in The verbs), so headless planning does not take a draft while its author is writing it; a draft a headless session created, one its author released, and one made before this rule (which carries no hold) are free for it. Only one goal session per programme may be held while planning
starts, including current records from a predecessor runner. Admission rechecks
the trigger and the hold before spawning. The plan uses that draft's goal worktrees and branch,
role `plan`, kind `plan`, MC_GOAL and MC_HEADLESS=1, with existing routing, lane
and reserved-act rules. Interactive planning checkouts remain separate.

Complete exactly the selected draft's parts as `mc goal show` names them, its
stand on every rule area, its documents and executable success checks,
reconcile the programme README and phases, and move it to build immediately
when ready. Resolve a remaining policy
choice through goal-bound `mc ask` under [mc-jev.md](mc-jev.md). Do not implement the draft or process the
proposal backlog in the headless planning turn. A completed session leaving
`draft · ready` waits on Martin with an incomplete-session diagnostic, unless the draft is held when the session ends: then nothing is set; provider
refusals/offline failures keep their existing retries. Broader programme design
and proposal intake remain interactive. This restores neither no-draft nor
daily-proposal turns.
