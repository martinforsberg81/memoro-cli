# mc brief — the evaluation session

`mc brief [--new] [--codex|--claude] [--model <model>]` is the person's
entrance to the brief desk in `~/mc/brief/`. It opens or resumes a foreground
conversation with the `brief` role. It gathers nothing and supplies no opening
words: Martin types what he wants help with. A session already running never
uses this entrance to start itself.

## Launch and ground

`src/mc/commands/brief.js` reads the canon role, makes the desk directory and
calls `openInWorkArea` (`src/mc/work-open.js`) with inherited stdio. No Git
checkout is required in the desk. `pick: null` resumes the existing
conversation; `--new` starts fresh. The role's overlay and model default ride
through the same assembler as the other interactive roles
([mc-roles.md](mc-roles.md)). The foreground record makes the desk visible on
the page while it holds the terminal.

The ground is read where it lives: `mc`, `mc goal list`, `mc goal show
<programme>/<goal>`, programme proposals and the repositories. There is no
snapshot report handed over by the command. `--collect` and `--offline` were
removed on 2026-09-19: the page already supplies the live reading.

## Decisions and work

A goal is the unit the runner builds, reviews and lands. A question that only
Martin can answer leaves it in its current stage with status `blocked` and
the question in its last `LOG.md` entry. The brief can read that question and,
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

`tests/mc/commands/brief.test.js` covers the launch arguments without opening a
coding tool: foreground desk, overlay, no opening words, resume and `--new`,
and rejection of retired flags. The shared readers are covered by
`tests/mc/brief-collect.test.js`. This document claims no live interactive
launch measurement.
