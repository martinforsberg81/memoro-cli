# mc — the page

`mc`, typed alone, is the one page. It lists programmes and goals, sessions,
merges and the desks. At a terminal it refreshes changed rows in place every
30 seconds without disturbing the prompt. Without a TTY it prints once,
exits 0 and writes no escape byte. `mc --json` prints the same data the
renderer takes, not a second reading.

## The surfaces

| command | what it does |
|---|---|
| `mc` | the page; at a terminal, then the menu and live refresh |
| `mc --json [--fresh\|--offline]` | the same data as one JSON object |
| `mc --fresh` | fetch and ask GitHub before drawing |
| `mc --offline` | no fetch; read local records and cached PRs |
| `mc goal show <programme>/<goal>` | one goal, its criteria, recent log and worktree state |

`commands/home.js` asks GitHub at most once per five minutes on the live
page, including after a failure; `f` asks immediately. A pipe reaches the
network only with `--fresh`. Goals are read from `~/mc/programs/` on every
draw, never from a repository checkout. Projects went on 2026-11-03; see
[mc-goals.md § From a project](mc-goals.md#from-a-project) for migration.

## The sections

`renderPageLines` draws PROGRAMMES followed by three work panels: MERGE & DEPLOY, DEV
and MAINTENANCE. Orange opening and closing rules distinguish these
panels from cyan programme boundaries. SYSTEM follows a horizontal separator
at the bottom, containing MC, runner diagnostics, Docker when present and BILLING. There is no
separate SESSIONS section. A stopped language run inside an open gap still
puts its warning above everything else.

One `a` / `all` toggles all folded content and details across the page;
the next press returns to the normal view. Current sessions, blockers,
malformed goals, open PRs, merge failures and process/resource warnings
remain visible in both modes. Normal headings use spacing and indentation,
without repeated table headers; programme blocks have opening and closing rules.

### PROGRAMMES

Nonzero programme priorities appear on the programme heading. Type
`priority mc inbox --set 10` at the page prompt to set one or several; zero
resets them. This calls the same verb as `mc programs priority`, then redraws.
The live refresh key also changes when a priority changes in another terminal.
Scheduling first prefers blocked recovery, finish/merge, review, build, then
next-step planning; programme priorities decide within a rank after repository
shares. See [mc-run.md](mc-run.md#the-pick-in-order).

`programmesSection` and `goalsOf` (`page-collect.js`) build programme → phase
→ goal → PR. Each programme is a bounded block with a bold name and cyan
opening/closing rules. Each phase has its own bold cyan heading. All unfinished
phases and goals are visible, including future phases labelled `after phase N`.
Only finished history folds by default; `a` expands it. Malformed goals appear
under NEEDS ATTENTION, without an inferred phase.

Each numbered goal title is followed immediately by `stage build · status ready
· criteria 1/3`, rather than distant right-aligned columns. Status is exactly
`ready`, `blocked` or `Martin`; stage is the stored stage. There is no derived
availability classification. Running activity, phase holds and invalid-record
warnings are separate information, not replacement goal statuses. Criteria
met/total remain visible in both modes; narrow terminals put criteria on their
own line when needed. Missing counts are shown as `—`, not invented zeroes.
Repository, technical name, session count and latest log detail appear with `a`.
Menu numbers remain stable in programme/name order across phase moves and
history folding; a number opens that goal's detail.

Each live runner session is matched by its explicit programme/goal identity
(`goal`, or the legacy `goal:` name) and shown beneath that goal, before its
PRs. The activity row carries kind, elapsed time, tool/model and credits when
used. A tight rounded frame encloses just this live session data, with green
borders for build, blue for plan and magenta for review. Long activity wraps
inside the frame within the terminal width. Positive check-in counts appear
at the end of the activity inside the frame, in yellow, and its yellow clock
remains visible without expansion; repository, advisor, pid and zero check-ins
are expanded details. A session
with no matching goal appears under UNASSIGNED ACTIVITY, including its name
and PR references, so removing SESSIONS cannot hide it. Rendering joins the
existing `runner.sessions` and programme records; their JSON shapes remain.

Foreground plan/programme sessions appear directly below their programme
heading, including programmes that otherwise count as dormant. Quiet dormant
programmes fold into a single count; `a` shows every programme. The collector's
active/dormant classification and full JSON listing remain unchanged.

Every open PR remains a child of its goal, or in PRs without a goal under its
programme. Explicit plan branches retain ownership even in scratch worktrees.
Attached PRs carry `programme` in JSON and are excluded from the loose PR list.
Goals handed to the merger retain `stage merge`, without a session frame.
Their PR children say `in queue` or `merging`, including PRs whose queue
records arrived before the GitHub cache refreshed.
Unowned sessions and directories remain visible as strays.

### MAINTENANCE

Each repository has a named block, always including memoro and memoro-cli.
Its status dot is red for loud errors, critical dependencies or failed full
tests; yellow for missing/old measurements or high vulnerabilities; green for
current readings without those findings. Child rows show error fingerprints
(total, new and loud, with digest age), the last full test (age, commit and
result), and the dependency reading (age, commit and severity counts).
Unknown measurements stay unknown, including new counts before a baseline.
These replace the separate CHECKS section and the maintenance column table.

Helper status and its last recorded collection sit below the panel title.
Root proposals appear under their repository; untagged root proposals follow
the repository blocks. Programme-owned proposals stay on their programmes.
`a` adds the recorded loud error details. Missing readings and failures stay
visible in both modes; long details wrap at narrow terminal widths.

### DEV

`page-operations.js` draws one row per environment: MAIN or SLOT, its
port/address, projected state, holder stage and programme/goal in separate
columns, without repository headings. Long holder names are clipped to the
terminal width. `holder gone` stays visible in yellow on the same row for a
recorded session holder whose pid is not alive, independent of idle state.
`a` adds full URL, service, last-use age,
branch and worktree. Ports no longer occupy a PR column. Queue rows show the
recorded holder and elapsed wait in queue order, the first three normally and
all with `a`.

`readPool` / `devSection` (`dev-pool.js`) project registry and queue records;
they do not probe HTTP health. `readPool` leaves registry records unswept,
filters servers and queue tickets by pid liveness, and reads the main checkout
record. `starting` is only a recent-registration heuristic: no recorded use or
holder and registration within `STARTING_SECONDS`. It is not evidence that a
server has not answered. `running` counts projected server rows that are not
`starting` (including idle rows), not servers confirmed to answer. `leased`
uses the recorded holder and last-use age against the configured stale window;
a bare-verb holder is not treated as a gone session and remains leased until
that window expires. `cold` is not produced by this DEV projection. The
collector does not sweep or rewrite the registry or queue; dead records await
a writer. These semantics describe the current projection, not server health.

### MERGE & DEPLOY

One panel groups both repository merge lanes and memoro deployment evidence.
Columns are separated by whitespace; middle dots separate data only within a
column. Repository names occupy an aligned column; their queue summaries show `queue
empty` or `4 in queue: #1 #2 #3 #4` in landing order. Every waiting reference
is visible in the normal view, wrapping within the terminal width; the active
merge is excluded from that queue. `a` adds branches, queue ages and 24-hour
landing history. Queued entries without a PR
number remain counted and say `PR unknown`.

Indented operation rows align the action/PR with its status: `merging #123`,
a phase bar, short state, elapsed time and the recorded phase message. The bar
marks prepare `[●··]`, gate `[━●·]` or land `[━━●]`; it is a stage indicator,
not test completion or a time-based percentage. Missing phase evidence uses
`[···]`. Active rounds and every failure remain visible. Pauses, stopped
mergers and batch membership retain their own rows. Each repository has a
conditional FAILED MERGES area: every failed PR shows live plan recovery
(tool/model, elapsed time and PID), waiting for recovery, waits on Martin, or
no recovery session. Activity must match the owning goal and a live plan runner;
an unrelated or dead session is not recovery. A short one-line reason replaces
CLI instructions; complete diagnostics stay in JSON and logs. Requeued PRs
leave the failed area. Empty
lanes explicitly say idle; queued lanes without an active round say waiting.
Direct goal merges have no gate round: a `landing` queue record owned by a
live merger supplies their active row. A dead owner remains in the waiting
queue. A ready goal in `merge` also supplies any PR missing from the queue
during handoff, excluding recorded failures and PRs already logged as landed.

DEPLOY is a subsection of the same panel, for memoro. Its aligned LIVE,
RECORDED and ATTEMPT rows keep the cached version reading, successful deploy
record and last attempt distinct. A live attempt says running and `progress
unknown`: the record supplies no completion fraction. Failed/refused attempts,
missing end records and live/recorded mismatches stay visible. Expanded details
include build numbers and record timestamps. Language status remains inside
this combined panel. DEV follows it as a separate panel.

### Related work and system details

MERGE & DEPLOY includes a conditional **PRs outside goals** group for open PRs not
represented by a programme, running session or merger. Its counts describe
that group only; `mc prs` still lists every PR. Empty groups disappear.
LANGUAGE lives inside MERGE & DEPLOY when cached readings or a run have something
to report. The stopped-language-gap warning remains above the work.

A horizontal SYSTEM separator places installed-code/update/draining information,
runner liveness and occupied/configured lanes, resource holds, Docker,
provider usage and daily statistics below the work. STOP, stale records,
GitHub failures and quota warnings remain visible; reasons and billing wrap.
Disk and memory values still come from the runner's hold records, not a new
resource sampler. A dead runner's old resource holds do not describe now.
While a live runner stops new sessions for disk, memory or STOP, a short
consequence also appears above PROGRAMMES; full readings remain in SYSTEM.
A stopped runner has the same nearby warning with its restart command.
`a` shows the full daily outcome/cost breakdown.

## Where the facts come from

| fact | file or reader | writer |
|---|---|---|
| goal brief, stage, status, phase and criteria | `programs/<p>/goals/<g>/GOAL.json` | `mc goal` |
| session count, question and last action | the goal's LOG.md | sessions and runner |
| runner liveness and code | `runner/runner.json` | runner |
| live session | `runner/current-<repo>[-<lane>].json` | runner, for its lifetime |
| session outcomes and usage | `runner/log/runs.tsv` | runner and merger |
| queued merges and reds | `runner/merges.json` | queue verbs and merger |
| round in flight | gate lock joined by `runningMerges` (`merges-collect.js`) | gate round |
| merge counts and last landing | mc home's `gate-rounds.jsonl` | completed rounds |
| desks and planning sessions | foreground records and tmux processes | launchers |
| open PRs | `runner/prs.json` | runner and fresh page reads |
| digest and proposal counts | intake digests and proposal filenames | helper and sessions |
| production | `runner/log/deploys.tsv`, `runner/version.json` | deploy, helper |
| container runtime | mc home's `docker/state.json` | Docker verbs and runner |

Paths without `~/mc/` in this table are relative to the work root.
`pidAlive` is the liveness test: a current file naming a dead pid is stale,
not a session. Current files are atomic and removed in a finally. The row
count follows the configured total lanes, including idle lanes; a current
file above a reduced setting still gets a row until its session ends.
Foreground records (`foreground.js`) make inherited-stdio conversations
visible without pretending they are tmux sessions.

## Layout and width

Each surface uses a layout suited to its information: the programme tree,
environment addresses, repository queues and version evidence. The retired
lane/PR grid has no remaining renderer. `page-grid.js` retains the shared
palette, duration and numeric-safe clipping helpers.

Widths stay clamped to 60–160 columns. Programme titles use their own line, with stage, status and criteria directly below; repository metadata is in expansion. Whole PR
references get child rows. Operational reasons wrap and ordinary title cells
clip with an ellipsis without splitting numeric tokens. Colour is applied
after measurement, so painted and plain frames have identical text/width.
Below 60 columns the existing non-live terminal path remains.

## The palette

A kind and a state each have one colour wherever that word is printed.
The tables below are read against `KIND_TONE` and `STATE_TONE` by
`tests/mc/page.test.js`. They include shared palette words, not a promise
that every word has a row on today's page.

| kind | colour |
|---|---|
| `build` | green |
| `review` | magenta |
| `triage` | blue |
| `manager` | cyan |
| `brief` | cyan |
| `plan` | blue |
| `gate` | green |
| `wait` | grey |
| `red` | red |
| `goal` | grey |
| `idle` | grey |
| any other kind | grey |

| state | colour |
|---|---|
| `ready` | green |
| `running` | green |
| `landing` | green |
| `review` | green |
| `merge` | green |
| `queued` | green |
| `gate` | green |
| `rebase` | green |
| `leased` | green |
| `waiting` | yellow |
| `unmet` | yellow bold |
| `blocked` | red |
| `red` | red |
| `paused` | red |
| `stopped` | red |
| `failed` | red bold |
| `invalid` | red bold |
| `open` | grey |
| `done` | grey |
| `dropped` | grey |
| `idle` | grey |
| `cold` | grey |
| any other state, or none | grey |

Green means in hand, yellow waiting, red a fault or a person needed, grey
bookkeeping. A goal's stage/status rules above refine its state cell. A PR
is green while landing, red bold after a red, yellow bold when quiet for a
day, grey once landed, and cyan bold otherwise. Primary text uses the
terminal's own foreground. The page maps the shared palette's `grey`
bookkeeping tone to standard ANSI white (SGR 37), not dark grey (SGR 90),
so secondary text stays legible on dark backgrounds. There is no dim text.
Work-panel rules use orange (256-colour SGR 38;5;208). Other colours still
depend on the terminal palette; NO_COLOR and non-TTY output carry no escapes. Painting
happens after clipping plain text so no escape sequence is cut. Plain and
painted rows occupy the same columns.

## The menu

| answer | action |
|---|---|
| a goal's number | `mc goal show` for that numbered goal, then redraw |
| `a` / `all` | toggle all folded rows and details across every surface |
| `m` / `manager` | open Manager (`b` / `brief` remain aliases) |
| `p [<programme>]` | open plan, asking which programme if unnamed |
| `f` | ask GitHub now and redraw |
| `start`, `stop [--force]`, `update [--force]`, `lanes [<n>]` | the runner order, then redraw |
| `q`, empty | quit |
| anything else | explain the unrecognised or retired verb, then redraw |

The reader uses `/dev/tty`, not the stdin the next tool inherits. A number
shows a goal; it starts no coding session. `pageKey` includes every goal's
programme, name, title, phase, stage, status, phase hold, criteria and running mark, plus session identity and check-ins. If
that key changes while the top of the page is off-screen, the live reader
prints the page whole so scrolling up finds the new state. Clocks alone do
not trigger that reset.

## The live page

The page under that prompt keeps telling the truth. **Every 30 seconds the
rows that changed are rewritten where they stand, and nothing else on the
screen is written to at all** — not the scrollback above, not the two key
lines, not the prompt, not the cursor in whatever the person is half-way
through typing. An ordinary frame does not reprint the page or clear the
screen: that was `--watch`, and it is why `--watch` went. The few frames that
cannot be written in place are printed whole from an empty terminal — see
[*Growth*](#what-is-written-and-what-is-not) below.

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
| more rows than before | the page is **printed again whole**: `CLEAR_ALL` (`CSI H`, `CSI 2J`, `CSI 3J`), then the frame as ordinary lines |

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
to the caller, so no in-place write can be right. It is printed whole, and so
are the two other frames that cannot be diffed — one drawn for a terminal
that has since been resized, and one whose key moved while the top of the
page is off the screen. Every whole print starts from an empty terminal:
`CLEAR_ALL` — cursor home, erase the screen, erase the scrollback — then the
page's lines each ended by a newline, exactly as the first print wrote them,
then the key lines, the prompt and the half-typed answer, which
`page-live.js` prints again itself because the clear took them. `a`, `f` and
the page drawn again after a verb (`show`) clear the same way. The terminal
scrolls at the bottom as the first print scrolled it, so the tab only ever
holds the current page plus whatever scrolled off since the last whole print.
Before 2026-11 a whole print erased from the page's first reachable row
(`CSI 0J`) and printed under the old copy, and since the page is taller than
most screens every one of them left another page in the scrollback — after a
few hours an endless scroll of old pages. The price of the clear is stated:
the first whole print also clears whatever was in the terminal before `mc`
started. `CSI L` (insert line) was rejected for the opposite reason: it
shifts the region down without scrolling anything into the scrollback, and
silently drops the bottom row of the screen.

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

**The footprint is what the print left, and every print leaves the same.** The
first print and every whole print end each line with a newline, so the cursor
comes to rest one row below the last row and the footprint is the number of
lines. It was not always one number: a growth frame used to *join* its lines,
leaving the cursor **on** the last row — one row higher — and counting
`next.length + tailRows` after it was one row out. One row out is a page that
lies: `CSI 2K` clears the neighbour of every row it meant to rewrite and the
row that changed keeps its old text. Measured at 45 rows × 120 columns on a
97-line page, 2026-09-06 — eleven programme rows reached the screen as
four. `tests/mc/page-live.test.js` holds that shape in `@xterm/headless`.

**Narrower than 60 columns, the page is not live.** `columnsFor` clamps to a
floor of 60, so below that every row is wider than the screen and wraps, and
every row of the arithmetic above is then off by the number of wrapped rows
between the cursor and the page. `readerFor` in `home.js` hands such a
terminal `plainReader` instead — the page printed once and the line read the
way it always was. That is also the reader the front-door tests drive, so
the not-live path is not one that nothing exercises.

**A resize does not redraw at once.** `process.stdout`'s `resize` marks the
frame invalid rather than the page — the widths were computed for the old
columns — and the next refresh prints the page whole, from an empty terminal, instead of diffing
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
on that `1`, because that exercised the interactive menu rather than the refresh loop.
Today a number shows the goal PROGRAMMES numbered; `front-door.test.js`
checks that routing without opening a coding tool.

## The modules and tests

- `src/mc/commands/home.js`: page, arguments, menu, freshness and restart on new code.
- `src/mc/page-collect.js`: pure section builders plus the machine-facing collector.
- `src/mc/page-render.js`, `page-programmes.js`, `page-activity.js`, `page-operations.js` and `page-grid.js`: page composition, work tree, activity, operations, widths and palette.
- `src/mc/page-cache.js`: the PR cache.
- `src/mc/dev-pool.js`: DEV's data — `readPool`, the one reader of the dev-server pool, and `devSection`.
- `src/mc/dev-holder.js`: who holds a dev server — `leaseHolder`, written when a verb takes one, and `holderLabel`.
- `src/mc/merges-collect.js`: running rounds joined to repositories and holders.
- `src/mc/page-frame.js` and `src/mc/page-live.js`: frame differences and live reader.
- `src/mc/status-collect.js`, `status-render.js`, `foreground.js`: shared readers,
  primitives and foreground records.

`tests/mc/page.test.js` builds sections from fixtures, compares the palette
tables and checks painted/plain widths. `tests/mc/front-door.test.js` pins
menu routing and piped output. `tests/mc/page-live.test.js` and
`tests/mc/page-frame.test.js` cover refresh arithmetic without launching a tool.

## Manager header

The framed MC header separates active and dormant programmes, in-flight
sessions by kind, and goals by status and stage (including zero counts and
terminal stages). Goal totals cover the current programme goals, excluding
archives. Waiting proposals include programmes and the root; the daily cost
uses the existing list-price estimate. Throughput shows completed build,
review and plan sessions and merged PRs over the last 24 hours, followed by
the latest successful deploy date in UTC (or `none recorded`). Complete fields
wrap within the frame on narrow terminals. `mc manager` (or `m` at the page
prompt) opens the session for priorities,
blockers and proposals across all programmes. Manager's open state is shown in
the header, including foreground records from before the rename.

Maintenance groups repository measurements beneath their names. Below its
title it carries the interactive helper's open state and last collection from
runs.tsv, including a failed run or an explicit absence of a record.
