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

The opening's data is built in `src/mc/desk-opening.js`, with no sync, lock or
writer: texts, acts, stuck, not ready, decided and cost, each by one function,
and the reading of `last-open.json`. `martin.js` re-exports them, and what the
opening shows is unchanged. The page's DESK section ([mc-ui.md](mc-ui.md#desk))
calls the same functions, so it reads the same texts, acts, decided, not ready
and cost from the store as the last sync left it. The page runs no sync, takes
no lock and writes nothing. The module also holds the page's ledger reader,
`ledgerAsks`, which the opening does not use. The decided row's asks come from
the jev ledger, `decisions.jsonl`. Whether an ask went against the asking
session's recommendation follows `mc decisions`: an `answered` row takes jev's
choice and a `decided` row takes the recommendation.

The opening has these parts, in this order (Horizons only when the desk holds one):

1. **Horizons** — present only when the horizon store holds a horizon or a
   record that cannot be read (*Horizons*, below); a desk that holds none opens
   without the part. It shows the horizons reached in the interval, oldest first,
   each with its title, slug, time, who marked it and the first three non-empty
   lines of what is now true, then the open ones in order, numbered, each with
   title and slug (the line `No horizon is open.` when none is), and in its last
   line the records that cannot be read. It comes first, after the intro line:
   what he works toward frames what he is asked.
2. **Proposed changes to your texts (n)** — every for-martin item of sort `text`
   (the old sorts `product` and `judgement` read as `text`), blocking work first:
   one that blocks goals of its programme that wait for it sorts before one that
   blocks none, more blocking first; then oldest source time; then id. Each shows
   the text it changes, its id, the time it has waited, its goal or `no goal`
   and, when it blocks, how many goals of its programme wait on it (`blocks <n>
   later-phase goals of <programme>`; for a programme whose record states its
   phases `blocks <n> goals of <programme> whose phases wait for it`). The brief
   is printed as written, in the form below; a missing `brief.md` is named as
   missing. No time is shown that a clock will act on: none does.
3. **Your acts (n)** — every for-martin item of sort `reserved`, in the same order
   and with the same lines: the act only he may do, and its effects.
4. **Decided without you** — decisions closed in the interval (and, in a store
   written before this change, defaults), grouped by programme and ordered by
   time, each with its summary and reference, then the count of items the source
   closed in the same interval.
5. **Not ready** — items still new or prepared: their count, the oldest with
   its age in hours from its source time, and those with a preparation or
   decision failure; then the items the decision pass gave up on (a for-martin
   item that is neither a text change nor an act), as a stuck list by reference.
   They are the runner's, not his, and are not listed above.
6. **Cost** — the desk's spend on the UTC day and over the last seven days
   (`desk-prepare`, `decision` and `learning` rows of `runs.tsv`; runs of unknown
   cost within those seven days are counted, not summed), and the daily ceiling
   or `off`.
7. **What the system changed** — from the lessons and the item store only (see
   *Lessons and the learning pass*). It never lists lessons or prints their text.

`brief --json` carries `texts`, `acts` and `not_ready.stuck` for these parts, and no
`yours`.

The interval is `(since, now]`, where `since` is the time of the last
successful opening, or the store's `first_sync_at` before the first opening.
Each launch that succeeds writes `~/mc/martin/last-open.json` as
`{ "at": <launch time> }`, after the session has started. A file that does not
hold a valid time refuses the launch with exit 1 and is not replaced by a
fresh history. An unattended launch is refused as before, with exit 2.

In a sequential programme every unfinished goal waits for the phase below it,
so a phase-1 goal blocks each later-phase goal that is not finished and whose
GOAL.json parses. In a programme whose record states its phases a goal blocks
the unfinished goals (whose GOAL.json parses) of the phases that wait for its
phase, directly or through other phases; a phase that waits for none is blocked
by nothing, and a programme whose record is invalid counts none (`laterPhaseGoals`,
by the rule of `phaseStanding`, [mc-goals.md](mc-goals.md#phases)). Goals of one
phase block the same set and are ordered by age.

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
resolved without escalation. What remains for Martin, either a proposed change to a text he holds or an act only he may do, as
[canon/tasks/asking-martin.md](../../canon/tasks/asking-martin.md) names it and
[mc-jev.md](mc-jev.md) routes it by kind, is presented only after synthesis. For a `reserved` act, and for the decision
failure's mechanical brief, the brief's parts are what he would notice; the
options as their consequences; one recommendation and its reason; what waits;
whether it can be changed afterwards; the exact act. A change to a text he holds is not
presented in those parts: it is brought in the form of *Durable desk items*
(three parts, no options). When a standard
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
(`main-red:<repo>/<id>`), `decision` (`decision:<at>`), `lesson`
(`lesson:<name>`, written only by `mc martin lesson brief`, never by sync), `text`
(`text:<the text>`, written only by `mc martin propose`, never by sync) and `programme` (`programme:<programme>`, written only by the runner when a programme's planning turn has failed twice; see below) and `manager` (`manager:<slug>`, written only by the runner when a horizon turn of the manager has failed twice; see below) and `archive` (`archive:<programme>`, written only by the runner when a finished programme's write-back reading found a gap, failed twice or found restricted data; see below). A goal's source time
is the time of its current question: its newest structured ask (`Martin is asked:`), else its newest goal-defect or runner-stop entry (`goal defect:`, `no progress:`), else the entry that set it `Martin`. A later question is a distinct item; a later entry that only carries status `Martin` — an account, a takeover note, a criterion rewrite — is not a question, supersedes nothing and opens nothing. A `decision:<at>` item opens for a new ledger row of `mc ask` whose chosen key differs from the recommendation and for every unread row (`answered_by: "session"`), with the answer's who and why ([mc-jev.md](mc-jev.md), *The ledger*).
Fields are `schema`, `version`, `id`, `kind`, `reference`, `source_at`,
`opened_at`, `state`, `sort`, `reversible`, `due_at` and `outcome`; a text item
also has `text` (the text it changes) and `goal` (the goal it blocks, or null).
`due_at` is always null in a record written now: no time acts on an item. A record
written before this change that holds a due time or `default` as the closer still
reads, lists and opens.

States are `new` → `prepared` → `for-martin` → `closed`, with `prepared` also
able to close directly. Sort is null or mechanical, technical, text or reserved
(`product` and `judgement` are the old names of `text` and are read as such, never
written); reversible and due time are nullable. Closing records
`{by, at, summary}` where by is decision, martin or source (`default` only in a
record written before this change), and, when a
close replaced a source closure, `replaced`. Sync opens
waiting goals and main-reds and flagged decided jev ledger rows once. A decided
row is flagged when jev's chosen key differs from the session recommendation
or its product reading is at least 0.70. Sync skips ledger rows older than the
store's first sync, closes open goal/main-red items
whose source no longer waits and, apart from the runner lock it holds, writes only
beneath the item store. It never
changes a source record, and it never opens, changes or closes a text item: that
item has no source, and only a close ends it. Missing, malformed or unreadable goal/main-red files
are reported and preserve the item: absence from the live queue alone is not
resolution. One absence is resolution: a goal whose directory has left `goals/` and stands in the programme's `goals/.archive/` with a readable `done` or `dropped` state closes its item by source, with that state and the drop's reason as the outcome. A goal otherwise closes only on a readable finished/non-Martin state or an
established later question; a main-red closes only on readable state showing
that its entry no longer waits. Chores syncs once each round.

A `programme` item is the programme planning turn's second failure
([mc-run.md](mc-run.md#programme-planning-turn)): the first is `prepared` with a
model-free `prepared.md`, a later one `for-martin` (sort mechanical, not
reversible, no due time) with a Swedish `brief.md`. Its source is the
programme's record, directory and goals, and the turn's state file
`runner/programme-turn/<programme>.json`. Sync closes it by source when the
programme holds a goal, its record no longer reads valid and `open`, or its
directory is gone; an unreadable state file is reported and keeps it open (an
unreadable record reads invalid and closes it). A decision session answers it at its source: it repairs what failed within
reach and closes it `--by decision`, so the runner plans again, and a text of
Martin's that would have to change goes to a brief. The opening lists one decided
under the programme's name, and a `for-martin` one, being mechanical, among the
stuck items of **Not ready**: it is the runner's, not his.

An `archive` item is the programme archive turn's
([mc-run.md](mc-run.md#programme-archive-turn)); its reference is
`archive:<programme>` and one is open at a time per programme. A NOT OK reading
opens it `prepared` (sort mechanical) with a model-free `prepared.md` carrying
the NOT OK lines; a NOT OK after an item was closed by decision, and the second
failure since the last item, open it `for-martin` (sort mechanical, not
reversible, no due time) with a Swedish `brief.md`; restricted data under
`~/mc/restricted/<programme>/` opens one `for-martin` with sort `reserved`
naming `mc plan <programme> --archive`. Its source is the programme's directory
and goals and the state file `runner/archive-turn/<programme>.json`. Sync closes
it by source only when the programme directory is gone from the programmes home or
`goals/` holds a live goal; an unreadable state file is reported and keeps it
open. A decision session answers a prepared one at its source (writes the missing
statement within reach) and closes it `--by decision`, so the runner reads again;
it never archives the programme. A `for-martin` mechanical one is among the stuck
items of **Not ready**, like a `programme` item; a reserved one is his.

A `manager` item is the manager's horizon turn's second failure since its last
item ([mc-run.md](mc-run.md#the-managers-turns)): the first is `prepared` with a
model-free `prepared.md`, a later one `for-martin` (sort mechanical, not
reversible, no due time) with a Swedish `brief.md` under the five headings.
Its reference is `manager:<slug>` of the open horizon; its source is the horizon,
the open programme records that name it and the turn's state file
`runner/manager-turn/horizon/<slug>.json`. Sync closes it by source when the horizon is
no longer open, a valid open programme record names it or the text item
`horizon:<slug>` is open; an unreadable state
file is reported and keeps it open. A decision session answers it at its source
and closes it `--by decision`, so the runner takes the turn again. A curation
turn that fails opens no item. The opening lists a `for-martin` one among the
stuck items of **Not ready**, like a `programme` item: it is the runner's, not
his.

A main-red item is answered at its source: `mc repo mend <repo> <id>
requeue|drop --reason "<text>"` ([`mc-merge.md`](mc-merge.md)). `mc martin item
<id> close`, with any `--by`, on a main-red item exits 2 with item.json unchanged
while the entry reads Martin or the state file is unreadable, and the message
names `mc repo mend`; after a requeue or drop the close succeeds, and a sync alone
closes by source. A main-red item's source time is the entry's `answered.at`, else
its `created`, so an answered entry that reaches Martin again opens a new item
with a different id and an unanswered one keeps its own.

**A proposed change to a text he holds.** A text is a file and its section
(`canon/roles/martin.md#Authority`), a horizon (`horizon:<slug>`), or a place where
a dated decision of his is recorded. Its brief is exactly three non-empty `##`
parts, in this order, in Swedish, because what is written to him is:

```
## Vad den säger
## Vad som föreslås
## Vad som hittades
```

what the text says now, the wording proposed, and what was found that makes the
change worth his reading. No part holds options, and none holds a recommendation:
he answers a proposal by reading the wording and saying so, not by choosing a key.
An extra part, a missing or repeated part, a part out of order and an empty part
each refuse the brief, naming it. One function (`textForm`, `desk-texts.js`) judges
the form for all three ways of bringing one.

`mc martin propose --text '<the text>' --file <path|-> [--goal <programme>/<goal>]`
writes an item of kind `text`, sort `text`, state `for-martin`, `reversible` and
`due_at` null, with the brief as `brief.md`, in one hold of the strict runner lock,
and prints its id. `--text` is one line. `--goal` names a readable goal whose later
phases wait for the change; with none, the item blocks nothing. The same open text
with the same "Vad som föreslås" part (whitespace aside) is not written again: the
verb prints the existing id and exits 0; an open duplicate that names no goal
takes the caller's goal, so a second goal's `mc ask` that finds the same text is
recorded against the item (`other_goal` in the ledger row, [mc-jev.md](mc-jev.md)). A brief not in the form, a missing or
multi-line `--text`, an unreadable file, an unreadable `--goal` and a role that
may not propose (`desk-prepare` only prepares) are refused with exit 2 and nothing
written; a lock that cannot be had is exit 1 with its message. Every other role,
a person included, may propose. The decision pass brings one with `brief --sort
text --text '<the text>' --reversible yes|no`, and `mc martin lesson brief` (below)
the third way.

`mc martin items [--state <state>] [--json]` syncs then lists open items before
closed ones, by oldest source time. For the learning role it lists without syncing, takes no lock and writes nothing. Each label is recovered using the item's
source time and source history, including closed questions and runner reasons;
it is never borrowed from a later question on the same goal. Unavailable
history is shown explicitly. `mc martin item <id>` shows the complete
record, available live source and prepared/brief text. Writers are the person
and roles `martin`, `desk-prepare` and `decision`; desk-prepare may only prepare.
`propose` is open to every role but `desk-prepare`.
`prepared --sort <sort>` requires `prepared.md` and moves new to prepared;
`product` and `judgement` are accepted and recorded as `text`.
`brief --sort text|reserved --reversible yes|no` requires
`brief.md`, moves prepared to for-martin and records no due time. `brief --sort
text` also requires `--text '<the text>'` and the form above and refuses
`--recommend`; a `reserved` brief may name `--recommend <key>`, recorded as
`recommend`, which must be an option of `brief.md` (a line `- <key>: its
consequence`). A `brief --sort product|judgement` is read as `text`. Closing `--by martin` an item that has a `recommend` requires
`--chose <key>`, an option of the brief, recorded as `chose`; `--chose` is
refused with any other `--by`. When he chose none of the brief's options (no
decision is needed, or the question is wrong), `close --by martin --no-option`
closes without `--chose`: it records no `chose` and writes no differing-answer
lesson. `--no-option` is a flag, not a reserved value of `--chose`, because
`none` is a valid option key; it is refused with `--chose` and with any `--by`
but `martin` (exit 2, nothing written), is judged on the record read under the
lock like `--chose`, applies to a close over a source closure too, and is
accepted on an item with no `recommend` as a plain close. The close of an item
that has a `recommend` with neither flag is refused naming both. `close --by decision|martin --summary <paragraph>`
(or `--summary-file`) closes prepared/for-martin; `close --by default` is refused
(exit 2, nothing written): no clock carries out a brief. An item the source closed
after it was prepared or briefed (it has a sort) also takes
`close --by decision|martin`, which replaces the source outcome and
keeps it as `outcome.replaced`. Invalid transitions, roles, ids and missing
required files are refused with exit 2 and no write. Every write of an item and
of the store marker is a read-modify-write under the strict runner lock: a
transition is judged on the state read under the lock and refused when that
state no longer allows it. When the lock cannot be had nothing is written, and
an item verb, `mc martin items` for a desk writer and the opening (`mc martin brief`, `mc martin`)
end with exit 1 and the lock's message. Sync runs in one hold. `mc martin` launches the desk on the opening above;
`mc martin brief [--json]` prints it; the read-only `mc martin get` remains
unchanged.

## Horizons

A horizon is what Martin has decided is worked toward. The desk keeps a standing
list of them, each with its playback; the order of the open ones is the
priority. Everything stored in a horizon is English text.

**Store.** `~/mc/martin/horizons/<slug>/` holds three files: `horizon.json` (the
record), `playback.md` (written by `set`) and `reached.md` (what is now true for
the user, written by `reached`). A slug is `[a-z0-9][a-z0-9-]{0,63}` and is not
reused: a directory whose `horizon.json` can be read, in any state, holds the
slug. The record is `{ schema: "mc-desk-horizon", version: 1, slug, title, state,
position, set_at, set_by, reached_at, reached_by, reopened_at, reopened_by,
reopen_reason, dropped_at, dropped_by, drop_reason }`; a field that does not apply
is `null`. Times are ISO times; the `_by` fields hold the writer's role.

**Playback.** `playback.md` has exactly five `## ` headings, in this order, each
with text: `How it is read`, `How one sees it is reached`, `What is built first`,
`What is not built`, `The strangest thing the wording permits`. `show --json` gives
them as `playback` with the keys `read`, `reached`, `first`, `not_built` and
`strangest`, and the text of `reached.md` as `now_true`, which is `null` unless
the state is `reached`.

**States.** `set` makes an `open` horizon. `reached` takes an open one to
`reached`, writes `reached.md` and sets `reached_at` and `reached_by`. `reopen`
takes a reached one back to `open`: it sets `reopened_at`, `reopened_by` and
`reopen_reason` and clears `reached_at` and `reached_by`; `reached.md` stays on
disk, is not shown while the horizon is open, and is replaced by the next
`reached`. `drop` takes an open one to `dropped` and sets `dropped_at`,
`dropped_by` and `drop_reason`. Every other transition is refused, and nothing is
ever deleted: a dropped or reached horizon keeps its directory and files.

**Order.** Open horizons hold the whole numbers `1..n` in `position`; a reached or
dropped one holds `null`. `--position` defaults to last; on `set` and `reopen` it
must be `1..n+1` (n being the open horizons before the write) and on `move`
`1..n`. A write that changes the open set or its order renumbers the open ones
`1..n` in the same hold. Readers order by `position`, then `set_at`, then slug, so
an interrupted write still has one order.

**Verbs.** A title is one non-empty line; a reason is non-empty and stored as one
line, with its whitespace collapsed. `--file -` reads standard input.

| Verb | stdout |
| --- | --- |
| `mc martin horizon set <slug> --title <t> --file <path\|-> [--position <n>]` | `<slug> · open · <position>` |
| `mc martin horizon show <slug> [--json]` | the horizon as text, or its record with `playback` and `now_true` |
| `mc martin horizon move <slug> --position <n>` | `<slug> · open · <position>` |
| `mc martin horizon reached <slug> --file <path\|->` | `<slug> · reached` |
| `mc martin horizon reopen <slug> --reason <t> [--position <n>]` | `<slug> · open · <position>` |
| `mc martin horizon drop <slug> --reason <t>` | `<slug> · dropped` |
| `mc martin horizons [--state open\|reached\|dropped] [--json]` | one line per horizon, or the records as a JSON list |

A list line is `<slug> · <state> · <position or -> · <title>`: the open ones
first, in order, then the reached ones newest first, then the dropped ones
newest first. `--state` selects one state; any other value exits 2. `set` writes
`playback.md` before the record and `reached` writes `reached.md` before the
record, so a record never points at a missing file.

**Who may write.** The role is `MC_ROLE`, else `session` when `MC_TOOL` names a
tool other than `person`, else the session's identity, else `person`. `set`,
`move`, `reopen` and `drop` are open to the interactive `martin` and to a
`person`, without `MC_HEADLESS=1`. `reached` is open to the same callers and
also to the `manager` with `MC_HEADLESS=1`; there is no interactive manager. Every other caller, every unknown role and every
caller with `MC_HEADLESS=1` (the manager on `reached` aside) is refused. The role
is judged before the arguments. `horizons` and `horizon show` are open to every
caller. Nothing else in mc sets a horizon: no runner pass, no hook, no other verb.

**Exit codes and the lock.** 0 on success; 2 on a refusal (unknown verb, flag,
slug or state, a role, a playback with missing or empty parts, a transition not
allowed, a position out of range), with one `mc:` line on standard error and
nothing written; 1 when the lock cannot be had (`the runner lock is held by pid
<n> — try again`), with nothing written. Each write verb is one read-modify-write
under the strict runner lock: the records are read inside the hold and the
transition is judged on what was read there. Reads take no lock.

**Records that cannot be read.** A `horizon.json` that exists but does not parse or
does not hold the schema, the slug of its directory and a known state is never
overwritten, renumbered or removed: `set` on that slug is refused, `horizons`
prints one `mc:` line on standard error naming it and still exits 0, and the
opening names it in the last line of its part. A directory with no `horizon.json`
holds no horizon (an interrupted `set`): `set` goes on and replaces the leftover
`playback.md`.

**The opening.** See *Opening*. The data under `brief --json` is
`horizons: { reached: [{ slug, title, reached_at, reached_by, first_lines }],
open: [{ slug, title, position }], unreadable: [<directory names>] }`, present
only when the store holds a horizon or an unreadable record. Reached horizons are
those with `reached_at` in `(since, now]`, oldest first.

**What does not read horizons.** The runner's pick, `PRIORITY.json`, `mc programs`
and the page do not read horizons: the order of the horizons does not change
which programme the runner works on. The one reader besides the desk is the
manager's horizon turn, which takes the open horizons in position order and
creates the next programme of the first that has none ([mc-run.md](mc-run.md#the-managers-turns)).

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
every write for this role (including criteria, PRs and creation); `mc ask` refuses before consulting jev
(`mc goal martin` is gone). Its only item mutation is
`prepared --sort mechanical|technical|text|reserved`. A goal
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
fact and exits 0. An explicit id names a prepared item. It uses
exactly the runner's decision launch and prints the outcome and new state.

The runner supplies every `prepared` item, oldest source first, as lane work; no
`for-martin` item is ever lane work, however long it has waited, behind merge-failure and
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

What reaches Martin is the rule in
[canon/tasks/asking-martin.md](../../canon/tasks/asking-martin.md). Everything
else is decided by the goal, standards, app patterns and established practice,
even a privacy, security or cost question labelled policy. Required admin audit records are
one such established practice: inability to write the audit record does not
justify proceeding without it (Martin, 2026-11-14). One root cause across items
is one decision applied to each, not repeated questions. No budget, allocation,
exception or new rule is added without measured need.

No clock changes anything on the desk. A brief waits for Martin without limit; nothing
carries out its recommendation, closes it or moves it after a time, and the
decision pass takes `prepared` items only. A horizon is recorded and shown in the opening
(*Horizons*); a change to a text he holds is brought in the form above; and a
change with no goal reaches the desk by `mc martin propose`, which the
reader of an `mc ask` call that finds a text of Martin's would change
runs for the asker ([mc-jev.md](mc-jev.md)); the asker continues inside the
wording that stands.

Settled work is carried out or handed to the appropriate goal stage, then
closed `--by decision` with a two- or three-sentence Swedish summary; a sync that
closed the item by source in between does not prevent that close. What is
Martin's is written to `brief.md` in Swedish: a change to a text he holds in the
form above, marked `brief --sort text --text '<the text>' --reversible yes|no`
(it carries no options and no recommendation), and a reserved act with what he
would notice, the options as consequences, one recommendation and reason, what waits, whether it can be
changed afterwards, and the exact act and its effects. `brief --sort … --reversible yes|no` leaves
the goal in `Martin`.

A goal defect (`goal defect: <part> — <found>`, reported by a build, review or
finish session) is `technical`; a stop for no progress (`no progress: …`, the
runner after three build sessions that committed nothing and met no criterion)
is `mechanical`. Preparation names the sort; the decision verifies the claim,
amends the goal with the verbs, records it and sets it ready with
`mc goal ready`. An amendment that would change a text Martin holds is a brief
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
shortened. The limit is
two failures in the item's current state: after one, the item is eligible once
more, and a failure in another state starts that state's own count (an entry of a
state the pass no longer works in, such as a for-martin brief that was once overdue,
counts for that state only). After the second in the current state,
the runner writes a Swedish failure brief with every reason and session log
path, sets `for-martin`, sort `mechanical`, `reversible: false`, `due_at: null`,
and keeps the goal waiting on Martin. Such an item is the runner's stop, not a
proposal: the opening lists it only as stuck, under *Not ready*. A quota ending, an offline ending, and a
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
and needs a reason from every role; `lesson brief <name> --text '<the text>' --file <path|->` is for
a lesson that contradicts a dated decision of Martin's: it writes an item of
kind `lesson`, sort `text`, with the brief in the form above (exactly the three
Swedish parts; a brief not in it is refused with exit 2 and the lesson left open),
and dismisses the lesson with the item as its reason. Writers: a person and the roles `martin`, `decision` and
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
that reached Martin (state `for-martin`, or closed by `martin`, or in an older store `default`); of
those, the share with a `not-martins` or `wrong-question` lesson naming the item;
the `overturned` lessons recorded in the week; and the lessons recorded in the
week that repeat a lesson of the same kind and place that had already landed
(the change did not work). A share with no denominator is `-`.
