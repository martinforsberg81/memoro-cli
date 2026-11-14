# `mc martin` — the decision desk and its opening

Linux SSH interactive launches keep their provider alive past the terminal ([Claude background session or Codex app-server](mc-interactive-sessions.md)); macOS retains the existing foreground terminal.

`mc martin` is Martin's foreground interactive decision desk in
`~/mc/martin/`. It has a distinct owner and conversation identity. `--new`,
`--resume [id]`, `--codex`/`--claude` and `--model` follow `openInWorkArea`;
there is no headless form and the runner never launches it. A resumed
conversation receives a refresh of the same opening as a reply, not what it
remembers of earlier openings. Launch does not make per-goal checkouts.

## Opening

Launch first syncs the durable desk items (below), then builds the opening from
the item store, the item briefs, `runs.tsv` and the daily ceiling, with no
model. The opening is the launch's first prompt; a resumed conversation gets
it again as a refresh. `mc martin brief` prints the same opening and starts no
session; `brief --json` gives the same data as the text. `brief` writes nothing
except the sync's own store writes, and neither it nor a refused or failed
launch changes `last-open.json`.

The opening has five parts, in this order:

1. **Yours (n)** — every for-martin item, blocking work first: a goal item that
   blocks later-phase goals of its programme sorts before one that blocks none,
   more blocking first; then oldest source time; then id. Each shows its
   reference, sort, reversible or not, id, source time and, when it blocks,
   how many later-phase goals of its programme wait on it. A due time within
   24 hours is shown with the closure it will cause by default. The brief is
   printed as written; a missing `brief.md` is named as missing.
2. **Decided without you** — decisions and defaults closed in the interval,
   grouped by programme and ordered by time, each with its summary and
   reference, then the count of items the source closed in the same interval.
3. **Not ready** — items still new or prepared: their count, the oldest with
   its age in hours from its source time, and those with a preparation or
   decision failure.
4. **Cost** — the desk's spend on the UTC day and over the last seven days
   (`desk-prepare`, `decision` and `learning` rows of `runs.tsv`; runs of unknown
   cost within those seven days are counted, not summed), and the daily ceiling
   or `off`.
5. **What the system changed** — from the lessons and the item store only (see
   *Lessons and the learning pass*). It never lists lessons or prints their text.

The interval is `(since, now]`, where `since` is the time of the last
successful opening, or the store's `first_sync_at` before the first opening.
Each launch that succeeds writes `~/mc/martin/last-open.json` as
`{ "at": <launch time> }`, after the session has started. A file that does not
hold a valid time refuses the launch with exit 1 and is not replaced by a
fresh history. An unattended launch is refused as before, with exit 2.

Phase gating means every unfinished goal of a programme waits for the phase
below it, so a phase-1 goal blocks each later-phase goal that is not finished
and whose GOAL.json parses. Goals of one phase block the same set and are
ordered by age.

## Read-only queue

`mc martin get [--all | --programme <programme> | --goal <programme>/<goal>]
[--json]` accepts at most one selector; no selector means all. It reads live
programme GOAL.json and LOG.md records, with no model, Git/provider process,
writes or worktree creation. Only parseable active goals with status `Martin`
are members; finished (`done`/`dropped`), archived, ready and blocked goals
are excluded. Invalid selectors fail; an existing selection with no queue
members succeeds with an explicit empty result. Malformed or unreadable
records are named with their source paths, not treated as resolved.

Ordering is by oldest current unresolved question, then `programme/goal` for
ties. The full pending question is read independently of the bounded last
three LOG entries. A later ready/resolved handoff prevents an older question
from returning. If a goal is set Martin without structured options, get shows the reason
recorded by the entry that set it, or by a later goal-defect or runner-stop
entry, and the missing-question limitation. It never
manufactures options or rewrites historical evidence.

Answered consultations (`jev was asked:`) leave the goal's status unchanged;
they are not unresolved questions and never supersede a pending `Martin is
asked:` record. Preserve the source writer's jev reading or failure verbatim,
including `mc ask`'s `mc: jev did not settle it:` format. Text includes the
full source question record and every populated Done/Comment/Next field of
each tail entry, just as JSON does; tail membership remains bounded to three.

Each item carries goal/contract/exclusions/criteria/documents, stage/status/
phase, current question/options/recommendation/jev reading or failure, last
three log entries and log/worktree/evidence paths. Each selected programme's
README is included once per programme; no `docs/project/` file is read. Text and JSON share stable ordering. Existing sessions
call `get` rather than starting another desk.

## Authority and decision synthesis

The role investigates each source question against relevant shared technical
contracts and the programme README and design. Details answered there are
resolved without escalation. A remaining choice for Martin, classified by the question contract in
[mc-jev.md](mc-jev.md), is presented only after synthesis, in the brief's parts
(what he would notice; the options as their consequences; one recommendation
and its reason; what waits; whether it can be changed afterwards; the material
paths for judgement; the exact act for a reserved one). When a standard
changes, the brief names its exact `docs/technical/` destination. The
original queue question/options/jev reading remain source evidence, distinct
from the synthesis. After Martin decides, record the canonical standard and
reconcile programme/goal text before returning or handing off work.

See [mc-roles.md](mc-roles.md) for launch ownership and [mc-goals.md](mc-goals.md)
for enforced mutation authority. Goal evidence, gate, review, publish and merge
lifecycle remain unchanged.

## Durable desk items

`~/mc/martin/items/<id>/item.json` is the model-free record shared by chores,
preparation, decisions and the interactive desk. Its schema is
`mc-desk-item` version 1; `id` is a stable digest of kind, reference and
`source_at`. Kinds are `goal` (`<programme>/<goal>`), `main-red`
(`main-red:<repo>/<id>`), `decision` (`decision:<at>`) and `lesson`
(`lesson:<name>`, written only by `mc martin lesson brief`, never by sync). A goal's source time
is the time of its current question: its newest structured ask (`Martin is asked:`), else its newest goal-defect or runner-stop entry (`goal defect:`, `no progress:`), else the entry that set it `Martin`. A later question is a distinct item; a later entry that only carries status `Martin` — an account, a takeover note, a criterion rewrite — is not a question, supersedes nothing and opens nothing.
Fields are `schema`, `version`, `id`, `kind`, `reference`, `source_at`,
`opened_at`, `state`, `sort`, `reversible`, `due_at` and `outcome`.

States are `new` → `prepared` → `for-martin` → `closed`, with `prepared` also
able to close directly. Sort is null or mechanical, technical, product,
judgement or reserved; reversible and due time are nullable. Closing records
`{by, at, summary}` where by is decision, martin, default or source, and, when a
close replaced a source closure, `replaced`. Sync opens
waiting goals and main-reds and flagged decided jev ledger rows once. A decided
row is flagged when jev's chosen key differs from the session recommendation
or its product reading is at least 0.70. Sync skips ledger rows older than the
store's first sync, closes open goal/main-red items
whose source no longer waits and, apart from the runner lock it holds, writes only
beneath the item store. It never
changes a source record. Missing, malformed or unreadable goal/main-red files
are reported and preserve the item: absence from the live queue alone is not
resolution. A goal closes only on a readable finished/non-Martin state or an
established later question; a main-red closes only on readable state showing
that its entry no longer waits. Chores syncs once each round.

A main-red item is answered at its source: `mc repo mend <repo> <id>
requeue|drop --reason "<text>"` ([`mc-merge.md`](mc-merge.md)). `mc martin item
<id> close`, with any `--by`, on a main-red item exits 2 with item.json unchanged
while the entry reads Martin or the state file is unreadable, and the message
names `mc repo mend`; after a requeue or drop the close succeeds, and a sync alone
closes by source. A main-red item's source time is the entry's `answered.at`, else
its `created`, so an answered entry that reaches Martin again opens a new item
with a different id and an unanswered one keeps its own.

`mc martin items [--state <state>] [--json]` syncs then lists open items before
closed ones, by oldest source time. Each label is recovered using the item's
source time and source history, including closed questions and runner reasons;
it is never borrowed from a later question on the same goal. Unavailable
history is shown explicitly. `mc martin item <id>` shows the complete
record, available live source and prepared/brief text. Writers are the person
and roles `martin`, `desk-prepare` and `decision`; desk-prepare may only prepare.
`prepared --sort <sort>` requires `prepared.md` and moves new to prepared.
`brief --sort product|judgement|reserved --reversible yes|no` requires
`brief.md`, moves prepared to for-martin and records a 48-hour due time only
when reversible; `--recommend <key>` also records the recommended option's key
as `recommend`, which must be an option of `brief.md` (a line `- <key>: its
consequence`). Closing `--by martin` an item that has a `recommend` requires
`--chose <key>`, an option of the brief, recorded as `chose`; `--chose` is
refused with any other `--by`. When he chose none of the brief's options (no
decision is needed, or the question is wrong), `close --by martin --no-option`
closes without `--chose`: it records no `chose` and writes no differing-answer
lesson. `--no-option` is a flag, not a reserved value of `--chose`, because
`none` is a valid option key; it is refused with `--chose` and with any `--by`
but `martin` (exit 2, nothing written), is judged on the record read under the
lock like `--chose`, applies to a close over a source closure too, and is
accepted on an item with no `recommend` as a plain close. The close of an item
that has a `recommend` with neither flag is refused naming both. `close --by decision|martin|default --summary <paragraph>`
(or `--summary-file`) closes prepared/for-martin; an item the source closed
after it was prepared or briefed (it has a sort) also takes
`close --by decision|martin|default`, which replaces the source outcome and
keeps it as `outcome.replaced`. Invalid transitions, roles, ids and missing
required files are refused with exit 2 and no write. Every write of an item and
of the store marker is a read-modify-write under the strict runner lock: a
transition is judged on the state read under the lock and refused when that
state no longer allows it. When the lock cannot be had nothing is written, and
an item verb, `mc martin items` and the opening (`mc martin brief`, `mc martin`)
end with exit 1 and the lock's message. Sync runs in one hold. `mc martin` launches the desk on the opening above;
`mc martin brief [--json]` prints it; the read-only `mc martin get` remains
unchanged.

## Unattended preparation

Each chores round, after item sync, prepares up to three `new` items in oldest
source-time order, one fresh headless turn at a time. `mc martin prepare [<id>]`
is the person's manual entry to the same pass (one named item, or up to three
waiting items). A per-item PID claim, acquired/released under the strict runner
lock, prevents simultaneous manual/chore preparations; a dead claim is reclaimed.
The turn stands in the item's directory, has `MC_ROLE=desk-prepare` and
`MC_HEADLESS=1`, and inherits no goal or programme identity. It has a fifteen-minute
wall-clock limit and uses only `routeClass('medium')`'s catalog candidates,
including their tool, model and effort, with the existing provider/billing rules.
No usable medium candidate means wait, never borrow another list. Quota endings
pause the runner as the intake drain does, before another preparation round.
Existing headless restrictions in [mc-hooks.md](mc-hooks.md) apply unchanged.

`canon/roles/desk-prepare.md` gathers the item, goal and whole log, named
documents, programme README and relevant technical contracts. `prepared.md`
contains the ask/stop in two sentences, sourced facts, existing rules, the
sort and its reason, visual evidence paths from `mc shot` when applicable,
and anything not established. It makes no recommendation or decision, asks
nobody, and changes no goal, log, ledger or repository file. Goal verbs refuse
every write for this role (including criteria, PRs and creation); `mc ask` and
`mc goal martin` refuse before consulting jev. Its only item mutation is
`prepared --sort mechanical|technical|product|judgement|reserved`. A goal
defect is sorted `technical`, a no-progress stop `mechanical`.

A completed turn that left the item `new` appends `{at, reason}` to the item's
`prepare_failures` array (absent before any failure). Exit without the prepared
verb, thrown session errors and timeouts all count. After two failures the
runner writes a `prepared.md` containing only that preparation failed twice
and the recorded reasons, and sets `prepared` with sort `mechanical`, so the
decision pass can still take it. No launch because of capacity, ceiling or an
existing claim is not a failed attempt. Every started turn adds a `runs.tsv`
row of kind `desk-prepare`, named by item id, with routing, usage and cost.

## Daily unattended desk ceiling

`~/mc/runner/desk.json` holds `ceiling_usd_per_day`: `null` by default. An absent
file is also off. `mc martin ceiling` prints the setting and today's desk sum;
`mc martin ceiling <usd>` sets a non-negative finite USD amount, and
`mc martin ceiling off` writes null. Only a person may change the setting.
There is no implicit ceiling or held work while it is off.

`desk-budget.js` is the shared admission reading for both unattended desk
passes: preparation, the decision pass and the learning pass. It sums today's UTC
`runs.tsv` `cost` values for `desk-prepare`, `decision` and `learning` only; other days/kinds and unknown
costs (`-`) do not contribute. Before each turn it rereads the setting and sum.
When the setting is non-null and the sum is at least it, no desk turn starts;
the chores pass explains the hold once in that round. Already running turns
are not interrupted and a turn can take the day's cost over the ceiling.
An unreadable/invalid setting holds preparation with an explicit error, rather
than silently disabling a ceiling. Decision admission uses the same reading and refuses invalid settings too.


## Unattended decision pass

`mc decision [<id>]` is a person's one-session entrance, refused inside a
session. No id takes the oldest prepared item; no prepared item prints that
fact and exits 0. An explicit id may also name an eligible due brief. It uses
exactly the runner's decision launch and prints the outcome and new state.

The runner supplies every `prepared` item and every overdue reversible
`for-martin` product or judgement item as lane work, behind merge-failure and
main-red mend and ahead of finish, review, build and planning. The `decision`
list defaults to `claude:fable:high`, then `codex:gpt-6.1-sol:high`; old catalogs
without it read these defaults without rewriting the file. Its first usable
subscription candidate wins in catalog order (including unknown-Claude
bootstrap); if none can run, existing API-reserve admission applies. It never
borrows another list. No cost ceiling exists unless Martin sets one.

A session has `MC_ROLE=decision`, `MC_HEADLESS=1` and the canon decision role's
instructions, the usual watch/check-in, scratch and session logs. A goal item
stands in its first repository worktree, made by ordinary goal allocation if
absent, with `MC_GOAL` and programme identity. Other items stand in their item
directory without goal identity. Every session writes a `runs.tsv` row of kind
`decision`, named by item id, including usage and cost. Goal claims and current
files exclude other sessions on that goal; a short lock and live-PID
`.decision.json` claim in the goal directory (or non-goal item directory) also
exclude concurrent manual decision launches. The claim is removed on exit.

The role reads prepared evidence, the live source, the whole goal log,
worktree and stage instructions, records takeover and tests the question's
frame before answering it. It may finish, rewrite or drop the goal with the
desk's authority; acceptance checks, independent review, gate, publication
and merge remain mandatory. Only the merger marks done. Martin's interactive
role remains refused unattended. Headless deploy, admin override, production
data and credential hooks still apply to decision sessions.

Only three kinds reach Martin: an unanswered product direction changing user
promises, product cost, personal-data handling or test strategy; a judgement
(look, listen, try); or a reserved act. Everything technical is decided by the
goal, standards, app patterns and established practice, even a privacy,
security or cost question labelled policy. Required admin audit records are
one such established practice: inability to write the audit record does not
justify proceeding without it (Martin, 2026-11-14). One root cause across items
is one decision applied to each, not repeated questions. No budget, allocation,
exception or new rule is added without measured need.

Settled work is carried out or handed to the appropriate goal stage, then
closed `--by decision` with a two- or three-sentence Swedish summary; a sync that
closed the item by source in between does not prevent that close. What is
Martin's gets `brief.md` in Swedish, with only: what the user would notice;
options as consequences; one recommendation and reason; what waits; whether
it can be changed afterwards; for a judgement, material paths; for a reserved
act, the exact act and its effects. `brief --sort … --reversible yes|no` leaves
the goal in `Martin`. Only reversible product/judgement briefs past `due_at`
are picked for default execution: carry out the recommendation as if chosen
and close `--by default`. Irreversible and reserved items never default,
even if a reserved record erroneously says reversible and has a due date.

A goal defect (`goal defect: <part> — <found>`, reported by a build, review or
finish session) is `technical`; a stop for no progress (`no progress: …`, the
runner after three build sessions that committed nothing and met no criterion)
is `mechanical`. Preparation names the sort; the decision verifies the claim,
amends the goal with the verbs, records it and sets it ready with
`mc goal ready`. An amendment that changes what users are promised is a brief
for Martin. A second defect or stop on a goal whose text has not been amended
since the one before is briefed for Martin and the goal is not set ready again
(the bound on a report that does not hold coming back); so is a second one on
text the desk already amended. An item's label is the first
line of the `Martin` entry of its minute, so a defect is never shown under
another entry that shares the minute.

A session ending without closing or briefing appends `{at, reason, state}` to
`decision_failures`, `state` being the state the item was in when the session
failed; an entry without `state` was written while prepared and counts as
`prepared`. The entry is appended under the runner lock, and the list is never
shortened. An unchanged overdue brief also counts as unfinished. The limit is
two failures in the item's current state: after one, the item is eligible once
more, and a failure in another state (a prepared item briefed reversible and
then due) starts that state's own count. After the second in the current state,
the runner writes a Swedish failure brief with every reason and session log
path, sets `for-martin`, sort `mechanical`, `reversible: false`, `due_at: null`,
and keeps the goal waiting on Martin. A quota ending, an offline ending, and a
login ending that refused the provider (a launch that is not codex, on
subscription billing) write no failure and no goal entry, and spend no attempt:
the item is taken again when the provider answers. Admission refusals spend no
attempt. The runner's existing mechanical `Martin` settings are unchanged; the
pass handles what they leave rather than moving their ownership into the runner.

## Lessons and the learning pass

Learning has happened only when one of three things has changed on main: the
code of how mc works (`src/mc/`), the prompts of the sessions (`canon/`), or a
technical standard (`docs/technical/` of memoro-cli or memoro) (Martin,
2026-11-14). A lesson is the input to that, never the result: it is general form
of what a missing or wrong rule looked like, and it leaves the list only by
landing a change or by a dismissal with a reason. mc never deletes a lesson.

**Store.** A lesson is `~/mc/martin/lessons/<date>-<slug>.md` (`desk-lessons.js`):
a header, then exactly three parts, `## What happened`, `## The rule` and
`## Where the change belongs`. Header fields: `kind` (`not-martins`,
`wrong-question`, `answer-differs`, `overturned`, `review-finding`, `unsettled`,
`repeat`), `item` (a desk item id or `<programme>/<goal>`), `programme`, `state`
(`open`, `in-goal`, `landed`, `dismissed`), `goal` (the goal that carries it, or
null), `pr` (the pull request that landed it, as `repo#n`, or null), `place`
(the file the change belongs in; its place is `code` under `src/`, `prompt`
under `canon/`, `standard` under `docs/technical/`), `at`, `by`, `carried_at`,
`landed_at`, `dismissed_at`, `reason` and `repeat_of` (the pull request of an
earlier landed lesson of the same kind and place, computed on `add`, and on
`carry` when it sets the place of a lesson that has no `repeat_of`; the lesson's
first part then says that change did not work, once).

**Verbs.** `mc martin lesson add --kind <kind> [--item] [--programme] [--place]
--file <path|->` writes an open lesson; `lessons [--state] [--json]` lists them
(`<name> · <kind> · <state> · <goal or "no goal"> [· <pr>] · <n> days`); `lesson carry <name>
--goal <programme>/<goal>` moves an open lesson to `in-goal` and needs a live
goal; `lesson dismiss <name> --reason "…"` moves an open lesson to `dismissed`
and needs a reason from every role; `lesson brief <name> --file <path|->` is for
a lesson that contradicts a dated decision of Martin's: it writes an item of
kind `lesson`, sort `product`, not reversible (so it waits without limit and no
default carries it out), with that Swedish brief, and dismisses the lesson with
the item as its reason. Writers: a person and the roles `martin`, `decision` and
`learning` for every verb; `review-session:goal` for `add` only. Any other role
is refused with exit 2 and nothing is written. **No verb sets `landed`.**
`reconcileLessons` is the only way: each chores round the runner reads every
goal (the archive included); an `in-goal` lesson whose goal is `done` becomes
`landed` with the goal's last registered pull request and the time, and one
whose goal was `dropped` becomes `open` again with no goal. A goal that cannot
be found leaves its lessons where they are.

**Where they arise.** (1) `not-martins` and `wrong-question`: the interactive
desk records them when Martin says so; the decision pass records the same for an
item it finds should never have reached him. (2) `answer-differs`: written by
`close --by martin --chose <key>` when `recommend` and `chose` differ, before
the item closes, naming the item and both options' text from `brief.md`; a close
that matches leaves none, as does `--no-option`, and a lesson that cannot be
written leaves the item open. (3) `overturned`: the interactive desk, when Martin overturns something
decided without him or a rule the learning pass landed. (4) `review-finding`:
the review session, for a session's technical decision it finds wrong.
(5) `unsettled`: the runner, when the decision pass has failed on an item twice
and gives it to Martin (`decision_failures`); one per item. (6) `repeat`: the
learning pass, for three or more items within thirty days whose preparation names
the same rule.

**The pass.** Each chores round, after preparation, `runLearningPass`
(`desk-learning.js`) starts one session when it is due: five or more lessons are
`open`, or the oldest open lesson is seven days old. It starts none when it
already started one on the UTC day (`~/mc/runner/learning.json`, written when a
session starts, so a crashed one counts), none while the desk ceiling is set and
reached, and none without a usable first `decision` candidate (`routeClass`,
never another list). The session has `MC_ROLE=learning`, `MC_HEADLESS=1`, the
canon role `canon/roles/learning.md`, stands in `~/mc/martin/lessons/`, has a
sixty-minute limit and writes a `runs.tsv` row of kind `learning` named
`learning` (class `decision`). Quota endings pause the runner as the other desk
passes do.

**Authority.** The learning role may read, create goals (`mc goal new`), write
the ones it created in this session (`set`, `document add`, `criterion add`,
`item add|set|remove` and `obligation set|remove`) and
move such a goal from `draft` to `build` (`stage <programme>/<goal> build`). A
goal was created in this session when its first LOG.md entry is by role
`learning` from a session tool and is stamped no earlier than the minute
`MC_SESSION_STARTED` names. Every other verb, and every verb on another goal,
is refused with exit 2 and changes nothing; the role writes no programme README
and no file in a repository. The role never starts another session and runs no
reserved act. It may dismiss at most one lesson in five of those it was given
(the open ones plus those it carried or dismissed since its session started).

**Figures.** Computed by `buildChanges` from the item store and the lessons,
without a model. The part shows: each change landed since the last opening, as
one line (the goal's title, where — code, prompt or standard — and its pull
request; lessons landed by one goal and pull request are one line); then counts
only: lessons `open` and `in-goal`, with the age in days of the oldest of each;
a lesson `open` or `in-goal` for more than fourteen days, named as late; the
lessons dismissed since the last opening, with their reasons. Then four
weeks, oldest first, each week `(now − 7(w+1) days, now − 7w days]` and each
with five numbers: items opened (`opened_at` in the week); the share of them
that reached Martin (state `for-martin`, or closed by `martin` or `default`); of
those, the share with a `not-martins` or `wrong-question` lesson naming the item;
the `overturned` lessons recorded in the week; and the lessons recorded in the
week that repeat a lesson of the same kind and place that had already landed
(the change did not work). A share with no denominator is `-`.
