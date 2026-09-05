# mc — the page

`mc`, typed alone, is the page. It is the only thing in mc that lists
workareas, projects, sessions or queue entries, and there is exactly one
only surface. Left open at a terminal it stays true: every 30 seconds the
rows that changed are rewritten where they stand, and nothing else on the
screen moves — see [*The live page*](#the-live-page). `mc --watch` existed
for a few hours on 2026-08-29 and was removed the same day (Martin: *a page
redrawn on a timer is not a live page; the real one comes later*). That
section is the later.

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
| `mc` | prints the page; at a terminal, then the menu, and the page refreshes in place under it every 30 s |
| `mc --json [--fresh]` | the same object the renderer takes, one key per section, exit 0 |
| `mc --fresh` | fetch and ask GitHub first, then print |
| `mc status <name>` | one project — still its own verb |
| `mc work <name> …` | the workarea verbs — still their own |

Without a TTY — a pipe, a subprocess, a session reading it — the page
prints once and exits 0. Nothing ever prompts where nobody can answer,
nothing loops, and no escape byte is written at all: not colour, not a
cursor move, not an erase. `tests/mc/front-door.test.js` asserts it as
bytes, for `mc` and `mc --json` both, because a live surface leaking into a
script is the one regression nobody would notice by looking.

`mc list`, `mc sessions list`, bare `mc status` and `mc status
--sessions|--watch|--wait` exit 2 and say where they went. `--offline` is
still accepted on the page and does nothing: offline is what the page does.

## The five sections

In this order — the listing first and whole, the machine last and nearest the
prompt. RUNNER, HELPER and BRIEF are the rows that change while the page is
left open (a step's minutes, a session's age), and the live loop rewrites only
rows still on the screen (`page-frame.js`); at the top, under a hundred rows
of projects, they had scrolled into history before the prompt was printed and
never moved (2026-09-03). The overview stays complete — every project is
listed — and what moves sits where the eye already is:

- **QUEUE** — how deep, how much of it is runnable, the next few by name and
  kind, and the skips counted by reason. Every reason comes from the plan: a
  session somebody has open in the workarea is not one of them, because the
  runner does not decline for it either. Under those, in yellow when it is
  there at all: **blocker finished** — a step that is `blocked` on a project
  whose plan on `origin/main` is `done` or gone, which is a plan waiting for
  nothing (`stale-blockers.js`). Only a `project` blocker; a `decision` waits
  on Martin and there is no artefact to read it against. It reports and
  nothing more — flipping the step back to `ready` is a plan edit somebody
  makes. And, when there is one at all: **held before merge N** on the
  heading's own count line, with a row under the skips for each — project,
  pull request, reason. That is `~/mc/runner/held.json`, every pull request
  `mc run` would not land (a red gate, a plan trespass, a session that timed
  out with its work pushed). It belongs in QUEUE because it *is* the skip
  nothing counted: a held pull request keeps its project out of the queue
  entirely (`inFlight`), so the project is in none of the numbers above it.
  Yellow, like the line under it — nothing in the runner moves it on its own.
  The page draws the first six and counts the rest; `mc --json` carries every
  one whole, with `note`, `since` and `repairs`.
- **INTAKE** — the newest `~/mc/intake/errors-<date>.md`, its age, what is
  new in it, and how many proposals nobody has queued or dropped.
- **PROGRAMMES** — one heading per programme, with the room for its planning
  session on the right of it, filled or empty; then one numbered row per
  project under it: the repository it lives in, where the plan stands, how many
  of its steps are done, `next`, the open PR. A project's `●` means the runner
  has a step in flight on it, and nothing else. A programme is drawn whether or
  not any of its projects have a plan the runner can read, and a programme that
  exists only as an open planning session is drawn too.
- **WORK** — everything running that the runner did not start, oldest first:
  `mc plan` on a programme is not here (it is on that programme's heading), so
  what is left is `mc work`, a session from before `mc plan` took a programme,
  and a tmux window. Then the workareas no project explains — the first few by
  name and the rest as a count. They were the tail of PROGRAMMES, which made
  that section answer two questions; a folder with nothing to explain it is
  work in the sense this heading means, and is often the same folder a session
  is open in.
- **RUNNER** — the runner's steps in flight, one line per lane (kind, tool,
  model, elapsed against budget, pid), a pending `~/mc/runner/STOP`, the lane
  files whose process is gone, and one line of the day behind it: steps,
  merged, open, failed, timed out, and an estimated **list-price** cost. The
  machine, and nothing else. Under the day, one line for **production**:
  `production <sha> · deployed <age> ago by <holder>`, from the last `deployed`
  row of `~/mc/runner/log/deploys.tsv`. When the `/api/version` the helper last
  cached names another sha, the line says so in yellow — that is a deploy made
  outside the record, or one that did not take, and only a person can say which.
  The line is absent where neither source knows anything.
- **HELPER** and **BRIEF** — one row each, drawn open or not. They are
  singletons, so *"is the helper running?"* is a question an empty row answers
  as well as a full one.

Two rules the sections keep:

- **A number where a number is the answer**, a line only where the identity
  matters — and every count names the verb that expands it, on the right of
  its own heading.
- **A count is only honest if the section says what it cannot see.** INTAKE
  says `first digest — no baseline` rather than `0 new errors`; WORK lists no
  session rather than claiming nothing is running. A zero that
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
| a pull request left unlanded | `~/mc/runner/held.json` (project, repo, pr, branch, reason, note, since, repairs, and — when a gate held it — `red` and `gates` for the repair session to read) | `mc run`, whenever a landing does not land |
| the queue | `~/mc/queue.md` | Martin, at the brief |
| what production said | `~/mc/intake/errors-<date>.md`, `~/mc/proposals/` | `mc helper` |
| what mc deployed | `~/mc/runner/log/deploys.tsv` (sha, build, holder, outcome, the live version verified) | `mc deploy`, before and after |
| what production answers it is | `~/mc/runner/version.json` (`GET /api/version`, with the moment it was asked) | `mc helper --collect` |
| someone is sitting here | `tmux ls`, `~/mc/runner/foreground/<pid>.json` | tmux, `foreground.js` |
| plans and open PRs | `~/mc/runner/plans.json`, `~/mc/runner/prs.json` | the page itself (below) |

`runs.tsv` gets its row only *after* a step ends, which is why
`runner.json` and the `current-<repo>.json` files exist at all: before them,
the fact the page most needed — what is running right now — existed nowhere
a program could read. They are written through `atomic-write.js` and removed
when their scope ends, the removal paired in a `finally` so a step that
throws still clears the file.

There is one current file **per lane**: `mc run` drives memoro's queue and
memoro-cli's at the same time, so RUNNER is a list rather than a line, and the
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
holding the terminal, and leaves no trace on disk. The page would say
"nothing is running" while the machine was busy, which is the one thing it
must never do.

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

`time mc` was 0.09–0.11 s with both caches hit, against 1.92 s for the board
it replaced. (Measured over twelve runs at load average 10 on 2026-08-29; a
busy moment on the same machine pushed single runs to 0.2–0.3 s.) **That
number no longer holds** — see [*What a refresh
costs*](#what-a-refresh-costs) below, which is the same read measured again
while the live page was built. Two changes bought the original figure, and
they are worth different amounts:

1. **One read per repository instead of one per plan.** `listPlans` was
   spending a `git show` per plan — 37 in memoro alone, 1.45 s of the
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

### What a refresh costs

A refresh is one `collectPage` — the identical read a bare `mc` does, with
no model, no session and no write but the two read-through caches above.
So the cost of the page being live is the cost of the page, once every 30
seconds, and the number to know is what that read actually takes now:

| when | `mc --json`, warm | what the machine was doing |
|---|---|---|
| 2026-08-29 | 0.09–0.11 s | the caches hit, quiet |
| 2026-09-02 | 2.4 s, 2.7 s, 4.8 s (and 3.9–6.6 s in a second set) | the runner landing pull requests, several sessions open |
| 2026-09-03 | 1.83 s, 1.11 s, 1.09 s | the runner running, nothing merging |

The spread is not noise and it is not the renderer: `plans.json` is keyed
by the `origin/main` sha, so **every merge invalidates it**, and a machine
whose runner is landing pull requests is a machine where the page is cold
most of the time — exactly when it is most worth watching. The 0.09 s in
the section above is the hit; the seconds above are the miss, and the miss
is the ordinary case under a runner.

Making that read quick is a different problem and deliberately not this
one. What the live page does about it is refuse to be blocked by it: the
interval is a floor measured from the moment the last collect *finished*,
so a read slower than 30 s delays the next frame rather than queueing one
behind it, and there are never two in flight. A 45 s collect therefore
gives frames 75 s apart, not 45 — the machine is left alone between them,
which was the point.

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
they are printed.** RUNNER, QUEUE and PROGRAMMES all say `step` in the same
green, so a kind is recognised before it is read. They are `KIND_TONE` and
`STATUS_TONE` in `page-render.js`, and `tests/mc/page.test.js` walks each one
through all three sections.

| step kind | colour |
|---|---|
| `step` | green |
| `triage` | blue |
| `brief` | cyan |
| `plan` | cyan |
| anything else | grey |

| plan status | colour |
|---|---|
| `ready` | green |
| `blocked` | red |
| `done` | grey |
| `invalid` | red bold |
| no plan on main | dim grey |

Everything else is structure, and structure is quiet:

| where | what | colour |
|---|---|---|
| header | `MEMORO·CLI` | bold white |
| header | `N of M queued` | white |
| header | version, rule, cost today | grey |
| section titles | `RUNNER` `HELPER` `BRIEF` `QUEUE` `INTAKE` `PROGRAMMES` `WORK` | bold cyan |
| section titles | the count beside it, the verb hint on the right | grey |
| RUNNER | the live step's `●`, its name | green, bold white |
| RUNNER | elapsed: under ¾ of budget, from ¾, past it | white, yellow, bold red |
| RUNNER | `■ STOP requested` | bold red |
| RUNNER | a stale runner file | red |
| RUNNER | a quota answer under 6 h old, older | yellow, grey |
| RUNNER | the production sha, the rest of that line | white, grey |
| RUNNER | `/api/version` naming another sha than the last deploy | bold yellow |
| RUNNER | a deploy running now, one that has not come back in an hour | green, bold yellow |
| RUNNER | a deploy that failed after the last good one | yellow |
| RUNNER | between steps, no runner, the day's line, the tool and pid | grey |
| HELPER, BRIEF | the `●` and the verb it is running | cyan |
| HELPER, BRIEF | `·  not open` | dim grey |
| WORK | a session's `●` and its area | cyan, bold white |
| WORK | a tmux window's `◆` | yellow |
| WORK | how long it has been open, under a day, from a day | grey, yellow |
| QUEUE | the next name, the first of them | white, bold white |
| QUEUE | the number, `… N more runnable` | grey |
| QUEUE | why a project was skipped | dim grey |
| QUEUE | `blocker finished N` and the steps under it | bold yellow, yellow |
| INTAKE | the digest's date, under 24 h old, older | green, yellow |
| INTAKE | new errors, when > 0 | red |
| INTAKE | proposals, when > 0 | yellow |
| INTAKE | a `!` line: its mark, its text | red, bold white |
| INTAKE | no digest yet, no new errors, no proposals | grey |
| PROGRAMMES | a project the runner is stepping — `●`, its name | green, bold white |
| PROGRAMMES | a quiet project's name and `next` | white, plain |
| PROGRAMMES | the programme heading | bold cyan |
| PROGRAMMES | a programme's open planning session | cyan |
| PROGRAMMES | a programme with no planning session | dim grey |
| PROGRAMMES | the repository a project lives in | dim grey |
| PROGRAMMES | the open PR number | cyan |
| PROGRAMMES | the number, the steps done, the last-run time, the no-workarea line | grey |
| PROGRAMMES | a workarea row with no project on main | grey throughout |
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
  prints what it printed before this palette, with one exception: a row's mark
  is drawn always, not only when colour is on, because a mark that appears with
  colour would make a coloured row wider than its plain twin. It sits inside
  the row's own footprint, where two of the seven
  leading spaces used to be. Everything else is byte-identical, at six widths,
  against the same fixtures.
- **`--watch` is gone** (2026-08-29): it cleared and redrew on a timer, which is not a live page. The real one arrived on 2026-09-03 and writes only the rows that changed — [*The live page*](#the-live-page).

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
| a number | opens that project's workarea, making one if it has none — **PROGRAMMES’ number**, not a listing of its own |
| a name | opens that workarea |
| `n` | starts a new one |
| `b` | `mc brief` |
| `p <name>` | `mc plan <name>` |
| `s <name>` | `mc status <name>` |
| `q`, empty | quit |
| anything else | parsed as an `mc work` command, with or without its first two words |

The menu asks `inspectWorkArea(name).exists` rather than looking for a
PROGRAMMES row, because the page draws projects and the folders that hold a
checkout, and `mc work` offers to make an area with no repository in it.
Using the rows would have kept the typo guard and stranded the empty area
under the only name it has.

The prompt reads `/dev/tty` by design, so a subprocess without a terminal
never reaches it.

## The live page

The page under that prompt keeps telling the truth. **Every 30 seconds the
rows that changed are rewritten where they stand, and nothing else on the
screen is written to at all** — not the scrollback above, not the two key
lines, not the prompt, not the cursor in whatever the person is half-way
through typing. The page is not reprinted and the screen is not cleared:
that was `--watch`, and it is why `--watch` went.

Two modules, and the split is the same one `page-render.js` already keeps:

- **`page-frame.js`** knows about terminals and nothing about time. Given
  the lines on the screen, the lines that should be, and where the page sits
  relative to the cursor, `frameWrites` returns the bytes that turn the first
  into the second — and the empty string when they are the same. It is pure,
  so every case below is asserted as bytes in `tests/mc/page-frame.test.js`
  with no terminal involved.
- **`page-live.js`** is what runs while somebody is sitting in front of it:
  the timer, the reading of the line, and the arithmetic that says where the
  page is relative to the cursor. `liveReader` is what `home.js` hands the
  menu instead of a plain `ask`.

### What is written, and what is not

Every move is relative — `CSI n A`, `CSI n B`, `CSI 2K` — unless the terminal
has said where the cursor is, in which case it is `CSI row;1H`. An absolute
row the page *guessed* would be wrong the moment anything else wrote to the
terminal: the page has no claim on the screen, it lives in the scrollback
with whatever was printed before it, and what is below it belongs to somebody
else. An absolute row the terminal *reported* is the safer of the two, and
[*How the page finds itself*](#how-the-page-finds-itself) is why. Four cases,
each decided rather than fallen into:

| the frame | what happens |
|---|---|
| unchanged | **no bytes at all** — not a redraw of identical text. A terminal that receives nothing is the only way to be sure nothing flickered |
| a row changed | one move up to that row, `CSI 2K`, the row, one move back. Rows that did not change are not touched |
| fewer rows than before | the surplus rows are **cleared where they stand** and the page keeps its footprint |
| more rows than before | the page is **reprinted**: `CSI 0J` from its first reachable row, then the frame as ordinary lines |

The whole write of an ordinary frame is `\x1b7`, the writes, `\x1b8`, in one
`stdout.write` so nothing can interleave with it. The prompt row is not
among the rows it touches, which is what puts the cursor back in the column
it was in without anybody having to know what that column was.

**Shrinking keeps the footprint** because `CSI M` (delete line) would close
the gap by pulling the menu and the prompt up a row and dropping whatever is
at the bottom of the screen — rows the page does not own. A blank row the
page printed is the page's to blank. The visible price: a page that loses
rows leaves blank rows above the key lines until some later frame grows and
reprints.

**Growth is the case that can damage the scrollback**, so it is the one
written down at length. A frame with more rows than the last has grown past
the footprint it was printed in, and everything below its last row belongs
to the caller, so no in-place write can be right. The reprint lets the
terminal scroll at the bottom exactly as the first print of the page
scrolled it, which is what puts a line into the scrollback once and intact.
`CSI L` (insert line) was rejected for the opposite reason: it shifts the
region down without scrolling anything into the scrollback, and silently
drops the bottom row of the screen. The cost is paid by the loop rather than
hidden — after a growth frame everything below the page has been erased, so
`page-live.js` prints the key lines, the prompt and the half-typed answer
again itself.

### How the page finds itself

**The page asks the terminal where it is.** After the page, the key lines and
the prompt are printed, `page-live.js` writes `CSI 6n` — Device Status Report,
cursor position — to the terminal and reads the reply, `ESC [ row ; col R`,
off the `/dev/tty` stream it already holds in raw mode. `readLine` is what is
listening, so the reply is recognised there and handed on as a row; nothing of
it reaches the line being typed and nothing of it is echoed. That row is the
`anchor` every frame is then written against: page row `i` is
`anchor - above + i`, addressed with `CSI row;1H`.

**Why asking, when `above` was already derived.** Because a derived number can
be wrong and a relative walk turns one wrong number into a wrong page.
`frameWrites` used to move from row to row with `vertical(target - row)`, so
an `above` that is one short puts *every* write one row low: the row that
should have been rewritten keeps the old text, the row under it gets the new,
and the page shows one session twice with two ages. Martin saw exactly that
twice on 2026-09-04 — `● items-sweep … 28 min` over `● items-sweep … 25 min`,
same pid, one entry in the data. The number was one short for a plain reason:
`tailRows` counted the newlines in the menu's block, and the menu's first key
line is 85 characters, which is two screen rows on a terminal narrower than
that. Both halves are fixed — `screenRows` counts wrapped rows rather than
newlines, and the anchor makes the moves absolute so no error can accumulate
from one row to the next.

**When the terminal will not answer**, which some do not, the page waits
`ANCHOR_MS` — 200 ms — and then goes on exactly as it did before: derived
`above`, relative moves, and one line in the note row saying
`mc: drawing by count — the terminal did not say where the page is`. Said once
per reader, not once per prompt, and taken off the screen by the next frame.
The prompt is never blocked on the answer: the reading of the line starts
before the question goes out.

**A reprint and a resize both invalidate the anchor**, so both ask again — a
growth frame scrolls the screen, and a resize moves the prompt. A reply that
arrives after the 200 ms is still taken; a row the terminal gave is worth more
than a row the page counted.

### The two numbers, and the two terminals that break them

`above` is how many rows above the cursor the page's first row sits: the
page's footprint plus the rows the block the menu prints under it occupies on
screen. `rows` is the terminal's height, and it bounds how far up the writes reach —
the cursor is on the last row of the screen, so `rows - 1` rows above it are
addressable and **a changed row further up than that is not written at
all**. That is what makes a page taller than the terminal safe: the page is
96 rows at the current `~/mc`, taller than most terminals, and what has
scrolled off the top is history. History is not rewritten and not scrolled
back to.

**Narrower than 60 columns, the page is not live.** `columnsFor` clamps to a
floor of 60, so below that every row is wider than the screen and wraps, and
every row of the arithmetic above is then off by the number of wrapped rows
between the cursor and the page. `readerFor` in `home.js` hands such a
terminal `plainReader` instead — the page printed once and the line read the
way it always was. That is also the reader the front-door tests drive, so
the not-live path is not one that nothing exercises.

**A resize does not redraw at once.** `process.stdout`'s `resize` marks the
frame invalid rather than the page — the widths were computed for the old
columns — and the next refresh reprints the page whole instead of diffing
against lines that no longer describe the screen. For up to 30 seconds a
resized terminal therefore shows the page that was drawn for the old width.

### Why the reading had to change

`prompt.js` reads a line with a blocking `readSync`, and blocking is the
whole problem: no timer fires while the process is parked in a syscall. The
live reader borrows `/dev/tty` the same way — its own descriptor, never
`process.stdin`, so the tool mc launches next inherits an untouched terminal
— but reads it asynchronously, and **in raw mode**.

Asynchronous alone would have been enough for the interval, and would have
kept the terminal's echo, backspace and kill-line for free. It would not
have been enough for a growth frame: that frame is a reprint, and in
canonical mode the typed characters sit in the kernel's line buffer where
this process cannot see them, so a growth frame would blank a person's
answer off the screen while still, invisibly, holding it. Raw mode is what
makes *half-typed input survives* true in every frame rather than in most of
them. Its price is that the echo, the backspace, ctrl-u and ctrl-c are ours:
`readLine` in `page-live.js`, and about forty lines. Arrow keys and anything
else arriving as an escape sequence are swallowed rather than echoed as
rubbish — the menu has no history to walk through.

**A collect that throws leaves the last good frame on screen** and says so
in one line, written into the blank row the menu prints between the page and
the keys — a row the loop can write without the page growing and without
anything scrolling. A live surface that blanks on a transient failure is
worse than one that says it is holding an old frame.

**Quitting gives the terminal back bit-for-bit.** Raw mode is restored
before the descriptor is closed, and then one read that looks pointless and
is not: macOS sets `PENDIN` — *retype the pending input* — in the terminal's
flags on every switch back to canonical mode, whether or not anything is
pending. Measured 2026-09-03 in a pty: `stty -g` before and after `mc`
differed by exactly that bit, with an empty input queue, and it does not
clear on its own. The driver clears it the first time it services a read, so
`closeInput` opens `/dev/tty` non-blocking and reads once — `EAGAIN`, the
ordinary case — and the terminal is then identical to the one mc was handed.
`q` and ctrl-c leave the same way, and the last frame stays in the
scrollback.

### What was checked in a real terminal

The bytes and the timing are unit tests — `page-frame.test.js` on the four
cases, `page-live.test.js` on a fake clock — and they cannot say what a
terminal does with those bytes. `scripts/mc-live-page-check.mjs` runs the
real `mc` in a real pty against a fixture work root and reads the screen back
with `@xterm/headless`. It is **not part of `npm test`**: it takes five and a
half minutes, because the interval is 30 s and there is deliberately no way
to configure it.

It passed whole on 2026-09-03 — ten refreshes 30 s apart, the marker line
above the page still there and still once, `PROGRAMMES` on the screen once
rather than printed again under itself, a `1` typed before the first refresh
still at the prompt with the cursor after it, backspace taking it back, `q`
leaving with exit 0, no alternate screen buffer (`\x1b[?1049` never written),
and `stty -g` identical before and after. What it does not do is press return
on that `1`, because that opens a workarea and launches a tool on the machine
it is running on. That the reader hands back `1` after a refresh is asserted
in `page-live.test.js`, and that `1` opens the project PROGRAMMES numbered
`1` is asserted in `front-door.test.js`; the join between the two is the only
part nobody has run.

## The modules

| file | what it is |
|---|---|
| `src/mc/commands/home.js` | the two surfaces: the page and the menu |
| `src/mc/page-collect.js` | the five sections, built from read data |
| `src/mc/page-render.js` | how they look |
| `src/mc/page-frame.js` | the difference between two frames, as bytes — pure, no terminal |
| `src/mc/page-live.js` | the loop under the prompt: the 30 s interval, the raw-mode reader, the arithmetic |
| `src/mc/page-cache.js` | `plans.json` and `prs.json` |
| `src/mc/status-collect.js` | the readers more than one caller needs — `nowBlock`, `kindFor`, `pidAlive`, `areasWithCheckout` |
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
and the opening handed in, so a number can be shown to open the project
PROGRAMMES gave that number to without a session ever starting. It is also
where the piped page is pinned: `mc | cat` and `mc --json | cat` exit 0 with
no `\x1b` anywhere in stdout, every section heading exactly once, and
`--json` a single document that re-serialises to itself.

One seam worth knowing about: `interactive()` reads the *process* streams
while `colourFor` and `columnsFor` read the stream handed to `run()`. From
the CLI they are the same object, so nothing reachable today can disagree —
but a caller that handed `run()` a non-TTY stdout while the process's own
stdout was a terminal would print a plain page and then go live on it. If a
future surface ever calls `run()` with deps, `interactive` is the line to
fix, and the fix is to have it take the same stream.

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

The live surface came last, as `docs/project/mc/mc-live-page/`, in four
steps: the frame differ
([#544](https://github.com/martinforsberg81/memoro-cli/pull/544)), the loop
that does not interrupt the prompt
([#546](https://github.com/martinforsberg81/memoro-cli/pull/546)), the piped
page pinned as bytes
([#547](https://github.com/martinforsberg81/memoro-cli/pull/547)) and this
close-out. It added no section, no datum and no flag either: the page that
refreshes is the page above, and 30 s is one number, chosen, with no way to
configure it until there is a reason for another.
