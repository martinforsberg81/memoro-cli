# mc manager — the headless session across all programmes

The manager is a headless session of the `manager` role (`canon/roles/manager.md`). It has two tasks: keep the
area texts curated, and create the next programme while a horizon is open. The runner starts it for both
(*Automatic turns*, below; the rules are in [mc-run.md](mc-run.md), *The manager's turns*); a person can give
it one explicit task by hand (*Manual headless tasks*). It is never a conversation: the interactive manager is
gone, and Martin's conversation is `mc martin` ([mc-martin.md](mc-martin.md)). A horizon is made only by Martin
in `mc martin`; the manager never makes one, never makes a goal and never performs a reserved act.

## No interactive entrance

`mc manager` without `--headless`, in every form (bare, `--new`, `--resume`, `--bg`, `--local`), and its alias
`mc brief` exit 2 with one `mc:` line saying the interactive manager is gone and naming `mc martin` and
`mc manager --headless --prompt`. The refusal is made in `runModule` before server routing, and `manager` and
`brief` are not in `ENTRANCES` (`src/mc/server-client.js`), so no configured or older server opens one
([mc-server.md](mc-server.md)). Help on the verb still prints its usage. `~/mc/manager/` and its conversations
stay on disk, untouched; nothing reads them.

## Manual headless tasks

`mc manager --headless --prompt "Resolve the blocked merge" [--minutes 30]` runs one explicit task and waits for
it to end. `--codex`, `--claude` and `--model` select the tool and model. A manual run starts fresh. It is a
person's act: it neither holds nor is held by the automatic turns, and the runner does not count it.

`manager-turn.js` uses the shared headless argument builder, billing route and provider output reader. It clears
inherited goal/programme identity, sets `MC_ROLE=manager` and `MC_HEADLESS=1`, and scrubs provider API keys. The
role records what needs Martin rather than inventing an answer; the headless restrictions on deploys, production
data, credentials and admin apply.

Each invocation gets its own cwd under `~/mc/runner/manager/<timestamp>-<uuid>/`. `result.json` there records the
task, outcome, provider output, timestamps and available token usage. The command prints the final answer,
outcome and receipt path. The default wall-clock limit is 30 minutes (`--minutes` accepts positive values up to
1440). Failures and timeouts return nonzero.

## Automatic turns

The runner starts a manager session in two cases, one at a time under one claim, `manager`
([mc-run.md](mc-run.md)):

- **A horizon turn**, when an open horizon has no valid open programme record naming it. The session reads the
  horizon's playback, the area pages and read checkouts at origin/main of every repository that declares areas,
  the archived programmes that served the horizon, and the app with `mc shot`. It ends in one of three ways:
  `mc programs create <name> --end … --horizon <slug> --purpose …`; `mc martin horizon reached <slug>`; or an open
  text item `horizon:<slug>` made with `mc martin propose`. The runner checks that one holds, without a model;
  the second failure since the last item opens a desk item of kind `manager`
  ([mc-martin.md](mc-martin.md)).
- **A curation turn**, when none started in the last 24 hours and the origin/main of a repository that declares
  areas has moved past what the last curation read. It works in branch worktrees the runner makes from
  origin/main and publishes what it changed with `mc publish`. A turn that finds nothing to change succeeds; a
  failed one is said in `runner.log` and opens no desk item.

A horizon turn goes before curation. Both run under the manager role with `MC_HEADLESS=1`; a horizon turn also
has `MC_HORIZON=<slug>`.

## What the manager may write

The manager reads the app and the area pages, never only a programme's own account of itself. It writes facts
into the area texts and never an aim or a design decision; those, and any held text, it proposes at the desk with
`mc martin propose --text <repo>/<path>`. Candidates for new horizons are brought to the desk the same way, as a
text item `horizon:<proposed-slug>`; they become horizons only by Martin.

When `MC_ROLE=manager`, `mc publish` refuses with exit 2 and one `mc:` line naming the file a branch whose diff
against origin/main (a) changes a file outside `docs/technical/`, (b) changes `docs/technical/memoro-me.md`,
(c) changes the `## Aim` or `## Decisions` section of an area page (`docs/technical/areas/*.md`), or (d) removes
or alters any line of a block that holds a dated decision of Martin's (a list item with its continuation lines,
or a paragraph up to the next blank line, containing `Martin` followed by a comma and a date). That is a list of
where curation may write, not a proof that what it writes is true: whether a statement is a fact stays the
session's judgement. Other roles are unaffected (`managerGuard` in `src/mc/publish.js`).

The same rule for programmes: `mc programs create` by the manager requires `--purpose` and exactly one of
`--horizon` and `--area`, refuses a horizon that is not open or already has a valid open record, writes the
programme's page before its record, and `mc programs record` is refused to it ([mc-plan.md](mc-plan.md)). A
defect against an area text may get a programme without a horizon (`--area <repo>/<id>`): at most one is open
per area, and the rest of the proposals wait in the order they were written.

## Decisions and work

A goal is the unit the runner builds, reviews and lands. A question that only Martin can answer leaves it in its
current stage with status `blocked` and the question in its last `LOG.md` entry; what reaches Martin is the rule
in [asking-martin](../../canon/tasks/asking-martin.md), and nothing else. A technical call is the manager's own:
it makes it, records it where it governs and reports it. A recommendation states what it rests on and what was
not read, and a direction whose basis is too thin is recorded as a working assumption with the reading that would
settle it (`canon/roles/manager.md`).

A proposal is a reading, not runnable work. Once decided it becomes a goal, is built directly, or is dropped.
Preserve the evidence the goal needs before archiving the proposal, with a line saying what happened and where it
landed. A partly handled proposal stays, rewritten to what remains. Programme-owned proposals live in
`~/mc/programs/<programme>/proposals/`; those no programme owns live in `~/mc/proposals/`. The curation prompt
lists both, oldest first.

## Checks

`tests/mc/commands/manager.test.js` covers the refusal of the interactive entrance and the explicit headless
dispatch, validation and failure exits. `manager-turn.test.js` exercises both providers' real argument builders
with a replaced process boundary, fresh invocation isolation, environment identity and result receipts.
`manager-pulse.test.js` and the manager and curation cases of `run.test.js` cover the two turns' due rules, state,
endings, failure items and worktrees without a model, a clock or a network; `publish.test.js` covers the
guard. This document claims no live session measurement.
