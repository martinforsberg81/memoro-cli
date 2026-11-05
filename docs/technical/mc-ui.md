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

`renderPageLines` in `src/mc/page-render.js` draws PROGRAMMES, MAINTENANCE,
SESSIONS, DEV, MERGES, PULL REQUESTS, DEPLOY, LANGUAGE, CHECKS, the optional
Docker line, MC, and BILLING directly below MC. A stopped language run
inside an open gap puts its red warning above them all. Optional sections
with nothing to say are not drawn. What changes less sits above what changes
more, so activity stays within reach of the prompt; DEV changes as often as
the sessions do, so it stands right under them.

### PROGRAMMES

`programmesSection` and `goalsOf` (`page-collect.js`) build a tree:
programme → phase → goal → PR. `page-programmes.js` draws it with its own
columns, independent of the lane grid. Each programme carries `current_phase`,
numeric `phases[]` with their goals, and `availability` counts. The flat
`goals[]` and raw `statuses` remain in JSON for existing consumers. Goals
carry their title, phase, stage, status and derived availability.

The lowest unfinished, valid phase is current. All unfinished goals within
that phase appear together. Quiet future phases collapse into a numbered
summary; finished goals collapse into a Finished group. `a` expands future
phases, finished goals, detail rows and dormant programmes, and toggles them
back. A future phase with a blocker, malformed record, running work, a goal
awaiting merge or an open PR stays visible. Finished goals with open PRs
also stay visible. Malformed goals have no inferred phase and appear under
NEEDS ATTENTION. Collapsed and expanded phases retain numeric order.

Each goal row has its stable menu number, title (falling back to its name),
stage and state. Repository is secondary and appears from 100 columns up;
expanded metadata includes all repositories, the technical name and session
count. Numbers remain stable in programme/name order across phase grouping
and folding. `<n>` opens that goal's detail. Latest Next or Comment appears
only in expanded detail; finished detail shows Done or Comment instead of
an obsolete Next. Blocker questions and parse errors remain visible by default.

Availability distinguishes running, can start, waiting for phase, needs plan,
needs criteria, awaiting merge, blocked, invalid and finished. The summary
and brand's ready count use phase eligibility, excluding running and finished
goals, future phases, planning and builds without criteria. This uses
`goalSession` for eligibility; runtime resource holds remain in SESSIONS.
Summary parts wrap at terminal width without losing blocker counts or colours.

Every open PR is a child row under its goal, showing the full repository/PR
reference, title and state. Programme PRs without a goal have their own
PRs WITHOUT A GOAL group. Explicit `plan/<programme>` branches retain their
association in scratch worktrees. Attached PRs carry `programme` in JSON and
are omitted from loose PULL REQUESTS rows. `mc prs` still lists every PR.

Programme headings retain plan sessions, goal and proposal counts, and a
cyan rule. Cyan marks structural headings; running/startable work is green,
phase waits yellow and blockers red. Names use the terminal foreground.
Dormant programmes have no goals or standalone PRs and fold into one line;
a planning session alone does not make one active. Strays follow under
`not an area mc knows`, with the facts needed to inspect them.

### MAINTENANCE

One row per repository, always including memoro and memoro-cli. Each starts
with a large `●`: red for loud errors or critical dependencies, yellow for
missing or old readings or high vulnerabilities, green for a current reading
without those findings. Columns show total error fingerprints in the digest,
new and loud errors, dependency vulnerabilities by severity, root proposals
by system (`mc` belongs to memoro-cli), and the digest's age or missing state.
Unknown measurements are `?`, including new counts before a baseline exists.
Below 100 columns, dependency critical/high become C/H and moderate/low give
way. Untagged root proposals and open helper/brief sessions follow the table.
Programme-owned proposals remain on their programme headings. Full error
messages and proposal filenames remain in JSON and the digest.

### SESSIONS and BILLING

The heading says `n of N lanes` (bold green while nonzero), or `not running`
in bold yellow. One grid row per lane: idle is its number and `idle`; a live
session is `PLAN`, `BUILD` or `REVIEW`, `programme/goal`, repository, `running`,
elapsed time and the goal's PRs (`#N+2` for more). The grey tail is model,
`credits` for API billing, advisor and check-ins. Elapsed turns yellow past a
check-in; nothing on a lane row is bold and length alone kills nothing.

Rows fill oldest first. A pending STOP, stale current files, GitHub failures,
disk or memory holds and quota observations follow the lanes, then the day's
outcomes by session kind and list-price estimate. JSON carries
`runner.sessions`, `runner.lanes` and `runner.day.by_kind`. Session kinds are
plan, build and review; builds and reviews carry variant `goal`. The tool
and pid stay in JSON, not on the row. BILLING is a line showing both providers'
plan usage and next billing route, directly below MC at the foot of the page.

### DEV

The dev servers, and the session that holds each (goal `mc/dev-section`,
Martin 2026-11-03). The heading is `DEV  3 running · 1 leased · 2 queued`
with `mc dev list` on the right: `running` is the servers that answer (not
`starting`), bold green while not zero; `starting` is said only when one is,
and `queued` only while somebody waits, in yellow. No server at all: `DEV
none running`, grey.

Under it one grid row per live server: a large status circle at the left
margin, green while leased, yellow while starting or when its holder is gone,
grey while idle; `MAIN` for the shared checkout's standing server (`mainCheckout`),
`SLOT` for one lent to a worktree; the holder in the name column —
`BUILD mc/no-work`, `REVIEW mc/email-compose`, `plan mc`, `brief`, or the
verb (`shot`, `test`, `open`) when no session ran it; the repository;
`leased`, `idle` or `starting`; how long since mc used it; the port in the PR
column; the branch and the worktree in the tail. A holder that is a session
whose pid is gone says `holder gone`, yellow, first in the tail, and its
server is `idle`. A bare verb's holder never does: it was over when it
answered. The waiters are one yellow row under the servers, `2 queued · BUILD
hero-detail-objects first`.

**Who holds a server is written when it is taken**, never guessed from the
worktree: `ensureDevServer` — under `mc shot dev`, `mc test dev` and `mc dev
open` — writes `holder: { kind, owner, name, pid }` (`leaseHolder`,
`dev-holder.js`) and `held_since` into mc's copy of the registration on
every use, and a waiter's queue ticket carries the same as `session`. The
pid is the coding agent's, found by walking up from the verb
(`MC_SESSION_PID` overrides); a bare verb's is its own. `leased` is a living
holder that used the server within `MC_DEV_HOLDER_STALE_MINUTES` (5).

JSON carries `dev`: `{ running, starting, leased, queued, servers: [{ kind,
holder, holder_alive, holder_gone, name, repo, state, idle_seconds, progress,
port, url, worktree, branch, instance_id, service }], queue: [{ holder, name,
worktree, service, gate, waited_seconds }] }`, read through one function,
`readPool` (`dev-pool.js`), which reads the registry and the queue without
sweeping or rewriting either. The page draws from `dev` and nothing else. The
Docker line's `N leases` are leases on the container runtime (`mc docker
ensure`), not on a dev server, and DEV does not say them.

### MERGES

Two queues, one per repository. The heading names counts, not PR numbers.
A red pause names the merger's actual barrier: deploy, gate round or held
lease; queued work with no live merger says `merger stopped` in red.

Under each repository, one grid row per PR, in order: the landing round
(`GATE`), reds (`RED`), then queued work (`WAIT`), at most six rows before
`… N more`. The name is its branch, the state `gate`, `rebase`, `landing`,
`red`, `queued`, or `stopped` without a merger, and progress is its age.
The PR has its own colour. The tail names a batch member (`with #N`), queue
age, red reason and title, with the title giving way first. An empty queue is
one `IDLE` row named by repository, with its last landing's age and PR.
The first row carries `N merges in 24 h`, counted from landed round records,
not build outcomes.

The exact input is `merges.repos[]`: repo, state, pause, merger_stopped,
landing, landings, waiting, reds, day_count, last, and the idle grid fields.
Each queue item carries kind, name, repo, state, progress and prs. The drawing
uses these repository queues, not the older aggregate fields.

### PULL REQUESTS, DEPLOY, LANGUAGE, CHECKS and MC

PULL REQUESTS draws open PRs not already represented by a goal or the merger.
Ownership comes from `prOwner` (`open-prs.js`): plan session, workarea,
worktree elsewhere or nobody. The heading counts all; nobody's mark is yellow,
as is quiet time past a day. `mc prs` reads all of them grouped by owner.

DEPLOY leads with a running or failed deploy, then the last deployed sha and
age. A mismatch with the helper's `/api/version` reading names both in yellow.
LANGUAGE reads cached language status and run records: unresolved selectors,
grammar waiting, readings at least seven days old, and the last run. CHECKS
shows cached dependency readings and their age. MC shows the installed code,
runner handover and processes still on another commit. The Docker line reads
its state file alone; drawing a page must never start the runtime.

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

## The grid

`page-grid.js` defines `GRID`, `gridColumns` and `gridRow` for SESSIONS, DEV
and MERGES. PROGRAMMES uses the independent phase tree described above.

| column | width ≥ 90 / < 90 | SESSIONS | DEV | MERGES |
|---|---|---|---|---|
| mark + nr | 6 | status circle and lane number | status circle | status circle |
| kind | 8 | `PLAN` `BUILD` `REVIEW` | `MAIN` `SLOT` | `GATE` `WAIT` `RED` `IDLE` |
| name | 28 / 20, floor 10 | programme/goal | holder | branch or repository |
| repo | 12 / 0 | repository | repository | repository |
| state | 9 | running or idle | leased, idle or starting | round phase or queue state |
| progress | 10 | elapsed | time since used | state age |
| PR | 9 | goal's open PRs | port | queue item or last landing |
| tail | remainder | model and check-ins | branch and worktree | reason and title |

The tail gives way first, then the repository below 90 columns, then the
name. The state, progress and PR widths hold. `clipCell` clips with `…`
before an entire numeric token rather than halfway through it. `#14709`
never becomes `#147…`; a PR's `+N` gives way before its number. Width is
clamped between 60 and 160 columns. Under 60 columns the page is not live.

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
| `brief` | cyan |
| `plan` | cyan |
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
terminal's own foreground; there is no dim text or fixed white. Painting
happens after clipping plain text so no escape sequence is cut. Plain and
painted rows occupy the same columns.

## The menu

| answer | action |
|---|---|
| a goal's number | `mc goal show` for that numbered goal, then redraw |
| `a` | toggle future phases, finished work, detail and dormant programmes |
| `b` | open brief |
| `p [<programme>]` | open plan, asking which programme if unnamed |
| `f` | ask GitHub now and redraw |
| `start`, `stop [--force]`, `update [--force]`, `lanes [<n>]` | the runner order, then redraw |
| `q`, empty | quit |
| anything else | explain the unrecognised or retired verb, then redraw |

The reader uses `/dev/tty`, not the stdin the next tool inherits. A number
shows a goal; it starts no coding session. `pageKey` includes every goal's
programme, name, title, phase, stage, status, phase hold, criteria and running mark. If
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
- `src/mc/page-render.js`, `src/mc/page-programmes.js` and `src/mc/page-grid.js`: drawing, widths and palette.
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
