# `mc martin` — current decision queue

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

Each item carries goal/contract/exclusions/criteria/documents, stage/status/
phase, current question/options/recommendation/jev reading or failure, last
three log entries and log/worktree/evidence paths. Each selected programme's
README and applicable rulings from known existing goal checkouts are included
once per programme. Text and JSON share stable ordering. Existing sessions
call `get` rather than starting another desk.

## Authority and decision synthesis

The role investigates each source question against relevant shared technical
contracts and programme README/design/rulings. Details answered there are
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
