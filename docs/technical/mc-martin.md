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
resolved without escalation. A remaining product, privacy, cost, test
strategy or other design choice is presented only after synthesis: scope and
general rule, evidence, uncertainty, alternatives/tradeoffs, recommendation,
proposed normative wording and exact `docs/technical/` destination. The
original queue question/options/jev reading remain source evidence, distinct
from the synthesis. After Martin decides, record the canonical standard and
reconcile programme/goal text before returning or handing off work.

See [mc-roles.md](mc-roles.md) for launch ownership and [mc-goals.md](mc-goals.md)
for enforced mutation authority. Goal evidence, gate, review, publish and merge
lifecycle remain unchanged.
