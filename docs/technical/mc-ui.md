# mc — the page

`mc`, typed alone, is the page. It is the only thing in mc that lists
programmes, projects, sessions or queue entries, and there is exactly one
only surface. Left open at a terminal it stays true: every 30 seconds the
rows that changed are rewritten where they stand, and nothing else on the
screen moves — see [*The live page*](#the-live-page). `mc --watch` existed
for a few hours on 2026-08-29 and was removed the same day (Martin: *a page
redrawn on a timer is not a live page; the real one comes later*). That
section is the later.

That is a deliberate limit (decision `mc-3`, 2026-08-29). Before it, five
verbs each printed a list of their own — bare `mc` printed the V1 sessions
table, `mc status` printed a board, `mc list` printed workareas, the bare
workarea verb printed a menu with its own numbering, and `mc status --sessions`
printed a second board over 1 417 transcripts. A person had to know which
one answered their question. **A new verb that prints a list of areas,
sessions or projects is a regression**, not a feature.

## The surfaces

| | what it does |
|---|---|
| `mc` | prints the page; at a terminal, then the menu, and the page refreshes in place under it every 30 s |
| `mc --json [--fresh\|--offline]` | the same object the renderer takes, one key per section, exit 0 |
| `mc --fresh` | fetch and ask GitHub first, then print |
| `mc --offline` | skip the fetch and read the plans as they were last fetched |
| `mc status <name>` | one project — still its own verb |

There is no workarea verb: it and `mc worker` were retired on 2026-11-03 and
exit 2 with where each kind of session starts ([`mc-work.md`](mc-work.md)).
Every session belongs to a programme or a desk.

Without a TTY — a pipe, a subprocess, a session reading it — the page
prints once and exits 0. Nothing ever prompts where nobody can answer,
nothing loops, and no escape byte is written at all: not colour, not a
cursor move, not an erase. `tests/mc/front-door.test.js` asserts it as
bytes, for `mc` and `mc --json` both, because a live surface leaking into a
script is the one regression nobody would notice by looking.

`mc list`, `mc sessions list`, bare `mc status` and `mc status
--sessions|--watch|--wait` exit 2 and say where they went. **Ruling 20**
(2026-09-12): every print of the page fetches `origin/main` for each repository
first — the same fetch `mc status <name>` already took — and `--offline` is
what skips it. The fetch is for what the page reads from the repositories; the
plans themselves are read from `~/mc/programs/` (**ruling 48**) on every print,
fetched or not.

## The sections

In this order (Martin, 2026-09-19; WORK went on 2026-11-03): PROGRAMMES, HELPER, BRIEF,
SESSIONS, MERGES, DEPLOY, LANGUAGE (2026-10-10), and one line for mc itself. It
still keeps the rule the page had — **what does not move above what does**.
PROGRAMMES is the page as a listing; the two desks change when
somebody sits down; SESSIONS changes with every pick and every frame;
MERGES, DEPLOY, LANGUAGE and the MC line are the short end of the page, a few
rows that are always within reach of the prompt. One line can come above all
of them: while a language run has stopped inside an `opens_gap` window it
reads, in red, `language: <manifest> stopped after <act> — <says> · mc language
resume`. It goes there because while it shows, production is missing data. One more line sits directly above the MC line, `docker · …`, drawn only while `~/.memoro/mc/docker/state.json` exists and from that file alone (`dockerLine`, page-render.js).
The live loop rewrites rows where they stand (`page-frame.js`), and a row that
has scrolled off the top cannot be written to — which is what
[*a status that changed out of reach*](#a-status-that-changed-out-of-reach)
below is about.

- **PROGRAMMES** — one heading per programme with its own `x ready · y waiting · z blocked`
  and its open planning-session counts per provider (`plan claude 1 · codex 2`),
  or `no plan session`; then one numbered row
  per project under it, then one per goal, both in [the grid](#the-grid):
  `project` or `goal` in the kind column, the name, the repository, the state
  (one word, one colour — see *The palette*), the progress (`3/7` of a
  project's steps; `5 sess`, a goal's sessions), the open PR, and in the grey
  tail what is next or what it waits on. A goal has the same columns with the
  same kind of content as a project; the difference is the kind column, not a
  `g ·` before its name (goal `mc/page-columns`, 2026-11-03). The last run
  stays in JSON, not on the row. A waiting project keeps its row; a blocked one collapses under
  its heading unless it has an open pull request. A project's `●` means the runner has a
  step in flight on it, and nothing else. A programme is drawn
  whether or not any of its projects have a plan the runner can read; one that
  exists only as an open planning session is drawn too, and says `no project
  yet` where the counts would be.
  **A programme's blocked projects are a count on its heading, and no row.**
  Thirty-three of forty-four projects were `blocked` on 2026-09-06, and the
  page said so thirty-three times. So a project that is `ready`, `done` or in
  flight keeps its full row, and the stopped ones are the `N blocked` on the
  programme's own heading. They were one collapsed row under it as well — how
  many, their numbers, their blockers — which said the count twice (Martin,
  2026-09-19); what holds them is BRIEF's rollup. Nothing leaves the page: the
  numbering runs through every project of every programme whether or not a row
  is drawn for it, a number opens a project either way, and `a` at the menu
  draws them all again. The blocker is `blocked_by: { kind, name }` on the step
  the status is about — the first that is not done, the only one the runner
  considers — read off the plan and never parsed back out of the `next`
  sentence.
- **Strays**, at the foot of PROGRAMMES under *not an area mc knows* —
  what no kind explains, one line each: a directory under `~/mc` that is no
  area (`listStrays`), with whether it holds a checkout and how much is
  uncommitted there; a register entry no verb explains (a `mc plan` from
  before programmes, a retired verb's); and a tmux session `mc-<name>` mc did
  not start for anyone, with how long it has been open. Nothing removes one.
  There is no WORK section (goal `mc/no-work`, 2026-11-03): every session
  has an `owner` in `mc --json` — `{ kind: 'programme', name }` for a lane,
  a planning session and a project opened from the page, `{ kind: 'desk',
  name }` for the brief and the helper — and is drawn where it belongs: a
  lane under SESSIONS, a programme's own on its heading (`plan claude 1`,
  `1 open`), a desk on its row.
- **HELPER** — the desk, drawn open or not, and under it **what is in the
  intake it works from**: one row per repository that has a digest
  (`~/mc/intake/errors-<repo>-<date>.md`) — how many errors are new, how many
  of them loud, how old the reading is, and the loudest `!` message in what is
  left of the row. This was INTAKE, a section of its own with up to four `!`
  lines under each digest, and the tallest thing on the page that nobody acts
  on from the page: the helper is who reads a digest. A count of loud errors
  is a number somebody has to go and look up, so the one message stays; the
  rest, with their fingerprints, are in the digest and in `mc --json`
  (`intake.repos[].loud_lines`). Below 24 columns of room the message is not
  drawn at all. One row each rather than the newer of the two, which hid
  memoro-cli's — the digest about this machine.
- **BRIEF** — the desk, and **what is waiting for it**: the proposals nobody
  has queued or dropped — how many, split by the system in each filename
  (`mc 23 · memoro 81 · untagged 2`, with `untagged` drawn yellow), how far back
  the pile reaches, the newest three by name (what follows the date in
  `<date>-<system>-<slug>.md`; no file is opened for it) —
  then the two lines that were under NEXT and are questions for a person.
  **How many projects are blocked**, how many of them wait on a decision and
  how many on another project, and the blockers holding the most: `33 blocked
  · 18 on a decision, 15 on a project · held most by plan-review 12,
  home-on-msr 7` — PROGRAMMES' own rollup, the names giving way to the width
  before the fact does. And, in yellow when it is there at all, **blocker
  finished** — a step that is `blocked` on a project that is not among the
  plans under `~/mc/programs/`, which is a plan waiting for nothing
  (`stale-blockers.js`). Only a `project` blocker; a `decision` waits on
  Martin and there is no artefact to read it against. It reports and nothing
  more — flipping the step back to `ready` is a plan edit somebody makes.
- **Queue data** — NEXT is not drawn. `mc --json` still carries `data.next`,
  including the runner's order, lane picks, skip reasons and stale blockers.
  `nextFor` and `assembleQueue` are unchanged; SESSIONS carries counts instead.
- **SESSIONS** — the headless sessions `mc run` is running. The runner runs
  three kinds (Martin, 2026-11-02): `plan`, `build` — of a project's step
  (variant `project`) or of a goal (variant `goal`) — and `review`. The
  section was STEPS while every session was a project's step; a goal's build
  and a review are not steps, and RUNNER names the machine rather than what
  it holds, which `mc run` on the right of the heading already does. The
  heading carries the answer: **`n of N lanes`** — sessions running out of
  the total `mc run lanes` sets, bold green while not zero, `not running` in
  bold yellow when there is no process — and how many projects are queued.
  Under it **one row per lane**, in [the grid](#the-grid), its number the
  lane's. An idle lane is its number and `idle`. A lane with a session in it
  is read for what is running, in that order: the **kind** — `PLAN`,
  `BUILD`, `REVIEW`, in the kind's colour — then what it works on (a goal
  `mc/<goal>`; a project and which step of its plan, `docx-editor 4/6`, read
  off the plan because a lane file does not carry it), the repository,
  `running`, the clock as its progress (yellow past a check-in; nothing on a
  lane row is bold), and the open pull request of the project or of the
  goal's branch in the PR column, `#1251+2` when there are more. The grey
  tail is the model, `credits` when the session runs on the API credit, the
  advisor when it has one, and the check-ins. The model was a column of its
  own; it is bookkeeping, and the state column says the same kind of thing in
  every section. A build's variant is in what it works on, so it costs no
  cell; it is `variant` in `mc --json`, beside `kind` and `goal`. The
  sessions fill from the top, oldest first, so a row moves only when one
  above it ends. The tool, the number of turns and the pid are not on the
  row: the model names the tool, nothing mc writes while a session runs
  carries the turns, and every lane file carries the runner's own pid. A
  runner that is not running has no lanes and one line that says so. Then a
  pending `~/mc/runner/STOP`, the lane files whose process is gone, one
  yellow line per repository the round cannot ask GitHub about — `GitHub
  unreachable for memoro since 08:20Z (keychain locked) — run: security
  unlock-keychain`, or `(gh token invalid) — run: gh auth login -h
  github.com`, or the error itself when neither diagnosis holds — read from
  `~/mc/runner/github.json` and gone once the round has asked again and been
  answered (`runner.github` in `mc --json`; the backoff is in
  [mc-run.md](mc-run.md)), and one line of the day behind it, **per kind**:
  `24 h · build 53 (40 built, 8 queued, 2 blocked) · review 15 (15 queued) ·
  other 114 · ≈$846 list (opus, 2026-06)`. An outcome is where the session
  left its work, read off the runs.tsv note (`outcomeOf`): `merged`,
  `queued`, `built`, `open`, `red` (back from the merger), `blocked`,
  `failed`, `timed out`. `plan` is drawn once there has been one; an outcome
  with no sessions is not drawn; `red`, `blocked` and `failed` are red and
  `timed out` yellow. `other` is what the runner logged that is not one of its session
  kinds — merge rounds, the helper's turns, and mend rows from before 2026-11-02. The list-price cost gives
  way first on a narrow terminal, its basis and then itself. `mc --json`
  carries `runner.sessions` (one per lane file: `kind`, `variant`, `goal`,
  `name` — `mc/<goal>` for a goal's session, as its goal row is named —
  `step`, `steps`, `repo`, `state`, `progress`, `prs`, `model`, the clock),
  `runner.lanes` (each with its `state` and its `session`) and `runner.day.by_kind` (`plan`, `build`, `review`,
  each `sessions` and its outcomes, and `other`); the page draws from these
  and nothing else.
- **MERGES** — two queues, one per repository. The heading gives each queue's
  short counts (`memoro 2 waiting · memoro-cli idle`); PR numbers belong on
  the rows, in landing order. A red `paused deploy`, `paused gate round` or
  `paused lease held` belongs on that repository's heading, never on a row of
  its own. These are the merger's actual pre-round barriers: `runningDeploy`
  (memoro only), `runningRound` in the repository's gate lane, and `readLease`
  with `held && !orphaned`. A landing's own lock and lease are not pauses.
  Queued work without a running merger says `merger stopped` in red instead
  of appearing idle.
  Under the heading, **one row per pull request** in a repository's queue,
  in [the grid](#the-grid): the round landing (`GATE`), the reds a session is
  fixing (`FIX`), the reds (`RED`), then what waits (`WAIT`), in landing
  order — at most six per repository, then `… N more`. The name is the
  project or the branch, the state is the phase in words (`gate`, `rebase`,
  `landing`), `fixing`, `red`, `queued` — `waiting` when it `awaits
  <project> step <n>`, `stopped` when there is no merger — the progress is
  how long it has been in that state, and the PR is in the PR column, green
  while the merger has it and red when it came back red. The grey tail is
  why: `awaits <project> step <n>`, `after #N`, `with #N` for a batch member,
  `queued 10 min` for a round, the red's reason or the fixing session's last
  sentence, and the title, which gives way first. Fixing still means a live
  runner lane holds the red's project and step; its last sentence is read
  from the last 64 KiB of `<session.log>.jsonl` with `claudeTail` or
  `codexTail`. No transcript means the red's reason instead. An empty queue is
  **one row of its own**, `IDLE`, named by its repository — the repo column is
  not drawn under 90 columns, and the row has to say whose queue it is — with
  how long ago it last landed and that pull request in grey. The first row of
  each repository ends on `N merges in 24 h`, green when nonzero. This counts
  landed PRs in `gate-rounds.jsonl`, including manual and batch merges, not
  runner step outcomes. The record's start plus duration supplies the landing
  time. `mc --json` carries the drawing's exact input as `merges.repos[]`:
  `repo`, `state`, `pause`, `merger_stopped`, `landing`, `landings`,
  `waiting`, `reds`, `fixing`, `day_count`, `last`, and the idle row's
  `kind`, `name`, `progress` and `prs`; every item of `landings`, `waiting`,
  `reds` and `fixing` carries `kind`, `name`, `repo`, `state`, `progress` and
  `prs`. The older aggregate fields remain for status and PR ownership
  readers; MERGES draws only `repos[]`.
- **PULL REQUESTS** — every open pull request, and whose it is (`prsSection`,
  `page-collect.js`; the rule is `prOwner`, `project-prs.js`): a project's, by
  the branch rule; a plan session's, checked out under `~/mc/programs/<programme>/`
  or called `plan/…`; a workarea's; one checked out somewhere else; or
  nobody's. The heading counts them all — `8 open · 4 on a step · 1 plan ·
  1 nobody's` — and the rows are only the ones no other row draws: a
  project's pull request is a column of its own on the project's row in
  PROGRAMMES, after the steps — `#N`, or `#N+1` for more than one; one row per
  project (Martin, 2026-10-09), and a blocked project holding one is never
  collapsed — and the merger's are in MERGES. A running SESSIONS lane carries its
  project's or its goal's `#N` after the clock. The one nobody holds has the waiting `◆` in yellow;
  any pull request quiet for a day turns its `quiet …` yellow. The open pull
  requests come from `prs.json`, which every runner round now refills for the
  repositories it asked (`mergePrs`, `page-cache.js`) as well as `--fresh`.
  `mc prs` draws all of them grouped by owner, and asks GitHub first
  (`--offline` reads the cache).
- **DEPLOY** — what is in production, on the section's own heading, and
  **what is wrong with it comes first**: a deploy that failed, with the step
  it stopped at, or one running now; then the sha from the last `deployed` row
  of `~/mc/runner/log/deploys.tsv`, and last the bookkeeping — how long ago,
  which build — which is what a narrow terminal drops. It was a line under
  the runner's day. The holder is not on the line at all: on 2026-09-06 a failed
  deploy's own `Deploy source preflight` was clipped off the end while `by
  martin@laptop` sat in the middle of it. When the `/api/version` the helper
  last cached names another commit than the last deploy, the line leads with
  both readings in yellow — that is a deploy made outside the record, or one
  that did not take, and only a person can say which. The two are compared
  **on the shorter of them**: `deploys.tsv` records the whole 40-character sha
  and `/api/version` answers seven. Where neither source knows anything the
  heading says `nothing deployed yet`.
- **LANGUAGE** — what `mc language` left behind, read from its files only:
  the cached `status-<lang>.json` readings and the run records under
  `~/mc/runner/log/language/` ([`mc-language.md`](mc-language.md)).
  - **The heading:** the last run — its manifest, its outcome (green
    running, yellow stopped or refused, red failed, grey done) and how long
    ago it was.
  - **The rows:** a row only for a language with something to say:
    - unresolved selectors;
    - grammar rows waiting, in yellow with `· mc language promote`;
    - a reading at least seven days old.

  With nothing to say and no run recorded, the section is not drawn at all, so
  an empty page gains no line.
- **MC** — mc itself, in one line: the version, **whether there is newer code
  than the runner is running**, how long the runner has been up, and the
  commit it is on. `mc run` writes the commit it started on into
  `runner.json` (a runner executes the code it was spawned with, not what the
  checkout holds now), and the page counts what `origin/main` of mc's own
  checkout has past it — past the checkout's HEAD for a runner that never
  said. *Update available — origin/main `<sha>` is N commits ahead · mc run
  --update* is bold yellow, because nothing changes it but that verb. *Update
  requested 12 min ago — the runner hands over after this round* is green and
  is `~/mc/runner/UPDATE` with its own timestamp: somebody has asked, and a
  handover that is not happening can be seen not happening. Otherwise `up to
  date`. It replaced the line that said how old the PR cache is, which
  `mc --json` still carries under `caches`.

### A status that changed out of reach

PROGRAMMES is the top of a page that is taller than most terminals, so its
rows are the ones that scroll off, and the differ leaves a row alone once it
is above the top of the screen — history is not rewritten. So a project went
from `running` to `ready` and its row stood there saying `running` until a key
was pressed (Martin, 2026-09-19: *"status per projekt uppdateras inte
alltid"*). Each frame now carries a **key** (`pageKey`, `home.js`): every
project's status, steps, in-flight mark and open PR — and none of the clocks
beside them. When the key differs from the last frame's **and** the top of
the page is off the screen (`topOffScreen`, `page-frame.js`), the page is
printed again whole (`draw`, `page-live.js`): the screen and the scrollback
are cleared, and the new page scrolls exactly as a first print does, so
scrolling up finds the new page and no old copy above it. It costs whatever
was in the scrollback, which is why a planning session getting a minute older
never triggers it, and a page that fits the screen is diffed as it always
was.

Two rules the sections keep:

- **A number where a number is the answer**, a line only where the identity
  matters — and every count names the verb that expands it, on the right of
  its own heading.
- **A count is only honest if the section says what it cannot see.** INTAKE
  says `first digest — no baseline` rather than `0 new errors`; a desk says
  `not open` rather than claiming nothing is running. A zero that
  looks like health is worse than a gap that says it is one.

## Where the facts come from

Nothing here starts a model or a session. The page reads what the runner,
the helper and the sessions already write.

| fact | file | written by |
|---|---|---|
| a runner is here | `~/mc/runner/runner.json` (pid, started) | `mc run`, at start |
| a session is in flight | `~/mc/runner/current-<repo>[-<lane>].json`, one per lane (name, kind, variant, repo, lane, tool, model, effort, advisor, check_in_minutes, check_ins, started, pid, worktree) | `mc run`, per session |
| stop after this session | `~/mc/runner/STOP` (every lane) | anyone |
| the day behind it | `~/mc/runner/log/runs.tsv` (its `kind` is `plan`, `build-project`, `build-goal`, `review-project` or `review-goal`; rows from before say `step`, `goal` and `review`, and are read as the build or review they were) | `mc run`, after each session |
| where every step stands | `~/mc/runner/projects/<project>.json` (per step: status, pr, branch, blocked_by, reason, comments, session, attempts, landed) | `mc run`, `mc merge`, `mc step` |
| queued merges and reds | `~/mc/runner/merges.json` (repo, pr, branch, reason, stopped_at, since, holder, pid) | `mc merge`, while it waits its turn |
| the round landing right now | `~/.memoro/mc/gate-running.json` (pid, repo slug, pr, mode, since, phase, phase_at), joined to a name through `repos` and to a holder through the repository's lease | `mc merge`/`mc test`, for the length of the round (`runningMerge`, `merges-collect.js`) |
| merge pauses | `runningDeploy` from `deploys.tsv`, `runningRound` from the repository's gate lock/claim, `readLease` from its lease | the same readers as `merger.js` before a round |
| merge success count and last landing | landed PRs in `~/.memoro/mc/gate-rounds.jsonl`, per repository | the merger's round record |
| merger liveness | `~/mc/runner/merger.json` and its live pid | the merger |
| the head of the order | `~/mc/queue.md` — the rest of NEXT is the plans themselves | Martin, at the brief |
| what production said | `~/mc/intake/errors-<date>.md`, `~/mc/proposals/` | `mc helper` |
| the container runtime | `~/.memoro/mc/docker/state.json` (runtime, leases, started_by_mc, last_release_at, inventory, idle_stop) | `mc docker`, `ensure`/`release`, the runner's Docker sweep |
| what mc deployed | `~/mc/runner/log/deploys.tsv` (sha, build, holder, outcome, the live version verified) | `mc deploy`, before and after |
| what production answers it is | `~/mc/runner/version.json` (`GET /api/version`, with the moment it was asked) | `mc helper --collect` |
| someone is sitting here | `tmux ls`, `~/mc/runner/foreground/<pid>.json` | tmux, `foreground.js` |
| open PRs | `~/mc/runner/prs.json` — as GitHub last gave them, stamped | the page itself (below) |
| plans | not cached: read from `~/mc/programs/` on every print (ruling 48), never from a checkout | the page itself (below) |

`runs.tsv` gets its row only *after* a step ends, which is why
`runner.json` and the `current-<repo>.json` files exist at all: before them,
the fact the page most needed — what is running right now — existed nowhere
a program could read. They are written through `atomic-write.js` and removed
when their scope ends, the removal paired in a `finally` so a step that
throws still clears the file.

There is one current file **per lane**: `mc run` runs as many sessions at
once as `mc run lanes` says, across every repository and kind, so SESSIONS
is a list rather than a line, and the page reads `runner/current-*.json` by name instead of one
fixed file — `current-memoro.json` for a repository's first lane,
`current-memoro-1.json` for its second, and the file's own `lane` field is
what puts a session in its file. The lanes themselves are in
[`docs/technical/mc-run.md`](mc-run.md). The *rows* are the total
(`~/.memoro/mc/lanes.json`, read by `collectPage`) whether or not a current
file exists for each, so a lane between sessions has a row saying so rather
than no row at all. A current file whose `lane` is
past the setting still gets a row: the runner was started under a higher count
than the file holds now, and the file is the fact.

**Liveness is one test, `pidAlive`** — `kill(pid, 0)`, with `EPERM`
counted as alive. Nothing asks tmux or pgrep. Both of those lied on
2026-08-29: a dead pane still answered `tmux has-session -t runner`, and
`pgrep -f 'mc run'` matched a step session whose *prompt* contained the
words "mc run". A file whose pid is dead is reported as stale, and counts
as nothing running.

### The foreground register

A session a person opens themselves — `mc brief`, `mc helper`,
`mc plan <name>`, a project opened from the page — is a child of mc
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

`time mc` was 0.09–0.11 s with both caches hit (the plans cache went with ruling 48), against 1.92 s for the board
it replaced. (Measured over twelve runs at load average 10 on 2026-08-29; a
busy moment on the same machine pushed single runs to 0.2–0.3 s.) **That
number no longer holds** — see [*What a refresh
costs*](#what-a-refresh-costs) below, which is the same read measured again
while the live page was built. Two changes bought the original figure, and
they are worth different amounts:

1. **One read per repository instead of one per plan.** `listPlans` was
   spending a `git show` per plan — 37 in memoro alone, 1.45 s of the
   1.92. Until ruling 48 it ran one `ls-tree` and one `cat-file --batch`, walking the
   stream by byte size so a plan full of em-dashes survives it. That alone
   took the page to 0.31 s. `mc brief --collect --offline` got the same win
   for free.
2. **One cache under `~/mc/runner/`** (`page-cache.js`), which bought the last
   0.2 s:
   - Since ruling 48 plans are not cached: they are a directory read of `~/mc/programs/`, not a file keyed by the `origin/main` sha.
   - `prs.json` has no such key, because an open PR closes without moving
     any sha. It is **stamped** instead, written by `--fresh` and by every
     runner round for the repositories it asked GitHub about (`mergePrs`),
     and the page says how old it is out loud.

These are the page's only writes, and the Contract's "reads only" is
recorded as bending exactly here: a read-through cache of what the page
already reads, not state anything depends on. Delete it and the next
`--fresh` fills it again.

Plans have no cold path any more: since ruling 48 they are read on every
print, so a print after `origin/main` moves costs no more than any other. The
fetch that ruling 20 added to each print is the one thing that varies with the
repositories — see *What a refresh costs* for its price.

### What a refresh costs

A refresh is one `collectPage` — the identical read a bare `mc` does, with
no model, no session and no write but the read-through cache above.
So the cost of the page being live is the cost of the page, once every 30
seconds, and the number to know is what that read actually takes now:

| when | `mc --json`, warm | what the machine was doing |
|---|---|---|
| 2026-08-29 | 0.09–0.11 s | the caches hit, quiet |
| 2026-09-02 | 2.4 s, 2.7 s, 4.8 s (and 3.9–6.6 s in a second set) | the runner landing pull requests, several sessions open |
| 2026-09-03 | 1.83 s, 1.11 s, 1.09 s | the runner running, nothing merging |
| 2026-09-12, `--offline` | 0.40 s, 0.39 s, 0.38 s | the same machine, three runs each, the fetch skipped |
| 2026-09-12, fetching (ordinary, ruling 20) | 1.78 s, 1.38 s, 1.39 s | the same machine, three runs each |

The spread is not noise and it is not the renderer. These rows were measured
while plans came from `origin/main` and were cached in the plans cache, keyed
by its sha, before ruling 48: then **every merge invalidated it**, and a machine
whose runner was landing pull requests was a machine where the page was cold
most of the time — exactly when it was most worth watching. The 0.09 s in
the section above is the hit; the seconds above are the miss, and the miss
was the ordinary case under a runner.

Until ruling 48 the miss was also the *only* case: since ruling 20 an ordinary
print fetched `origin/main` for every present repository before it read a
plan, so the 2026-09-12 rows above are the honest floor, not a worst case.
Against the 2026-09-03 baseline of 1.1–1.8 s the added fetch costs roughly a
second — `--offline` lands at 0.4 s, fetching at 1.4–1.8 s. The fetch bought
never showing a plan the workarea had already outrun; plans no longer come
from the repositories, so that reason went with ruling 48.

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
- **Colour carries state, never decoration**: green is work that moves by
  itself, yellow waits on a time, a deploy, another project or a measurement,
  red waits on a person, grey is quiet — the table is below. Only on a TTY,
  and only when `NO_COLOR` is unset **or empty**; the convention is that any
  non-empty value turns colour off, and `--json` is never painted at all.
- No new dependency. The ANSI is by hand, as the rest of the repo is.

## The grid

Every row of PROGRAMMES, SESSIONS and MERGES — and of DEV, when it comes
(goal `mc/dev-section`) — is drawn in one grid, defined once in
`page-grid.js` (`GRID`, `gridColumns`, `gridRow`). Each section had widths of
its own before (goal `mc/page-columns`, Martin 2026-11-03): a project row's,
which a goal borrowed and filled with `g · <name>` and `N sessions`; a lane
row's; and none at all for a merge. So the repository, the state and the pull
request stood at a different x in every section. Now the same kind of fact
stands in the same column everywhere:

| column | width ≥ 90 / < 90 | PROGRAMMES (project · goal) | SESSIONS | MERGES | DEV |
|---|---|---|---|---|---|
| nr + mark | 6 | `12 ●` | the lane's number, `●` | `●` `✗` `·` | `●` |
| kind | 8 | `project` · `goal` | `PLAN` `BUILD` `REVIEW` | `GATE` `WAIT` `FIX` `RED` `IDLE` | `MAIN` `SLOT` |
| name | 28 / 20 | the project · the goal | project and `3/7` · `mc/<goal>` | project or branch · the repository | the session that has it |
| repo | 12 / 0 | repository | repository | repository | repository |
| state | 9 | the state word | `running` · `idle` | phase, `queued`, `waiting`, `red`, `idle` | `leased` `idle` `cold` |
| progress | 10 | `3/7` · `5 sess` | the clock | how long in that state | idle time |
| PR | 9 | `#1251+1` | `#1251` | `#1251` | port |
| tail | the rest | next · what it waits on | model, credits, advisor, check-ins | why, title, `N merges in 24 h` | worktree, branch |

Every width includes the one space that separates the cell from the next, and
a cell's text is clipped one short of it. Three changes from the proposal in
the goal, and why:

- **kind is 8, not 7**: `project` is seven characters, and a cell needs its
  separating space.
- **PR is 9, not 8**: `#14709+3` — a memoro number and three more — is eight.
- **SESSIONS' state is `running`, not the model.** The state column says the
  same kind of thing in every section, in the same colour (green: in hand); a
  model is bookkeeping, and it leads the grey tail.

**Data.** Every cell is drawn from a field `mc --json` carries under the same
name in every section — `name`, `repo`, `state`, `progress`, `prs`, and `kind`
— on each project and goal (`programmes.programmes[].projects[]`,
`.goals[]`), each session (`runner.sessions[]`), and each merge item
(`merges.repos[].landings[]`, `.waiting[]`, `.reds[]`, `.fixing[]`, and the
repository itself for its idle row). The page computes nothing the JSON lacks;
the collector does (`page-collect.js`).

**What gives way, in order**: the tail first — it takes what is left, whole
parts while they fit and the next one clipped — then the repository, which is
not drawn under 90 columns, then the name, which is 28 from 90 up, 20 under
it, and down to 10 at the 60-column floor. The state, the progress and the PR
never give way. At 80 columns no row goes over the edge.

**A cell is clipped with `…` and never in the middle of a number** (`clipCell`):
a cut that would fall inside a run of digits — with the `#`, `/`, `.`, `:`,
`+` that join them — goes before the whole run, so `#14709` is never `#147…`
and `12/30` never `12/3…`. A PR cell drops its `+N` before its number.

The grid has the section headings above it unchanged: the counts on the left,
the verb on the right.

## The palette

The page is grey with meaning painted on it, and the meanings are a short
list. Two of them are tables, and those tables are the rule the rest of the
page bends to: **a kind and a state have one colour each, wherever they are
printed.** SESSIONS says `BUILD` in the same green wherever a build is named,
so a kind is recognised before it is read; `running` is the same green on a
project row, a goal row and a lane. They are `KIND_TONE` and `STATE_TONE` in
`page-grid.js`, and `tests/mc/page.test.js` reads both tables below against
them.

**Colour is state, and the same word has the same colour everywhere.** Green:
in hand — running, or with the merger. Yellow: waits on a person or on another
piece of work, and a clock past a check-in. Red: blocked, red, failed. Grey:
bookkeeping — the repository, the model, the numbers, the tail, `done`,
`dropped`, `idle`. Bold cyan: a pull request number with none of those states.
A zero has no colour.

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

A project's state is its plan's word, with one change: a `blocked` step whose
blocker releases by itself — a time, a deploy, another project (ruling 35) — is
`waiting`, because the runner lets it go. `blocked` is what waits on a decision
or a workarea, which somebody has to open. A goal's state is its stage, and
its status is the colour (below). A merge item's is its phase or where it
waits; a lane's is `running` or `idle`.

| state | colour |
|---|---|
| `ready` | green |
| `running` | green |
| `landing` | green |
| `review` | green |
| `merging` | green |
| `queued` | green |
| `gate` | green |
| `rebase` | green |
| `fixing` | green |
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

A pull request's colour is its own flags' (`prTone`): green while the merger
has it, red bold when it came back red, yellow bold once a day has passed with
nothing on it, grey once it has landed (an idle queue's last), bold cyan
otherwise. A goal's state cell is its stage, of `<stage> · <status>`
([mc-goals.md](mc-goals.md)): `review` and `merging` are green; `build` and
`finish` are green while a session is on them and grey otherwise; `plan`,
`done` and `dropped` are grey; any stage of a `blocked` goal is red. A goal's
tail leads with `criteria <met>/<all>`, green once every one is met, then with
what it waits on: `phase <n> — after phase <n-1>` in yellow for a goal in a
phase its programme has not reached ([mc-goals.md](mc-goals.md), *Phases*),
`blocked · waits on a person` in red for a blocked one. A `ready` goal says
nothing more of its status.

Everything else is structure, and structure is quiet. **plain** in the table
below means no escape at all — the terminal's own foreground, whatever the
person set it to.

| where | what | colour |
|---|---|---|
| header | `MEMORO·CLI` | bold |
| header | `N in flight · N ready · N waiting · N blocked` | plain |
| header | version, rule, cost today | grey |
| section titles | `PROGRAMMES` `HELPER` `BRIEF` `SESSIONS` `MERGES` `PULL REQUESTS` `DEPLOY` `LANGUAGE` `MC` | bold cyan |
| section titles | the count beside it, the verb hint on the right | grey |
| SESSIONS | the heading's `n of N lanes`: not zero, zero, no runner (`not running`) | bold green, grey, bold yellow |
| SESSIONS | the heading's queued count | grey |
| SESSIONS | a lane with a session: its number, its `●`, its kind (`PLAN`, `BUILD`, `REVIEW`) | grey, green, the kind's colour |
| SESSIONS | what it works on | plain |
| SESSIONS | the repository; `running` | grey; green |
| SESSIONS | elapsed: before the first check-in, from it — never red, nothing is killed for its length (ruling 18) | plain, yellow |
| SESSIONS | the tail: the model, credits, the advisor, the check-ins (yellow once there is one) | grey |
| SESSIONS | the day's kinds, each in its colour | the kind's colour |
| SESSIONS | the day's `failed`, `timed out` while not zero | red, yellow |
| SESSIONS | `■ STOP requested` | bold red |
| SESSIONS | `GitHub unreachable for <repo> …` | yellow |
| SESSIONS | a stale runner file | red |
| SESSIONS | a quota answer under 6 h old, older | yellow, grey |
| SESSIONS | the production sha, the rest of that line | plain, grey |
| SESSIONS | `/api/version` naming another commit than the last deploy | bold yellow |
| SESSIONS | a deploy running now, one that has not come back in an hour | green, bold yellow |
| SESSIONS | a deploy that failed after the last good one | yellow |
| SESSIONS | an idle lane, no runner, the rest of the day's line | grey |
| HELPER, BRIEF | the `●` and the verb it is running | cyan |
| HELPER, BRIEF | `·  not open` | grey |
| MERGES | a row's mark: a round or a fix, a red, a queue that waits | green, red, grey |
| MERGES | its kind, its state | the kind's colour, the state's colour |
| MERGES | the project or branch | plain |
| MERGES | the repository, the progress, the tail, an idle queue's name and last PR | grey |
| MERGES | `N merges in 24 h`: nonzero, zero | green, grey |
| MERGES | `paused` with reason; `merger stopped` (heading) | red |
| SESSIONS | a lane's project's or goal's open pull request, in the PR column | the PR's colour |
| PULL REQUESTS | the heading's counts; `N nobody's`; a cache over 15 min old | grey, bold yellow, yellow |
| PULL REQUESTS | a row: its mark, repository, `#pr`, title, whose, quiet time | grey, grey, bold cyan, plain, grey, grey |
| PULL REQUESTS | one nobody holds: its `◆` and whose | yellow |
| PULL REQUESTS | quiet for a day or more | yellow |
| HELPER | a digest's age, under 24 h old, older | green, yellow |
| HELPER | new errors, when > 0; the `!` before the loudest message | red |
| HELPER | no digest yet, no new errors | grey |
| BRIEF | proposals, when > 0 | yellow |
| MC | update available; update requested; up to date | bold yellow, green, grey |
| MC | a process — the merger, the repo watch — on another commit than the checkout: its pid, its commit, the checkout's | yellow |
| PROGRAMMES | a project the runner is stepping, a goal a session is on — `●`, its name | green, bold |
| PROGRAMMES | a quiet project's or goal's name | plain |
| PROGRAMMES | the kind, `project` or `goal`; the tail | grey |
| PROGRAMMES | the programme heading | bold cyan |
| PROGRAMMES | a programme's open planning-session counts per provider | grey |
| PROGRAMMES | a programme with no planning session | grey |
| PROGRAMMES | a programme's own count of ready, of blocked, of nothing | green, red, grey |
| PROGRAMMES | a programme with no project yet | grey |
| PROGRAMMES | a collapsed row: `N blocked`, its numbers and its blockers | red, grey |
| PROGRAMMES | the repository a project lives in | grey |
| PROGRAMMES | the PR column, `#pr` or `#pr+N` | bold cyan |
| PROGRAMMES | that column when the PR has been quiet a day; when the merger has it; when it came back red | bold yellow, bold green, bold red |
| PROGRAMMES | the number, the progress | grey |
| PROGRAMMES | `not an area mc knows` | yellow |
| PROGRAMMES | a stray's name, its facts | bold, grey |
| footer | the cache line, the notes | grey |

Five things hold that table up:

- **Plain 16-colour SGR, and only the `SGR` table in `status-render.js`** —
  `bold`, `dim`, `red`, `green`, `yellow`, `blue`, `magenta`, `cyan`, `white`,
  `grey`. Nothing 256-colour, nothing new, and `bgred` turned out not to be
  needed. The page draws from a subset of that table: `dim` and `white` are
  still in `status-render.js` for whoever else wants them, and `page-render.js`
  uses neither — see the bullet below.
- **No `dim`, and primary text is the terminal's foreground** (2026-09-06).
  `dim grey` was `ESC[2m` over `ESC[90m` — two steps down from the foreground —
  and it drew the repository cell of all 41 project rows, `no plan session` on
  every programme heading, `·  not open` on a desk, and the skip line under
  what was then QUEUE. On Martin's terminal that is at or below the
  background: a cell nobody
  can read is not a quiet cell, it is a missing one. `white` was `ESC[37m`, one
  fixed colour a theme never chose — the wrong end of the scale on a light
  theme, dimmer than its neighbours on a dark one. Both are gone from the page.
  What receded by being dim now recedes by position, by the `·` glyph, or by
  plain `grey`, which is one step and not two; what was `white` is a part with
  no styles, which `paint` and `painter` return untouched, and `bold` is what
  marks the name a row is about. The plain page is unchanged — there was never
  an escape in it — and `mc --json` never carried one either.
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
walked through every section that prints them, the clock before and past its
first check-in and never red, and — at six terminal widths — painted against plain, row for row,
with every escape checked to be whole. Two more assertions keep the paragraph
above honest: no row of the page carries `dim` or `ESC[37m`, and no row of any
table on this page names either. In the snapshot, primary text leaves no run at
all — a cell that disappears from a signature is a cell that went back to being
read rather than coloured.

## The menu

At a terminal the page ends in a prompt:

| | |
|---|---|
| a goal's number | `mc goal show` for it, and the page again — **PROGRAMMES’ number**, not a listing of its own |
| `a` | draws the page again with every programme, the dormant ones too. `a` again folds them |
| `b` | `mc brief` |
| `p <name>` | `mc plan <name>` |
| `q`, empty | quit |
| a retired verb (`work …`, `worker …`) | the line the shell gives it, and the page again |
| anything else | said out loud — *nothing here called …* — and the page again |

The prompt reads `/dev/tty` by design, so a subprocess without a terminal
never reaches it.

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
97-line page, 2026-09-06 — eleven `sql-readiness` rows reached the screen as
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
on that `1`, because that opens a project session and launches a tool on the machine
it is running on. That the reader hands back `1` after a refresh is asserted
in `page-live.test.js`, and that `1` opens the project PROGRAMMES numbered
`1` is asserted in `front-door.test.js`; the join between the two is the only
part nobody has run.

## The modules

| file | what it is |
|---|---|
| `src/mc/commands/home.js` | the two surfaces: the page and the menu |
| `src/mc/page-collect.js` | the sections, built from read data — one key each, and its module comment names all of them |
| `src/mc/merges-collect.js` | `runningMerge` — the gate lock joined to a name and a holder |
| `src/mc/page-render.js` | how they look |
| `src/mc/page-grid.js` | the one grid every PROGRAMMES, SESSIONS and MERGES row is drawn in, and the palette (`STATE_TONE`, `KIND_TONE`) |
| `src/mc/page-frame.js` | the difference between two frames, as bytes — pure, no terminal |
| `src/mc/page-live.js` | the loop under the prompt: the 30 s interval, the raw-mode reader, the arithmetic |
| `src/mc/page-cache.js` | `prs.json` |
| `src/mc/status-collect.js` | the readers more than one caller needs — `nowBlock`, `kindFor`, `pidAlive`, `areasWithCheckout` |
| `src/mc/status-render.js` | the drawing primitives — `painter`, `width`, `pad`, `clip`, `elapsed` |
| `src/mc/foreground.js` | the foreground register |
| `src/mc/status-project.js` | `mc status <name>` — also draws the landing line from `runningMerge` |

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

Removed with their tests: the bare workarea verb (it was `mc`; the whole verb
went on 2026-11-03), `mc list` and
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
