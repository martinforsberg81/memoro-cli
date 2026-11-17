# mc manager — the headless session across all programmes

The manager is a headless session of the `manager` role (`canon/roles/manager.md`). Its one automatic task is to
keep the area texts curated. The runner starts it for that (*Automatic turns*, below; the rules are in
[mc-run.md](mc-run.md), *The manager's turns*); a person can give it one explicit task by hand (*Manual headless
tasks*). It is never a conversation: the interactive manager is gone, and Martin's conversation is `mc martin`
([mc-martin.md](mc-martin.md)). A horizon and a programme are made only by Martin in `mc martin` or by a person;
the manager never makes either, never makes a goal and never performs a reserved act. It has no horizon turn and
no repair turn.

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

The runner starts one kind of manager session, under the claim `manager` ([mc-run.md](mc-run.md)):

- **A curation turn**, when none started in the last 24 hours and the origin/main of a repository that declares
  areas has moved past what the last curation read. It works in branch worktrees the runner makes from
  origin/main and publishes what it changed with plain `mc publish`, which queues the pull request for the merger,
  whose docs form lands it (never `--no-merge`). A turn that finds nothing to change succeeds; a
  failed one is said in `runner.log` and opens no desk item.

It runs under the manager role with `MC_HEADLESS=1`. There is no horizon turn and no repair turn: no session of
the manager creates a programme, and a horizon with no programme waits for Martin. A desk item of kind `manager`
left by the removed horizon turn closes by source at the next sync, and `runner/manager-turn/horizon/` stays on
disk as it was, read only for that item's label.

## What the manager may write

The manager reads the app and the area pages, never only a programme's own account of itself. It writes facts
into the area texts and never an aim or a design decision; those, and any held text, it proposes at the desk with
`mc martin propose --text <repo>/<path>`. Candidates for new horizons are brought to the desk the same way, as a
text item `horizon:<proposed-slug>`; before drafting, apply [writing a horizon](../../canon/tasks/writing-a-horizon.md). They become horizons only by Martin.

When `MC_ROLE=manager`, `mc publish` refuses with exit 2 and one `mc:` line naming the file a branch whose diff
against origin/main (a) changes a file outside `docs/technical/`, (b) changes `docs/technical/memoro-me.md`,
(c) changes the `## Aim` of an area page (`docs/technical/areas/*.md`), or changes its `## Decisions` by anything
but the removal or correction of a superseded dated block, or (d) removes or alters a block that holds a dated
decision of Martin's (a list item with its continuation lines, or a paragraph up to the next blank line, containing
`Martin` followed by a comma and a date) unless the same file keeps, unchanged, a dated block with a later date. A
block is superseded by that later block; the manager may then remove it or correct it, keeping its citation (the
last `Martin, YYYY-MM-DD` in it, as written). Everything else is refused with the one message that sends a text of
Martin's to the desk with `mc martin propose`. That is a list of where curation may write, not a proof that what it
writes is true: whether a statement is a fact stays the session's judgement. Other roles are unaffected (`managerGuard` in `src/mc/publish.js`).

The manager writes no programme: `mc programs create`, `record` and `state` refuse it with exit 2, as they refuse
every headless role ([mc-plan.md](mc-plan.md)). Work the manager finds that needs a programme, a repair included,
is proposed at the desk with `mc martin propose`, and Martin creates it.

## Decisions and work

A goal is the unit the runner builds, reviews and lands. A question that only Martin can answer leaves it in its
current stage with status `blocked` and the question in its last `LOG.md` entry; what reaches Martin is the rule
in [asking-martin](../../canon/tasks/asking-martin.md), and nothing else. A technical call is the manager's own:
it makes it, records it where it governs and reports it. A recommendation states what it rests on and what was
not read, and a direction whose basis is too thin is recorded as a working assumption with the reading that would
settle it (`canon/roles/manager.md`).

A proposal is a reading, not runnable work. Once decided it becomes a goal, is built directly, or is dropped.
Preserve the evidence the goal needs before archiving the proposal, with a line saying what happened and where it
landed. A partly handled proposal stays, rewritten to what remains. Proposals live in the area they concern,
`~/mc/areas/<repo>/<area>/proposals/` (one folder per declared area page; the decided ones in its `archive/` with an
`Utfall:` first line), never in a programme: a programme is an order. The curation prompt lists every area's, each
with its area, oldest first.

## Checks

`tests/mc/commands/manager.test.js` covers the refusal of the interactive entrance and the explicit headless
dispatch, validation and failure exits. `manager-turn.test.js` exercises both providers' real argument builders
with a replaced process boundary, fresh invocation isolation, environment identity and result receipts.
`manager-pulse.test.js` and the manager and curation cases of `run.test.js` cover the curation turn's due rule, state,
endings, failure items and worktrees without a model, a clock or a network; `publish.test.js` covers the
guard. This document claims no live session measurement.
