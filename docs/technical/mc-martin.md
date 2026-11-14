# `mc martin` — current decision queue

Linux SSH interactive launches keep their provider alive past the terminal ([Claude background session or Codex app-server](mc-interactive-sessions.md)); macOS retains the existing foreground terminal.

`mc martin` is Martin's foreground interactive decision desk in
`~/mc/martin/`. It has a distinct owner and conversation identity. `--new`,
`--resume [id]`, `--codex`/`--claude` and `--model` follow `openInWorkArea`;
there is no headless form and the runner never launches it. A resumed
conversation receives fresh queue context as a reply, not stale remembered
goals. Launch does not make per-goal checkouts.

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
from returning. If a runner sets Martin without structured options, get shows
the recorded failure reason and the missing-question limitation. It never
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
[mc-jev.md](mc-jev.md), is presented only after synthesis: scope and
general rule, evidence, uncertainty, alternatives/tradeoffs, recommendation,
proposed normative wording and exact `docs/technical/` destination. The
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
(`main-red:<repo>/<id>`) and `decision` (`decision:<at>`). A goal's source time
is its current question/log entry time; a later question is a distinct item.
Fields are `schema`, `version`, `id`, `kind`, `reference`, `source_at`,
`opened_at`, `state`, `sort`, `reversible`, `due_at` and `outcome`.

States are `new` → `prepared` → `for-martin` → `closed`, with `prepared` also
able to close directly. Sort is null or mechanical, technical, product,
judgement or reserved; reversible and due time are nullable. Closing records
`{by, at, summary}` where by is decision, martin, default or source. Sync opens
waiting goals and main-reds and flagged decided jev ledger rows once. A decided
row is flagged when jev's chosen key differs from the session recommendation
or its product reading is at least 0.70. Sync skips ledger rows older than the
store's first sync, closes open goal/main-red items
whose source no longer waits, and writes only beneath the item store. It never
changes a source record. Missing, malformed or unreadable goal/main-red files
are reported and preserve the item: absence from the live queue alone is not
resolution. A goal closes only on a readable finished/non-Martin state or an
established later question; a main-red closes only on readable state showing
that its entry no longer waits. Chores syncs once each round.

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
when reversible. `close --by decision|martin|default --summary <paragraph>`
(or `--summary-file`) closes prepared/for-martin. Invalid transitions, roles,
ids and missing required files are refused with exit 2 and no write. Item JSON
is written atomically. The interactive `mc martin` launch and read-only
`mc martin get` remain unchanged.

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
`prepared --sort mechanical|technical|product|judgement|reserved`.

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
passes: preparation and the decision pass. It sums today's UTC `runs.tsv`
`cost` values for `desk-prepare` and `decision` only; other days/kinds and unknown
costs (`-`) do not contribute. Before each turn it rereads the setting and sum.
When the setting is non-null and the sum is at least it, no desk turn starts;
the chores pass explains the hold once in that round. Already running turns
are not interrupted and a turn can take the day's cost over the ceiling.
An unreadable/invalid setting holds preparation with an explicit error, rather
than silently disabling a ceiling. The decision pass is delivered separately.
