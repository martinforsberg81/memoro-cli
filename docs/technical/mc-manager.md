# mc manager — the session across all programmes

Linux SSH interactive launches keep their provider alive past the terminal ([Claude background session or Codex app-server](mc-interactive-sessions.md)); macOS retains the existing foreground terminal.

`mc manager [--new|--resume [<id>]] [--codex|--claude] [--model <model>]` is the person's
entrance to the Manager desk in `~/mc/manager/`. It opens or resumes a foreground
conversation with the `manager` role. It gathers nothing and supplies no opening
words: Martin types what he wants help with. A session already running never
uses this entrance to start itself.

Manager helps prioritise between programmes, resolve blockers across them, and
review proposals. It carries agreed decisions into goals and programme plans.
`mc brief` remains a compatibility alias. Older conversations launched in `~/mc/brief/` remain discoverable alongside
those in `~/mc/manager/`, newest first. Resuming one starts the tool in the new
desk with its original conversation ID. Existing files in `brief/` stay there;
no transcript or active session is moved or rewritten.

## Launch and ground

`src/mc/commands/manager.js` reads the canon role, makes the desk directory and
calls `openInWorkArea` (`src/mc/work-open.js`) with inherited stdio. No Git
checkout is required in the desk. `pick: null` resumes the existing
conversation; `--new` starts fresh. `--resume` offers compatible conversations
from both providers, with IDs, last update times and labels; an explicit tool
flag filters the list. `--resume <id>` selects a full ID or unique prefix.
Ambiguous, missing or incompatible selections fail without starting fresh.
A cancelled picker opens nothing. Without a terminal, the command prints the
available conversations and asks for an explicit ID. `mc helper` and
`mc plan <programme>` use the same selection. The role's overlay and model default ride
through the same assembler as the other interactive roles
([mc-roles.md](mc-roles.md)). The foreground record makes the desk visible on
the page while it holds the terminal.

The ground is read where it lives: `mc`, `mc goal list`, `mc goal show
<programme>/<goal>`, programme proposals and the repositories. There is no
snapshot report handed over by the command. `--collect` and `--offline` were
removed on 2026-09-19: the page already supplies the live reading.

## Manual headless tasks

`mc manager --headless --prompt "Resolve the blocked merge" [--minutes 30]`
runs one explicit task and waits for it to end. `--codex`, `--claude` and
`--model` select the tool and model as for the foreground entrance. Headless
always starts fresh: `--new` is implicit and accepted for explicit callers.
There is no timer, runner trigger or automatic wakeup for Manager.

`manager-turn.js` uses the shared headless argument builder, billing route and
provider output reader. It clears inherited goal/programme identity, sets
`MC_ROLE=manager` and `MC_HEADLESS=1`, and scrubs provider API keys. The role
records decisions needing Martin rather than inventing an answer; existing
headless restrictions apply to deploys, production data, credentials and admin.

Each invocation gets its own cwd under `~/mc/runner/manager/<timestamp>-<uuid>/`,
separate from interactive desk history. `result.json` there records the task,
outcome, provider output, timestamps and available token usage. The command
prints the final answer, outcome and receipt path. The default wall-clock limit
is 30 minutes (`--minutes` accepts positive values up to 1440). Failures and
timeouts return nonzero. The session is visible as Manager on the page while
running; its registration is released on completion. No session is started
by installing this change.

## Decisions and work

A goal is the unit the runner builds, reviews and lands. A question that only
Martin can answer leaves it in its current stage with status `blocked` and
the question in its last `LOG.md` entry. Manager can read that question and,
with Martin's decision, arrange the answer in the goal through `mc goal`.
Setting it `ready` does not change its stage. Ordered work belongs in phases,
not in a second queue. See [mc-goals.md](mc-goals.md).

A proposal is a reading, not runnable work. Once decided it becomes a goal,
is built directly, or is dropped. Preserve the evidence the goal needs before
archiving the proposal, with a line saying what happened and where it landed.
A partly handled proposal stays, rewritten to what remains. Programme-owned
proposals live in `~/mc/programs/<programme>/proposals/`; those no programme
owns live in `~/mc/proposals/`. The page lists waiting names, not their contents.

## Checks

`tests/mc/commands/manager.test.js` covers the launch arguments without opening a
coding tool: foreground desk, overlay, no opening words, resume and `--new`,
and rejection of retired flags. It also checks explicit headless dispatch,
validation and failure exits. `manager-turn.test.js` exercises both providers'
real argument builders with a replaced process boundary, fresh invocation
isolation, environment identity and result receipts, including failures and
timeouts. `work-open.test.js` checks resuming legacy history from the new cwd. The shared readers are covered by
`tests/mc/brief-collect.test.js`. This document claims no live interactive
launch measurement.
