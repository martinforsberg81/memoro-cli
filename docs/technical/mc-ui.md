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

The page has two views of the whole: the overview, which is what `mc` opens on, and
the operations view behind `o`. A programme has a third, its own view (HORIZONS,
below).

**The overview** (`page-overview.js`, `overviewLines`) is as long as the work
(No budget, below). In order: the compact header (up to two rows), MODEL PRIORITY and PROVIDERS, DESK, the warnings, HORIZONS, the programmes
with something under way (each its own frame, in name order), one folded frame for
the others, MAINTENANCE, then one MERGE row per repository with a landing or a queue
and a DEPLOY row while a deploy or its preparation runs. It draws from `data` alone,
which is what `mc --json` prints. A stopped language run inside an open gap
puts its warning above everything else, and the runner's pause and not-running
warnings follow it.

The header always shows MODEL PRIORITY (the preference set by `mc model priority`)
and PROVIDERS (each provider's cached percentage used and plan/API route, including
API-off and stale/read-failed markers). These rows wrap at the terminal width and
remain visible without `a` or `o`. A change to priority or provider status redraws
the live page; displaying them starts no provider request.

**The operations view** (`o`, below) draws FIGURES 24 h, PIPELINE, MERGE & DEPLOY, DEV
and SYSTEM, which the overview no longer carries, each in its own frame and with no
header above them: the header rows are the overview's. MARTIN QUEUE and MAINTENANCE are
not drawn here: DESK and MAINTENANCE are the overview's. Every
section is a frame, here and on every surface (below). SYSTEM is the frame at the
bottom, containing MC, runner diagnostics, Docker when present and BILLING. There
is no separate SESSIONS section.

**One frame.** Every section on every surface — the overview, `a`, `o` and a
programme's view — is drawn in the one frame DESK has: a top rule
`┌─ TITLE  facts ───── key ┐` with the title in bold, the facts after two spaces
(joined with ` · `) and the key that opens the section at the right, then the rows
at indent 4, then the bottom rule `└────┘`. Each programme is its own frame, with
its name as the title and its goal count and priority as the facts. A
frame with nothing beyond its title and facts — MERGE and DEPLOY with no detail, the
folded `<n> programmes with nothing under way`, DEV with none running — is its top
rule alone, with no bottom rule. There are no loose headings, no cyan rules and no
separator before SYSTEM; the page has one style of rule. The rules are orange
(256-colour SGR 38;5;208); red stays for what is broken. The rounded session
frames (`╭╮`) and the pipeline's stage boxes are not sections and stay as they
are. The primitives are `frameTop`, `panelHeading` and `panelEnd`
(`page-operations.js`).

One `a` / `all` toggles all folded content and details across the page;
the next press returns to the normal view. In the overview it draws the programmes
with nothing under way as frames under the others (each with its number, its horizon and
its phase, as the ones under way), then the operations sections below MAINTENANCE,
expanded: FIGURES 24 h and PIPELINE, each Manager's
activity frame with its trigger and pid, then MERGE & DEPLOY, DEV and SYSTEM; in a programme's view it
expands that programme's block. Current sessions, blockers,
malformed goals, open PRs, merge failures and process/resource warnings
remain visible in both modes. There are no repeated table headers.

### The overview

**No budget.** The overview has no row budget and no fold: every section draws every
row it has, at every width the page draws (60–160). The one fold is the frame of
programmes with nothing under way, below.

**The header** is at most two rows with no frame, then one blank row. The first
reads `MC <version> · runner on|off · <n>/<m> lanes · runner ≈$<x> today · deploy
<when>`, with `d  mc martin` at the right edge. FIGURES 24 h and PIPELINE are in the operations view and under `a`,
which have no header of their own. A programme's own view keeps the header and the frame it had.

**The programmes.** Below HORIZONS every programme with something under way is drawn as
`a` has always drawn a programme (a frame with its phases, goals, sessions and pull
requests), in name order, not in the horizons' order. Its heading is its number and name in
the title and, in the top rule, its horizon (`horizon 5`, the number the HORIZONS row gives, or
`no horizon`), then its phase (`phase 2 of 4`, `draft`), its goal count, priority
and done count; `  ·  ` sets the horizon apart from the name and from the phase, and ` · `
joins the rest: `28  inbox-library-chat-repairs  ·  no horizon  ·  phase 1 of 2 · 2 goals`
(`programmeHeading`, `page-horizons.js`); a programme holds no proposals, which wait in the areas. Held, blocked and malformed goals, the sessions at work on a goal (under that
goal) and the programme's plan sessions are drawn in its frame, so nothing is repeated
in a separate attention list. Something under way is a `draft` record, an unfinished goal, a
session, an open pull request or an item needing attention. The programmes with nothing under
way are one frame, `<n> programmes with nothing under way`, in its top rule alone with `a  shows them`;
`a` draws them as frames after the ones under way.

**MAINTENANCE** is the last frame of the overview, headed `MAINTENANCE  <n> sources`. It has one row
per source, in this order: user feedback, proposals, lessons, errors, tests, dependencies, intake,
areas, strays. The sources are a list (`SOURCES`, `page-maintenance.js`) that the frame walks, so a
new source is one more entry and one more row. A row is its label, what waits, and the verb that
handles it at the right; the age of the oldest is in what waits. Each source is read by its own
reader, which `collectPage` wires and `maintenanceSection` calls:

| source | what waits | oldest | verb |
|---|---|---|---|
| User feedback | anonymous `suggest_improvement`: last collection, saved copies and pending receipts; unavailable reads are errors | collection time in the reading | `mc helper --collect` |
| Proposals | the `.md` files directly in each area's `~/mc/areas/<repo>/<area>/proposals/` (every area folder on disk; no archive), counted and aged by area | the file name's date, else its mtime | `mc proposals` |
| Lessons | `mc martin lessons`' own list: open, in a goal, late (older than 14 days) and landed this week | the oldest open or carried lesson | `mc martin` |
| Errors | the helper's newest digest of each repository: new errors, critical and high | when the digest was collected | `mc helper --intake` |
| Tests | the last full test of each repository, from the nightly record | the oldest run | `mc gate` |
| Dependencies | the last audit of each repository: critical and high | the oldest read | `mc deps` |
| Intake | the files directly in `~/mc/intake` that are not an errors digest | the oldest file | `~/mc/intake` |
| Areas | each area page of each repository that declares areas, read at `origin/main`, one page once however many areas name it | the page changed longest ago | — |
| Strays | what belongs to no programme (`maintenanceItems`, below) | — | — |

A source whose read fails is not dropped: its row is red and says `unreadable — <why>`, whatever
the reason (the reader throws, returns nothing, or no reader is wired). A reading that has problems
of its own — a repository whose nightly history cannot be read, an area page git cannot show — is
red too and keeps what could be read. Every row carries `id`, `state` (`ok`, `error` or `none`),
`count`, `oldest_seconds`, `summary`, `tone` and `error`, and the reading's detail (`groups`,
`areas`, `items`) in `mc --json` under `maintenance.sources`.

The strays row is read from the page's own data (`maintenanceItems`, `page-overview.js`), so what
was always drawn outside the programmes is still drawn: each item is a row beneath the Strays row,
in this order:

- a failed merge that no goal's pull request carries (`merge failed — repo#N · <why>`);
  a goal's failed merge is drawn under the goal;
- a main-red repair that waits on Martin, or a main-red record mc cannot read;
- a deploy repair that waits on Martin, or a deploy repair record mc cannot read;
- a failed deploy preparation, and a failed deploy attempt with the step it stopped at
  (a preparation that runs is DEPLOY's row, not maintenance);
- a stray directory, with its checkout and uncommitted count, or a tmux or register
  session of no area mc knows, with how long it has been open and its pid;
- a plan or runner session with no goal of a programme (a runner session's pull
  requests are its child rows, `↳ repo#N`);
- a pull request outside the goals, with whose it is.

A held, blocked, malformed or stopped goal, a finished goal not archived and a goal's
failed merge are its programme's, drawn in its frame, never here. The live page's key
reads each source by its state and count, and each stray item without its age (`fact`), as it
reads a session by its identity: an item growing older does not reprint the page. Without a
collected `maintenance` (a page from a mc that did not have it) and with nothing outside the
programmes the frame is not drawn.

**The maintenance view** (`m` or `manager`, `maintenanceView`, `page-overview.js`) draws the
overview's header rows (`headerRows`), the warnings and the same frame, nothing else (FIGURES 24 h
and PIPELINE are the operations view's), with each source's detail below its row: proposals by area, each with its count and oldest; lessons by state (open and in a goal by name); errors, tests and dependencies by
repository, each with its age; intake by file; areas as a table of name, repository, when its page
last changed on `origin/main` (`today`, `1 day ago`) and its aims (`3 aims`, `1 aim`, `no aim`); the
strays' items. The aims are the top-level bullets under the page's `## Aim`; `No aim stated yet.`
is none. The view draws nothing the sources do not hold and acts on nothing: the verb at the right
of a row is where the source is handled. `h`, a number or a programme's name leaves it; the frame's key
reads `h  home`, and `m` again keeps it open. The operations view draws no MAINTENANCE.

**The desk's sessions** are counted in DESK's title (`<n> desk sessions open`), not
listed: the martin, manager and helper sessions.

**MERGE and DEPLOY** rows are not drawn when both are idle; the detail is in the
operations view and under `a`.

### DESK

What waits for Martin, read and not synced. `readPageDesk` (`page-desk.js`) is
`desk` in `mc --json`; `deskLines` draws the panel from that data alone and
draws none when the data has no `desk`. The heading reads `DESK`, then
`<n> waiting for you` (`Nothing waits for you.` with nothing), with `d  mc martin`
at its right.

The rows are the waiting texts, then the waiting acts, at most 5, then
`+n more — d opens the desk`. A text row starts `text`, then the text it changes
and its goal (`no goal` when it has none); an act row starts `act` and its
reference. Each row then carries the first line of the item's `brief.md` (`#`
marks removed; `brief.md is missing` or `brief.md is empty`), how long it has
waited — minutes under an hour, hours under two days, then days — and
`blocks n` when n is above zero. A row is held to the frame by the page's own
`clip` and `width`: the brief gives way first, then the name. Wide (CJK) and
combining characters are measured as every other row measures them, which is the
recorded residual risk.

Three rows always follow, wrapped rather than clipped: what was decided without
Martin since the last opening (asks settled in the jev ledger and how many went
against the asking session's recommendation, desk items closed for him, ledger
lines that could not be read), what is not ready (in preparation, failed, the
oldest's age, and the runner's stuck items, which are not Martin's and never
among the waiting rows), and what the desk costs today of the ceiling.

An unreadable part says so in red in its own row and the rest still draws: an
invalid `last-open.json` and an unreadable ledger on the decided row, `desk.json`
or `runs.tsv` on the cost row, a failure of the whole read as `desk unreadable —`
with nothing else. The read never throws, so the page always comes. `⚑n`,
and `status Martin` stay as they are; MARTIN QUEUE is no longer drawn (the operations view has none).

`desk` in `--json`: `since`, `last_opened`, `waiting`, `texts` and `acts` (each
`id`, `kind`, `reference`, `sort`, `source_at`, `waited_minutes`, `blocks`,
`brief_line`, and for a text also `text` and `goal`), `decided` (`since`,
`asks`, `against`, `closed_for_you`, `unreadable_lines`, `error`), `not_ready`
(`count`, `oldest_age_hours`, `failed`, `stuck`), `cost` (`day`, `today`,
`ceiling`, `error`) and `error`.

The read writes nothing and takes no lock: the item store, `.store.json`, every
`brief.md` and `last-open.json` are as the last sync left them, whatever the
runner holds. It reads the programmes' goals only when something waits, and
never the changes, the horizons or the archive; with nothing waiting it adds a
few tens of milliseconds at most. Its figures come from the functions the
desk's own opening is built from (`desk-opening.js`, [mc-martin.md](mc-martin.md#opening)),
so the page and the desk agree on what waits, in what order and what was decided.

### HORIZONS

The default page draws HORIZONS below DESK and the warnings (`page-horizons.js`,
`horizonsLines`, from `data.horizons` and `data.programmes` alone). The heading counts
the open horizons, the programmes under way, the goals open and the sessions at work.
One row for every open horizon, in the desk's order (`position`, then set time, then slug):
its number and title, its programmes and their state (`2 programmes · 1 draft`,
`nothing open`, `done`) and its goals: `<n> open`, `<n> landed`, `⊘ <n>` held, `<n> PR` open
pull requests, and `●` while a session works on one of its programmes. A horizon store
that cannot be listed is a red line under the heading, and so is each horizon record that
cannot be read; the page draws no horizon from either. The programmes themselves are
below, in their frames; `programmeHeading` draws each one's number, horizon and phase
(`page-horizons.js`; `horizonWords` gives `horizon <n>`, `no horizon`, or the slug a record
names that is not an open horizon, with its state).

**Numbers.** Goals keep the numbers 1..N. The programmes are N+1..N+M in name
order, in every listed programme including the folded ones, and the number is on
every programme frame's title and on the programme view's heading. Both are `number` in `--json`.

**A programme's view.** Typing a programme's number, or its exact name, at the
prompt opens that programme alone: the top of the page (the header and its
hero frame, the DESK) then the programme's block with its number on the heading, as the overview draws
it (expanded when `a` is on), and nothing below it. `h` or `home` is the
overview again; a programme that is no longer listed is the overview again too.
The view is part of what the page is, so a live frame draws it, not the overview.

**`--json`.** `horizons` is `{ open: [{ slug, title, position, programmes }],
none: [<programme names serving no open horizon>], unreadable: [<directory
names>], error }`, `error` being the reason the store could not be listed, else
null. Each programme in `programmes.programmes` gains `number`, `horizon` (the
slug its valid record names, else null) and `horizon_state` (`open`, `reached`,
`dropped`, `not held` for a slug the store holds no horizon for, or null),
and `record_state` (a valid record's state, otherwise null).
Red in a programme's frame means that someone must act: status `Martin` or `blocked`, a
malformed goal, a refused archive, a failed merge. A goal that gets no session although
nothing is wrong with it is paused, and a pause is grey: in a draft programme, and on a held
goal, an unfinished goal whose status is `ready` reads `status paused`, and its hold is a grey
row `held by <by> since <at> — <reason>`. The programme's heading alone says `draft`; no goal
repeats it. A hold reason already drawn for an earlier goal in the same frame reads `as above`.
`Martin` and `blocked` stay red in a draft programme. All of it is derived at render time from
the group's record state and the goal's hold, without changing the goal-row JSON contract.
A pause does not cancel a running session or stop queued merges.

### PROGRAMMES

A programme's frame is drawn in the overview (under way) and under `a` (all); the rest
of this section is that drawing.

Nonzero programme priorities appear on the programme heading. Type
`priority mc inbox --set 10` at the page prompt to set one or several; zero
resets them. This calls the same verb as `mc programs priority`, then redraws.
The live refresh key also changes when a priority changes in another terminal.
Scheduling first prefers blocked recovery, finish/merge, review, build, then
next-step planning; programme priorities decide within a rank after repository
shares. See [mc-run.md](mc-run.md#the-pick-in-order).

A programme with a record (`PROGRAMME.json`, [mc-plan.md](mc-plan.md#a-programme-with-a-record)) is on the page before it has
a goal; a draft counts as under way, other empty records as having nothing under way. A programme without a record appears as before.

`programmesSection` and `goalsOf` (`page-collect.js`) build programme → phase
→ goal → PR. Each programme is a frame (above) with a bold name. Each phase has its own
bold heading inside it. All unfinished
phases and goals are visible, including a phase that waits, headed `after phase
N` (the phase the programme is in, for a sequential programme) or, in a
programme whose record states its phases, `after phase <m>[, <m>…]` with every
phase it is stated to wait for; an open phase is headed as any other, and a
programme whose record is invalid shows every unfinished goal held and says
`record invalid` on its name. Each phase in `--json` carries `state` and
`after`, a goal's `held` is true when it is unfinished and its phase is not
open, and `current_phase` is the lowest phase with an unfinished goal; the rule
is `phaseStanding` ([mc-goals.md](mc-goals.md#phases)).
Finished goals leave the page: the default view draws no done or dropped goal
except one still at work (running, or owning a live session), which stays in
its phase until the session ends, and `a` draws every finished goal still under
`goals/` in its phase. The runner archives a finished goal at its next pass
([mc-run.md](mc-run.md)), so what remains is usually a goal waiting on a
refusal. A programme heading carries ` · n done` for its finished goals (`n`
is `finished` in `--json`); a phase with nothing drawn is not drawn, and a
programme with nothing to draw is its top rule alone. Under a `NEEDS ATTENTION`
sub-heading in the programme's frame: a malformed goal, without an inferred phase; a finished goal the
runner refused to archive, with the red line `not archived — <why>` (`archive_refused`
on the goal row in `--json`, from the runner's last such log entry after the
entry that set the stage, else null); and a finished goal with an open pull
request, with that pull request as its child row. There is no fold line for finished
goals, and a session on a finished goal is shown under that goal, never as
unassigned activity.

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
borders for build, magenta for review, blue for repair (and for `finish` in
lane files from before, and for the interactive plan session) and yellow for
mend. Long activity wraps
inside the frame within the terminal width. Positive check-in counts appear
at the end of the activity inside the frame, in yellow, and its yellow clock
remains visible without expansion; repository, advisor, pid and zero check-ins
are expanded details. A session
with no matching goal is a MAINTENANCE row, with its PR references as child rows, so
removing SESSIONS cannot hide it. Rendering joins the
existing `runner.sessions` and programme records; their JSON shapes remain.

Foreground plan sessions appear directly below their programme heading,
including programmes that otherwise count as dormant. (Until 2026-11-07 the
runner's programme planning turns appeared there too, with their trigger; the
runner starts none now, and a lane file from then is still drawn as it was.)
A finish or mend session appears under its goal, or as a MAINTENANCE row
when the goal is missing. In a programme's view each open Manager session has its own rounded activity frame
directly below the DESK, with its trigger when recorded, and under `a` the overview
draws the same frame below the hero frame; in the overview it is counted in DESK's title. The hero offers no
manager entry point, since the manager runs headless (mc-manager.md). Programmes with
nothing under way fold into one frame with a count; `a` shows every programme. The collector's
active/dormant classification and full JSON listing remain unchanged.

Every open PR remains a child of its goal, or in PRs without a goal under its
programme. Explicit plan branches retain ownership even in scratch worktrees.
Attached PRs carry `programme` in JSON and are excluded from the loose PR list.
Goals handed to the merger retain `stage merge`, without a session frame.
Their PR children say `in queue` or `merging`, including PRs whose queue
records arrived before the GitHub cache refreshed.
Unowned sessions and directories remain visible as strays.

### MAINTENANCE

Three bold orange subheadings summarize maintenance without listing programmes,
proposals or individual errors. Proposals counts the direct `.md` files in every
area's `~/mc/areas/<repo>/<area>/proposals/` (`intake.proposals`, with
`by_system` and the newest names), archives excluded. Other intake counts direct inbox files other than collector
digests; directories and archived files do not count.

Errors has New, Critical and High columns per repository, with each digest's age.
New is the existing digest delta; an absent baseline remains unknown. Critical
and High count items in the digest's recorded Analysis items table. These are
analysis priorities, not dependency vulnerabilities or the hit threshold used by
`!`. Missing or failed analysis remains `?`; a successful empty analysis is zero.
The local memoro-cli digest currently has no priority analysis and stays unknown.
A failed latest collection remains red. Expanded view retains aggregate full-test
and dependency readings; individual error details remain available in JSON.

Each live helper uses the shared rounded session activity component, including
automated intake turns registered for the duration of their model session. The
activity dot is green, kind/frame uses the shared palette, and time/tool/model/pid
follow the same formatting as programme sessions. Cleanup runs on success and
exceptions; dead process records are filtered by the existing reader.

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
Repository headings use the phase indentation and orange text, such as
`memoro-cli · 1 in queue`. A separate `Queue: #1 #2` row shows every waiting
reference in landing order, wrapping within the available width. Active merges
are excluded from the queue. Expanded details add branches, queue ages and
24-hour history.

Each active merge has a green rounded session frame with PR, phase bar,
elapsed time, phase message and PID. Failed merges have red frames beneath
active work and remain until their PR is handled or queued again. Recovery
status and concise failure reasons remain visible. The phase bar marks prepare
`[●··]`, gate `[━●·]` or land `[━━●]`, with `[···]` for missing evidence.
Pauses, stopped mergers and batch membership retain their own rows. Direct
goal merges use the live merger's queue record; dead owners remain waiting.

A queued entry with a valid future `not_before` is a scheduled retry, not a
ready job or evidence that the merger is stopped. The normal panel names its
PR, recorded retry category and explanation, local eligibility time with
timezone, remaining delay, retry counts, automatic next step and `mc merge
<repo> <pr>` retry-now command. Eligibility is not a guaranteed start time.
Only a future valid deadline activates this display; at or after the deadline,
or for a malformed/absent deadline, the job is due and no timed pause is shown.
Legacy entries with a future deadline remain visibly delayed, with the cause
honestly labelled unknown when no diagnostic was persisted. An all-deferred
queue does not imply a stopped merger merely because no process is alive; due
unowned work still does. Mixed queues attribute each delay to its own PR and
repository. Current deploy, gate and lease pauses remain visible alongside
retry details. A completed failed deploy is historical evidence, not a current
merge blocker.

DEPLOY uses an orange subsection heading, LIVE and RECORDED version evidence,
and a rounded attempt frame: green while running, red after failure, yellow
for a refusal or missing end record. Expanded details include builds and
timestamps. The RECORDED line ends with the verdict of the check after the deploy —
`checked green`, `check red: <why>` (red), `check could not run: <why>` (yellow),
`checking` or `not checked` (`mc-deploy.md` § *The check after a deploy*); a red is
that line's colour and nothing else on the page. Language readings and last runs
are omitted from this panel.
DEV follows as a separate panel.

### Related work and system details

MERGE & DEPLOY includes a conditional **PRs outside goals** group for open PRs not
represented by a programme, running session or merger. Its counts describe
that group only; `mc prs` still lists every PR. Empty groups disappear.
The stopped-language-gap warning remains above the work.

The SYSTEM frame places installed-code/update/draining information,
runner liveness and occupied/configured lanes, resource holds, Docker,
provider usage and daily statistics below the work. STOP, stale records,
GitHub failures and quota warnings remain visible; reasons and billing wrap.
Disk and memory values still come from the runner's hold records, not a new
resource sampler. A dead runner's old resource holds do not describe now.
While a live runner stops new sessions for disk, memory or STOP, a short
consequence also appears in the warnings above HORIZONS; full readings remain in SYSTEM.
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
| DESK: waiting texts, acts, not ready and stuck | the desk item store (`martin/items`, `.store.json`) and each item's `brief.md` | the desk's sync, under the runner lock; the page only reads |
| DESK: cost today and ceiling | the desk's rows in `runner/log/runs.tsv`, `runner/desk.json` | runner and desk; `mc martin ceiling` |
| DESK: since | `~/mc/martin/last-open.json` | `mc martin`, after a launch |
| DESK: asks decided without Martin | the jev ledger, `decisions.jsonl` in mc home | jev |
| HORIZONS: the open horizons and their order | `martin/horizons/<slug>/horizon.json` (`readHorizons`) | `mc martin horizon`; the page only reads |
| HORIZONS: the horizon a programme serves | `horizon` in the programme's `PROGRAMME.json` | `mc plan`, the manager |

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

Widths stay clamped to 60–160 columns. The page reserves two columns at the
right edge to match its two-column left inset. Programme titles use their own line, with stage, status and criteria directly below; repository metadata is in expansion. Whole PR
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
| `repair` | blue |
| `triage` | blue |
| `manager` | cyan |
| `brief` | cyan |
| `plan` | blue |
| `finish` | blue |
| `mend` | yellow |
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
Every frame's rules use orange (256-colour SGR 38;5;208). Other colours still
depend on the terminal palette; NO_COLOR and non-TTY output carry no escapes. Painting
happens after clipping plain text so no escape sequence is cut. Plain and
painted rows occupy the same columns.

## The menu

| answer | action |
|---|---|
| a goal's number | `mc goal show` for that numbered goal, then redraw; from the overview and from a programme's view alike |
| a programme's number | open that programme alone (its view), then redraw |
| a programme's exact name | the same; looked up last, so no programme name takes a word of this table, and a number is a goal's before it is a programme's |
| `o` / `operations` | the operations view: FIGURES 24 h, PIPELINE, MERGE & DEPLOY, DEV and SYSTEM, without the header rows; no programme takes `o` or `operations` as a name; the key line reads `o  operations` |
| `h` / `home` | the overview again, from the operations view and from a programme's view; the key line reads `h  home` |
| `a` / `all` | toggle all folded rows and details across every surface; in the overview, the programmes with nothing under way as frames, then the operations sections expanded: FIGURES 24 h and PIPELINE, each Manager's frame, then the panels |
| `d` / `desk` | open the desk (`mc martin`), through the injected `deskOrder`, and return its exit code; the key line reads `d  desk` |
| `m` / `manager` | the maintenance view; the key line reads `m  maintenance`; no programme takes `m` or `manager` as a name. `b` / `brief` print the refusal: the interactive manager is gone |
| `p [<programme>]` | open plan, asking which programme if unnamed |
| `f` | ask GitHub now and redraw |
| `r` / `refresh` | collect the current page and redraw immediately |
| `c` / `clear` | archive every safe finished goal (`mc goal archive --all`), print its lines, then redraw; the key line reads `c  clear finished goals` |
| `deploy [<args>]` / `mc deploy [<args>]` | run the deploy preflight and start the deploy, with no confirmation, then return to the live page as soon as the deploy starts; explicit `--follow` watches the log |
| `start`, `stop [--force]`, `update [--force]`, `lanes [<n>]` | the runner order, then redraw |
| `q`, empty | quit |
| anything else | explain the unrecognised or retired verb, then redraw |

Merge and deploy frames put identity, status and pid on the first row. Progress
starts on the second row and wraps across the frame's full width. Deploy age
gives way on a narrow terminal so pid and status stay together. Deployment stays
visible in MERGE & DEPLOY while the page continues to accept commands.

A successful deploy removes its attempt frame. Failed attempts remain red with
their stop reason; only a running attempt whose process is alive shows a pid.
Completed pids remain in the diagnostic record, not as active page state.
LIVE uses a deploy's recorded live verification when the cached version read
predates that deploy's start, labelled `verified by deploy`. Cache readings
during or after the deploy remain independent evidence: end time cannot prove
which verification came later, so a differing version still warns. A deployment
with no recorded live verification cannot replace the cached reading.

Deploy progress comes from the script's actual `▸ <step>` output, published by
the deployer in `runner/log/deploy-progress.json`, matched to the attempt's
start time and pid. Its bar marks preparation `[●···]`, building `[━●··]`,
publishing `[━━●·]`, and verification `[━━━●]`. Success removes the frame.
Waiting, unknown steps and missing/old snapshots have an
empty bar. This shows phases, not elapsed-time percentages. Noise and retries
retain the last observed step; an unfamiliar step is shown without guessing
its phase. Like the rest of the page, progress refreshes every 30 seconds or
immediately with `r`.

The first key line reads `<n>  show a goal or open a programme   ·   a  all / collapse   ·   o  operations   ·   h  home   ·   d  desk`; `m  maintenance` is on the line of `r  refresh`.

The operations view is held by `run()` in its own value, next to the programme's
view, and not in `page-live.js`: a live frame draws it, as it draws a programme's
view, so it survives every refresh until `h`, a goal's number or a programme's
number or name leaves it. `o` from a programme's view opens it.

The prompt answers against the page on the screen: `run()` numbers each draw as it starts, keeps its data for the menu only if no later-started draw was kept, and the menu reads it through `current`, so a slow older collect never puts older numbers under a newer page, and a number typed after a frame that added a goal means the number that frame drew.

The reader uses `/dev/tty`, not the stdin the next tool inherits. A number
shows a goal or opens a programme; it starts no coding session. `pageKey` includes every goal's
programme, name, title, phase, stage, status, phase hold, criteria and running mark, plus session identity and check-ins and the desk's identity (the ids waiting, the not-ready, failed and stuck counts and the decided figures; not an age and not the cost) and the overview's: each programme's number, name, horizon and reference state, its explicit holds and PR counts, and the horizon section including labels, membership and read warnings. It also includes the overview's rows: which sessions are in flight (not their ages), each MAINTENANCE item and its text without its age (a session item by its identity alone), and each MERGE and DEPLOY row's fact. A change in any of them is a new page, so it is printed whole like any other. If
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
above the page still there and still once, a programme's frame on the screen once
rather than printed again under itself, a `1` typed before the first refresh
still at the prompt with the cursor after it, backspace taking it back, `q`
leaving with exit 0, no alternate screen buffer (`\x1b[?1049` never written),
and `stty -g` identical before and after. What it does not do is press return
on that `1`, because that exercised the interactive menu rather than the refresh loop.
Today a number shows the goal it numbers, or opens the programme; `front-door.test.js`
checks that routing without opening a coding tool.

## The modules and tests

- `src/mc/commands/home.js`: page, arguments, menu, freshness and restart on new code.
- `src/mc/page-collect.js`: pure section builders plus the machine-facing collector.
- `src/mc/page-desk.js`: the DESK section — `readPageDesk`, `deskLines` and `deskKey`.
- `src/mc/desk-opening.js`: the desk opening's read-only figures (texts, acts, stuck, not ready, decided, cost and `last-open.json`), shared by `mc martin` and the page, and the page's own reader of the ask ledger (`ledgerAsks`), which the opening does not use; it has no sync, lock or writer.
- `src/mc/page-horizons.js`: the HORIZONS section and the programme headings — `horizonsLines`, `horizonFigures`, `programmeHeading`, `horizonWords`, `programmeFacts`.
- `src/mc/page-overview.js`: the overview — `headerRows`, `flightRows` (the sessions DESK counts and MAINTENANCE draws), `maintenanceItems`, `maintenanceRows`, `maintenanceLines` and `maintenanceView` (MAINTENANCE and its view), `mergeDeployRows` and `overviewLines`, which draws the sections in order.
- `src/mc/page-maintenance.js`: MAINTENANCE's sources — `SOURCES`, `maintenanceSection` (one row per source, a failed read red) and each source's reading and machine read.
- `src/mc/page-render.js`, `page-programmes.js`, `page-activity.js`, `page-operations.js` and `page-grid.js`: page composition, work tree, activity, operations, widths and palette.
- `src/mc/page-cache.js`: the PR cache.
- `src/mc/dev-pool.js`: DEV's data — `readPool`, the one reader of the dev-server pool, and `devSection`.
- `src/mc/dev-holder.js`: who holds a dev server — `leaseHolder`, written when a verb takes one, and `holderLabel`.
- `src/mc/merges-collect.js`: running rounds joined to repositories and holders.
- `src/mc/page-frame.js` and `src/mc/page-live.js`: frame differences and live reader.
- `src/mc/status-collect.js`, `status-render.js`, `foreground.js`: shared readers,
  primitives and foreground records.

`tests/mc/landed.test.js` pins the 24-hour outcome and which sessions each
stage frame counts; `tests/mc/desk-cost.test.js` pins which transcripts are
interactive, the incremental reading and the partial first reading. `tests/mc/page.test.js` builds sections from fixtures, compares the palette
tables and checks painted/plain widths. `tests/mc/front-door.test.js` pins
menu routing, including `d` and `desk`, the programme's number and name, `h` and `home`, and piped output. The horizons collector cases (on a temporary home), the HORIZONS and programme-view renders at 160 and 80 columns, and `run()`'s view and numbers across live frames are in `tests/mc/page.test.js`. The DESK section's fixture, its agreement with the opening, its held-lock and error cases and its render are in `tests/mc/page.test.js`. `tests/mc/page.test.js` also holds the overview's order and its absence of a budget, drawn from a normal-day and a heavy-day fixture (every row accounted for by identity, at 60 to 160 columns), the operations view, and `a` drawing the folded programmes' frames, the hero frame and each Manager's frame. `tests/mc/page-live.test.js` and
`tests/mc/page-frame.test.js` cover refresh arithmetic without launching a tool.

## The header and the operations view's hero frame

The overview's header is two rows (above). FIGURES 24 h below, the hero frame, is the
top of the operations view and, under the header rows, of a programme's view. It says what mc is and what
came out of it; the pipeline under it says where work stands now. The overview
carries neither.

**Hero frame** (FIGURES 24 h). Active and dormant programmes, the runner's list-price cost
today (`runner ≈$…`, its own sessions only), busy lanes of the lanes set, and
the latest successful deploy in UTC (or `none recorded`). Then the last 24
hours' outcome, from runs.tsv alone (`landed.js`, `data.landed`):

- **Landed:** distinct goals merged (merge rows named `goal:…` whose note says
  `merged`), distinct pull requests merged without a goal (merge rows named
  after a repository), pull requests landed of all merge attempts, and first
  pass — the share of landed goals that never needed a finish or mend session.
- **Per goal:** the goal's own work only — its build, review, finish and mend
  sessions over its whole life, not only the day. Its planning is not the
  goal's (Martin, 2026-11-09): headless plan rows are left out here and
  counted on the planning line. Mean sessions, and the median and total
  list-price cost (`rowCost`, [mc-status.md](mc-status.md#the-cost-estimate)).
  A session whose model has no list price is named beside the cost.
- **Session time per goal:** the same sessions' time, as a histogram over
  `<15, <30, <60, <120, <240, ≥240` minutes, then median, p25–p75, p90 and max.
- **Planning & desks 24 h:** the list cost of every interactive session in the
  last 24 hours — plan, manager, Martin's desk, and the sessions of the helper desk that is gone, on claude,
  codex or agy — and how many, then the headless plan sessions' cost from runs.tsv.
  Historical `plan-*` rows retain their planning classification: their cost
  stays on this line, not in goal effort, and they do not increase the count
  of headless `plan` sessions.
  runs.tsv holds no interactive session, so these are read from the tools' own
  transcripts (`desk-cost.js`, `data.desk_cost`): a claude transcript whose
  `entrypoint` is `cli` (the runner's are `sdk-cli`), each message priced once
  at its last reading as one request; a codex session whose `originator` is
  `codex-tui`, its running total less its last reading before the window; an
  agy conversation (`agy-steps`) whose opening message leads with mc's launch
  marker, its steps in the window priced at the model of each
  (`agy` writes no entrypoint, so a conversation without the marker cannot be
  told from one the runner made, and is left out: the line says how many it left
  out, and a tool whose cost source mc has no reader for is named as failed, not
  read as zero). A
  cache (`~/mc/runner/desk-cost.json`) keeps each file's read offset, so a
  collect reads only appended bytes, at most once a minute. The first reading
  of a day (some 300 MB) is spread over collects at 24 MB each, and the line
  says `so far` until it is complete.

runs.tsv keeps the header it was created with; a shorter header that is a
prefix of `RUNS_HEADER` is read with `RUNS_HEADER`, so the appended columns
(`model` and the rest) are not lost.

**Pipeline.** One small box per stage — proposals, draft, build, review, finish,
merge — under the hero frame at its indent. Each box is four rows: the stage
name set into the top border (`┌─ build ──┐`), the count with its flags, the
marks, and the bottom border. A box is as wide as its widest content — the name
with its `─ ` and ` ─`, the count, the marks — plus one space each side, and
never wider; the count and the marks are centred in it. Boxes are joined by
` ──▶ ` on the count row, with spaces on the other rows. All six sit on one row
when that fits the hero frame's width less its indent; otherwise they are joined
by ` ▶ `; otherwise three and three on two rows, each keeping its arrows with
` ──▶ ` when both rows fit and ` ▶ ` when not.
The count is the proposals waiting in the areas for proposals, and
the goals in the stage otherwise, followed by `⚑n` for goals waiting on Martin
and `⊘n` for blocked goals there. The marks are one per session working in the
stage, in the stage's colour: build and repair sessions on build (a repair in its own
blue, `KIND_TONE`'s `repair`), review sessions on review, and finish sessions on finish
(none is started now; the box stays for goals from before); on draft,
every plan session, interactive (`data.sessions.planning_sessions`) and headless
(runner `plan` sessions); proposals carries none; on merge `◎` per gate round in
flight and `↺` per mend session, in mend's yellow. A box shows at most eight
marks of one kind; more are drawn `●×n`. A box's border is its stage's colour,
from `STAGE_TONE` (`page-grid.js`): proposals yellow, draft blue, build green,
review magenta, finish blue, merge orange. A box with no count and no session
has a grey border, the terminal's real grey (`ESC[90m`), which the grey-to-white
mapping above does not touch, so empty boxes recede. A mend (`↺`) is yellow.
The name is bold in the terminal's own foreground; a count is bold above zero
and grey at zero; the arrows are grey; `⚑` keeps its yellow and `⊘` its red, and
a blocked goal changes nothing else. `done` and
`dropped` have no box; what landed is in the hero frame. Complete header fields
wrap within the hero frame on narrow terminals. The header's action reads `d  mc martin`: `mc martin` (or `d`
at the page prompt) opens the desk. The interactive manager is gone: `m`, `manager`, `b` or `brief` at the page
prompt prints the refusal `mc manager` gives, naming `mc martin` and `mc manager --headless --prompt`, and draws the
page again. Manager's open state is shown below the pipeline, including
foreground records from before the rename.

Maintenance groups repository measurements beneath their names. Below its
title it carries the eye's open state and last collection from
runs.tsv, including a failed run or an explicit absence of a record.
