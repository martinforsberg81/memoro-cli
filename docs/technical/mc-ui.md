# mc — the page

`mc`, typed alone, is the page. It is the only thing in mc that lists
workareas, projects, sessions or queue entries, and there is exactly one
only surface. `mc --watch` existed for a few hours on 2026-08-29 and was removed the same day (Martin: a page redrawn on a timer is not a live page; the real one comes later).

That is a deliberate limit (decision `mc-3`, 2026-08-29). Before it, five
verbs each printed a list of their own — bare `mc` printed the V1 sessions
table, `mc status` printed a board, `mc list` printed workareas, bare
`mc work` printed a menu with its own numbering, and `mc status --sessions`
printed a second board over 1 417 transcripts. A person had to know which
one answered their question. **A new verb that prints a list of areas,
sessions or projects is a regression**, not a feature.

## The surfaces

| | what it does |
|---|---|
| `mc` | prints the page; at a terminal, then the menu |
| `mc --json [--fresh]` | the same object the renderer takes, one key per section, exit 0 |
| `mc --fresh` | fetch and ask GitHub first, then print |
| `mc status <name>` | one project — still its own verb |
| `mc work <name> …` | the workarea verbs — still their own |

Without a TTY — a pipe, a subprocess, a session reading it — the page
prints and exits 0. Nothing ever prompts where nobody can answer.

`mc list`, `mc sessions list`, bare `mc status` and `mc status
--sessions|--watch|--wait` exit 2 and say where they went. `--offline` is
still accepted on the page and does nothing: offline is what the page does.

## The five sections

In this order, because that is the order the questions come in:

- **NOW** — the runner's steps in flight, one line per lane (kind, tool,
  model, elapsed against budget, pid), a pending `~/mc/runner/STOP`, the
  live tmux `mc-<name>`
  areas with how long they have been open, the foreground verbs somebody is
  sitting in, and one line of the day behind it: steps, merged, open,
  failed, timed out, and an estimated **list-price** cost.
- **QUEUE** — how deep, how much of it is runnable, the next few by name and
  kind, and the skips counted by reason. A live area is a reason of its own.
- **DECISIONS** — how many wait on Martin, the first three by name.
- **INTAKE** — the newest `~/mc/intake/errors-<date>.md`, its age, what is
  new in it, and how many proposals nobody has queued or dropped.
- **WORK** — one numbered row per workarea: plan status, `next`, the last
  runner step, the open PR, a live mark. Live first, then by the later of
  the area's mtime and its last runner step. Then one line counting the
  projects on main with no workarea.

Two rules the sections keep:

- **A number where a number is the answer**, a line only where the identity
  matters — and every count names the verb that expands it, on the right of
  its own heading.
- **A count is only honest if the section says what it cannot see.** INTAKE
  says `first digest — no baseline` rather than `0 new errors`; NOW lists no
  foreground session rather than claiming nothing is running. A zero that
  looks like health is worse than a gap that says it is one.

## Where the facts come from

Nothing here starts a model or a session. The page reads what the runner,
the helper and the sessions already write.

| fact | file | written by |
|---|---|---|
| a runner is here | `~/mc/runner/runner.json` (pid, started) | `mc run`, at start |
| a step is in flight | `~/mc/runner/current-<repo>.json`, one per lane (name, kind, repo, tool, model, budget, started, pid, worktree) | `mc run`, per step |
| stop after this step | `~/mc/runner/STOP` (every lane) | anyone |
| the day behind it | `~/mc/runner/log/runs.tsv` | `mc run`, after each step |
| the queue | `~/mc/queue.md` | Martin, at the brief |
| decisions waiting | `<area>/decisions/*.md` without a `**Beslut:**` line | the sessions |
| what production said | `~/mc/intake/errors-<date>.md`, `~/mc/intake/proposals/` | `mc helper` |
| someone is sitting here | `tmux ls`, `~/mc/runner/foreground/<pid>.json` | tmux, `foreground.js` |
| plans and open PRs | `~/mc/runner/plans.json`, `~/mc/runner/prs.json` | the page itself (below) |

`runs.tsv` gets its row only *after* a step ends, which is why
`runner.json` and the `current-<repo>.json` files exist at all: before them,
the fact the page most needed — what is running right now — existed nowhere
a program could read. They are written through `atomic-write.js` and removed
when their scope ends, the removal paired in a `finally` so a step that
throws still clears the file.

There is one current file **per lane**: `mc run` drives memoro's queue and
memoro-cli's at the same time, so NOW is a list rather than a line, and the
page reads `runner/current-*.json` by name instead of one fixed file. The
lanes themselves are in [`docs/technical/mc-run.md`](mc-run.md).

**Liveness is one test, `pidAlive`** — `kill(pid, 0)`, with `EPERM`
counted as alive. Nothing asks tmux or pgrep. Both of those lied on
2026-08-29: a dead pane still answered `tmux has-session -t runner`, and
`pgrep -f 'mc run'` matched a step session whose *prompt* contained the
words "mc run". A file whose pid is dead is reported as stale, and counts
as nothing running.

### The foreground register

A session a person opens themselves — `mc brief`, `mc plan <name>`,
`mc worker <name>`, `mc work <name>` in a terminal — is a child of mc
holding the terminal, and leaves no trace on disk. NOW would say "nothing
is running" while the machine was busy, which is the one thing the page must
never do.

So the verb registers itself: `~/mc/runner/foreground/<pid>.json` (verb,
area, tool, model, pid, started), written before the call that blocks and
removed however it returns. The pid is **mc's**, not the tool's — the same
reason a lane's current file names the runner: it is the pid whose death means the
session is over, and the one that can be tested for life from outside.

ctrl-c kills mc together with the tool and `finally` never runs, so a file
can outlive its session. That is handled twice and needs no bookkeeping: the
reader drops an entry whose pid is not alive, and the next verb sweeps the
dead pids as it registers.

## Why it is instant

`time mc` is 0.09–0.11 s with both caches hit, against 1.92 s for the board
it replaced. (Measured over twelve runs at load average 10; a busy moment on
the same machine pushes single runs to 0.2–0.3 s.) Two changes did it, and
they are worth different amounts:

1. **One read per repository instead of one per plan.** `listPlans` was
   spending a `git show` per PLAN.md — 37 in memoro alone, 1.45 s of the
   1.92. It now runs one `ls-tree` and one `cat-file --batch`, walking the
   stream by byte size so a plan full of em-dashes survives it. That alone
   took the page to 0.31 s. `mc brief --collect --offline` got the same win
   for free.
2. **Two caches under `~/mc/runner/`** (`page-cache.js`), which buy the last
   0.2 s:
   - `plans.json` is keyed **by the `origin/main` sha**, per repository. A
     hit costs one `git rev-parse` — the sha *is* the question "did anything
     change?" — so there is no staleness to reason about and no age to
     print: a hit is exactly what a fresh read would have returned.
   - `prs.json` has no such key, because an open PR closes without moving
     any sha. It is **stamped** instead, written only by `--fresh`, and the
     page says how old it is out loud. The two files are not the same kind
     of cache and the code says so.

These are the page's only writes, and the Contract's "reads only" is
recorded as bending exactly here: a read-through cache of what the page
already reads, not state anything depends on. Delete both and the next
`--fresh` fills them again.

The **cold** path is not instant: the first print after `origin/main` moves
re-reads both repositories and costs 0.31 s quiet, 0.48 s under load. That
happens once per merge. The runner could warm it in the round it already
fetches in; it does not yet.

## How it looks

`page-render.js` draws lines, not one string, so a
test can look at one row.

- **Width-aware.** `stdout.columns` clamped to 60–160, through `width`,
  `pad` and `clip` from `status-render.js`. Nothing is padded to a number
  somebody typed once — the board it replaced hardcoded 34/17/70.
- **Escape sequences go on after the width is decided.** `clip` slices by
  character index, so clipping already-coloured text cuts an escape in half.
  Every heading and prose line is measured and cut as plain text and painted
  afterwards.
- **Every column clips one short of its pad**, so the ellipsis is the last
  character and a clipped name never touches its neighbour.
- **Colour carries state, never decoration**: green running, yellow waiting
  on a person, red failed, grey quiet — the table is below. Only on a TTY,
  and only when `NO_COLOR` is unset **or empty**; the convention is that any
  non-empty value turns colour off, and `--json` is never painted at all.
- No new dependency. The ANSI is by hand, as the rest of the repo is.

## The palette

The page is grey with meaning painted on it, and the meanings are a short
list. Two of them are tables, and those tables are the rule the rest of the
page bends to: **a step kind and a plan status have one colour each, wherever
they are printed.** NOW, QUEUE and WORK all say `reconcile` in the same
magenta, so a kind is recognised before it is read. They are `KIND_TONE` and
`STATUS_TONE` in `page-render.js`, and `tests/mc/page.test.js` walks each one
through all three sections.

| step kind | colour |
|---|---|
| `step` | green |
| `reconcile` | magenta |
| `triage` | blue |
| `brief` | cyan |
| `plan` | cyan |
| anything else | grey |

| plan status | colour |
|---|---|
| `ready` | green |
| `waiting-decision` | yellow |
| `blocked` | red |
| `done` | grey |
| no PLAN.md on main | dim grey |

Everything else is structure, and structure is quiet:

| where | what | colour |
|---|---|---|
| header | `MEMORO·CLI` | bold white |
| header | decisions waiting, when > 0 | bold yellow |
| header | `N of M queued` | white |
| header | version, rule, cost today | grey |
| section titles | `NOW` `QUEUE` `DECISIONS` `INTAKE` `WORK` | bold cyan |
| section titles | the count beside it, the verb hint on the right | grey |
| NOW | the live step's `●`, its name | green, bold white |
| NOW | elapsed: under ¾ of budget, from ¾, past it | white, yellow, bold red |
| NOW | a foreground session — `●`, `mc brief` | cyan |
| NOW | a live tmux area's `◆` | yellow |
| NOW | `■ STOP requested` | bold red |
| NOW | a stale runner file | red |
| NOW | a quota answer under 6 h old, older | yellow, grey |
| NOW | between steps, no runner, the day's line, the tool and pid | grey |
| QUEUE | the next name, the first of them | white, bold white |
| QUEUE | the number, `… N more runnable` | grey |
| QUEUE | why a project was skipped | dim grey |
| DECISIONS | the `●` on every row | yellow |
| DECISIONS | the question | white |
| DECISIONS | the file path, `… N more` | grey |
| INTAKE | the digest's date, under 24 h old, older | green, yellow |
| INTAKE | new errors, when > 0 | red |
| INTAKE | proposals, when > 0 | yellow |
| INTAKE | a `!` line: its mark, its text | red, bold white |
| INTAKE | no digest yet, no new errors, no proposals | grey |
| WORK | a live area's `●`, its name | green, bold white |
| WORK | a quiet area's name and `next` | white, plain |
| WORK | the PR number | cyan |
| WORK | the number, the last-run time, the projects-without-a-workarea line | grey |
| WORK | a row with no PLAN.md on main | grey throughout |
| footer | the cache line, the notes | grey |

Four things hold that table up:

- **Plain 16-colour SGR, and only the `SGR` table in `status-render.js`** —
  `bold`, `dim`, `red`, `green`, `yellow`, `blue`, `magenta`, `cyan`, `white`,
  `grey`. Nothing 256-colour, nothing new: `white` was already there, and
  `bgred` turned out not to be needed.
- **`paint(c, parts, space)` is why no escape is ever cut.** `clip` counts
  columns but slices bytes, so a string that already carries escapes cannot be
  cut. `paint` measures the plain text of a run, paints it only when it fits,
  and otherwise clips the plain text and goes grey — a truncated line is
  bookkeeping. Every escape on the page therefore sits outside the width the
  row was clipped to, and a coloured row is exactly as wide as its plain twin.
- **The plain page gained one glyph, and only one.** A page without a TTY
  prints what it printed before this palette, with one exception: the yellow
  `●` on a DECISIONS row is drawn always, not only when colour is on, because
  a mark that appears with colour would make a coloured row wider than its
  plain twin. It sits inside the row's own footprint, where two of the seven
  leading spaces used to be. Everything else is byte-identical, at six widths,
  against the same fixtures.
- **`--watch` is gone** (2026-08-29): it cleared and redrew on a timer, which is not a live page. A real live page is later work.

`tests/mc/page.test.js` pins all of it: a per-row signature snapshot of the
painted page (the colours in order, not the escape bytes), the two tables
walked through every section that prints them, the clock at ¾ and past the
budget, and — at six terminal widths — painted against plain, row for row,
with every escape checked to be whole.

## The menu

At a terminal the page ends in a prompt. It is `mc work`'s menu, moved
rather than rewritten — what a number, a name, `n` and a typed verb do has
not changed:

| | |
|---|---|
| a number | opens that workarea — **WORK's number**, not a listing of its own |
| a name | opens that workarea |
| `n` | starts a new one |
| `b` | `mc brief` |
| `p <name>` | `mc plan <name>` |
| `s <name>` | `mc status <name>` |
| `q`, empty | quit |
| anything else | parsed as an `mc work` command, with or without its first two words |

The menu asks `inspectWorkArea(name).exists` rather than looking for a WORK
row, because WORK draws the areas that hold a checkout and `mc work` offers
to make an area with no repository in it. Using the rows would have kept the
typo guard and stranded the empty area under the only name it has.

The prompt reads `/dev/tty` by design, so a subprocess without a terminal
never reaches it.

## The modules

| file | what it is |
|---|---|
| `src/mc/commands/home.js` | the two surfaces: the page and the menu |
| `src/mc/page-collect.js` | the five sections, built from read data |
| `src/mc/page-render.js` | how they look |
| `src/mc/page-cache.js` | `plans.json` and `prs.json` |
| `src/mc/status-collect.js` | the readers more than one caller needs — `nowBlock`, `kindFor`, `pidAlive`, `decisionsBlock`, `areasWithCheckout` |
| `src/mc/status-render.js` | the drawing primitives — `painter`, `width`, `pad`, `clip`, `elapsed` |
| `src/mc/foreground.js` | the foreground register |
| `src/mc/status-project.js` | `mc status <name>`, unchanged by this |

The section builders are pure: each takes read data and returns its section,
so `tests/mc/page.test.js` builds every one from fixtures and a temporary
work root, with no git, gh or tmux. `collectPage` is the only part that
touches the machine and `renderPage` the only part that knows how it looks;
`--json` prints the object the renderer takes, and the test renders the
parsed JSON and compares, so the two surfaces cannot drift.

`tests/mc/front-door.test.js` drives the menu in process with the reading
and the opening handed in, so a number can be shown to open the workarea
WORK gave that number to without a session ever starting.

## What went, and what did not

Removed with their tests: bare `mc work` (it *is* `mc`), `mc list` and
`src/cli/list.js`, `mc sessions list` and `src/mc/session-v1-list.js` — the
same module and its renderer — bare `mc status`, `--sessions|--watch|--wait`
on `mc status`, `commands/status-board.js`, `commands/status-page.js`,
`signature()` in `work-status.js`, `renderLines` in `status-render.js`, and
the block-and-render half of `status-collect.js` (`collectStatus`,
`renderStatus`, `runnerBlock`, `projectsBlock`, `orphanWorkareas`).

`mc sessions read|send` are untouched — they are not lists.

Two things the plan expected to remove and could not:

- **`workStatus()` stays.** The board sat on top of it, but it has two other
  readers: `mc repo status`, which regroups its worktree facts by
  repository, and the lease liveness check. Only the board's own half went.
- **Six tests used the board as a probe, not as a page** — `repo-status`,
  `repo-lease`, `task`, `work-send` and `status-roles` read `mc status
  --sessions --json` to observe worktrees, leases and open-task counts. They
  ask `workStatus()` directly now, through `tests/mc/_helpers/board.js`,
  which applies the fixture's env to the process for the length of the call
  because the open-task count reads `MC_HOME` ambiently.

The first-run hint moved here too: a fresh install used to land on `mc
list`, and now lands on `mc`. It is written to stderr so `--json` stays
parseable.

## History

Built as `docs/project/mc/mc-ui/`, six steps: NOW and the runner's two files
([#430](https://github.com/martinforsberg81/memoro-cli/pull/430)), the batch
read and the caches
([#435](https://github.com/martinforsberg81/memoro-cli/pull/435)), the five
sections ([#440](https://github.com/martinforsberg81/memoro-cli/pull/440)),
the front door
([#441](https://github.com/martinforsberg81/memoro-cli/pull/441)), the
foreground register
([#443](https://github.com/martinforsberg81/memoro-cli/pull/443)) and this
close-out. The decision that set the shape is `mc-3` (2026-08-29).

The palette came after, as `docs/project/mc/mc-ui-polish/`, in two steps: the
page in colour ([#446](https://github.com/martinforsberg81/memoro-cli/pull/446))
and this close-out. It added no section, no datum and no flag — the page it
paints is the page above.
