# mc helper — the eye on production

Linux SSH interactive launches keep their provider alive past the terminal ([Claude background session or Codex app-server](mc-interactive-sessions.md)); macOS retains the existing foreground terminal.

`mc helper` is the eye: what production says, read each day and written as a
digest, and the inbox of files drained one turn at a time. Martin's own word —
a bug, something that should be better — is not here: it is said at the desk,
`mc martin`, which places it ([mc-martin.md](mc-martin.md), *Placing*). **The
only thing the eye produces is a proposal** — a file in the `proposals/` of the
area it concerns, `~/mc/areas/<repo>/<area>/proposals/`, that nobody acts on
until Martin picks it up at `mc martin`, or the manager's curation turn reads it
([mc-manager.md](mc-manager.md)).

| | what it does |
|---|---|
| `mc helper --intake` | **the eye.** The day's digest per repository, then the inbox drained: one headless turn per file, oldest first, each file archived the moment its turn ends |
| `mc helper --collect` | the eye's script half alone: write `~/mc/intake/errors-<repo>-<date>.md` for each repository, with the delta against that repository's previous digest. **No model, no writes to production** |
| `--since <iso>` | the window; default is the last 24 h |
| `--limit <n>` | fingerprints asked for; default 50, the route caps at 200 |
| `--threshold <n>` | hits at or above which a *new* fingerprint is marked `!`; default 20 |
| `--model <model>` | override the role's model for the intake turns |

**The bare verb is refused.** A call with neither `--intake` nor `--collect` —
bare, `--new`, `--resume`, `--bg`, `--local`, a tool or model flag alone, a
digest flag alone — writes `mc: mc helper is no longer a way in — the desk is mc martin` and
`mc: mc helper --collect and mc helper --intake are unchanged` to stderr and
exits 2, before anything is read, made or started. The desk that used to answer
it is `mc martin`; there is no `helper` role and no role file for it.

The directory `~/mc/helper/` is left alone: the eye's state and the old desk's
conversations stay where they are, and nothing creates or reads it for a
session any more.

Nothing here changes a goal. A proposal is read at the next brief and
Martin orders it or drops it — that is the arrangement that lets the eye run
unattended every day.

## The inbox

`~/mc/intake/` is an inbox. Anyone may drop a file in it — an error log, a
screenshot, a note — and the collect step adds one digest a day per repository.
Nothing stays in it: **one file, one turn, one outcome**, and the file is
archived under `~/mc/runner/log/intake/<date>/` the moment its turn ends. The
next chore pass takes the next files, until the directory holds nothing.

The archive is unconditional, and that is what makes this an inbox rather than
a pile. A turn that failed, timed out, hit the quota or threw has still had its
turn; a file put back for the next pass is a file every pass after this one
takes again. An inbox that keeps what it could not judge never drains.

**The turn opens the file itself.** It is named in the prompt, never inlined in
it: the turn stands in `~/mc/intake/`, so a name is enough, and a screenshot has
no text to inline. That is the whole reason the inbox can hold anything.

### It is not an area's `proposals/`

The two rooms differ by who has done the judging. The inbox is raw material
nobody has read yet, and it costs a turn to work out what is in it. An area's
`proposals/` is the other end: a session already understood the thing and
wrote down what should happen about it. A session that has done the judging and
drops its finding in the inbox asks a second session to work it out again from
less than it had.

### Runner records are not inbox items

The runner's current files, logs and per-goal LOG.md entries stay beside the
work they describe. Repeated machine output is not a file somebody dropped
in an inbox. The drain lists files, not directories, so an archive directory
inside intake is not itself drained.

## What the eye reads

memoro already records what matters — grouped worker errors in D1, the
server's own analysis pass, AI-provider refusals, what production says it
is. Before this verb, nothing read any of it unless a person
did, and nothing alerted: surveyed 2026-08-29, there was no uptime check, no
notifier and no Logpush. The eye does not add a monitoring system. It adds a
reader.

Eight sources, and they do not share one failure domain. Each section of the
digest says what it could not read, and the run still succeeds: wrangler
being unauthenticated must not cost us the other seven.

| section | how it is read | credential | timeout |
|---|---|---|---|
| error fingerprints | `scripts/admin/survey-errors.mjs --env production --limit <n> --since <iso>`, JSON on stdout | the script resolves `ADMIN_TOKEN` itself | 60 s |
| analysis items | `GET /admin/analysis` — the server's own LLM pass over errors and feedback | bearer `ADMIN_TOKEN` | 30 s |
| AI-provider errors | `scripts/admin/inspect-ai-provider-errors.mjs --env production --days 1` | **none** — it shells out to `wrangler d1 execute memoro-db --remote` | 180 s |
| deploys | the last `deployed` row of `~/mc/runner/log/deploys.tsv`, which `mc deploy` wrote — read from disk | none | — |
| what is live | `GET /api/version` — `{ commit, build, build_time }`, kept in `~/mc/runner/version.json` for the page | none | 30 s |
| service health | `GET /admin/health` — secrets, D1, R2, KV, both Vectorize indexes, queues | bearer `ADMIN_TOKEN` | 30 s |
| D1 health | `GET /ping-d1` — the reading that does not depend on the token | none | 30 s |
| operations | `GET /admin/operations/status` — the nightly scheduler and its tasks, the claims resolver, the AI batches, the incident summary | bearer `ADMIN_TOKEN` | 30 s |

A script that fails is named by how it ended and the first line of its stderr
that says anything — `exit 1: wrangler d1 execute failed (1)`, or an uncaught
exception's own `Error: …` line. The last line was read until 2026-10-03, and
it was `}` (the close of `wranglerD1Json`'s JSON dump) or `Node.js v24.10.0`
(Node's banner under a crash), so the AI-provider section said
`_could not read: }_` from 2026-08-30 on without naming a cause.

The deploy section reads **mc's own record and what production answers**.
`deploys.tsv` is written by `mc deploy` around the deploy itself; `/api/version`
says which commit and build production is serving and when that build was
made. The age is the fresher of the two — a deploy made some other way is not
stale merely because mc did not run it — and the digest says plainly when
production is answering a commit other than the one mc last shipped. With
neither reading, the age is *unknown*, not stale.

Until 2026-10-03 it also read `GET /admin/deploy/logs`, the `deploy:index` KV
key a GitHub deploy webhook was meant to fill. The index never held anything,
the digest reported that every day as `deploy-webhook-silent`, and memoro
removed the webhook, the route and the nightly `checkDeployAge` that read it
(memoro #12452). The flag went with them, and so did `deploy-failures`, which
only that log could see.

Three facts about that table are easy to get wrong and were measured, not
assumed:

- **`/admin/*` is the admin-token surface; `/api/admin/*` is session-admin.**
  Measured against production on 2026-08-29, `/api/admin/health`,
  `/api/admin/operations/status` and `/api/admin/analysis` all answered 401
  to a bearer token — "Not logged in or session has expired." Only a browser
  session opens them. memoro #12461 (production build 24645, 2026-10-03)
  added `GET /admin/health` and `GET /admin/operations/status` to the token
  surface; both answered 200 to the digest's token that day, and the digest
  reads those two paths. The `/api/admin/*` ones are still not used.
- **`--env` defaults to `local` on both admin scripts.** Collect passes
  `--env production` explicitly, or it would silently digest an empty local
  database.
- **The token is never rendered, logged or returned.** It is read from the
  environment, or from `ADMIN_TOKEN` in `.dev.vars` in the memoro checkout,
  and handed to `fetch` as a bearer. With no token, the two routes that want
  one are *reported as unread*, not attempted.

The digest also carries `origin/main`'s sha and date from the local memoro
checkout, next to the deploy age, so "the site is behind main" is one line
rather than two windows.

### Health and operations

- **Service health** is `/admin/health`'s overall `status` and one row per
  service — `secrets`, `d1`, `r2`, `kv`, `knowledgeBaseVectors`,
  `universeVectors`, `queues` — with its status and whatever detail it
  carries: latency, present-of-total, a note, an error. `/ping-d1` stays
  beside it, because it needs no credential: with the token gone, D1 is
  still read.
- **Operations** is `/admin/operations/status` rendered compactly: one row
  per operation with the server's own conclusion (`ok`, `watch`, `action`)
  and reason codes, the latest run's status and finish time, and its
  non-zero counts (failure counts always); then every nightly task that did
  not complete, and the incident summary. The conclusion is taken as given —
  it is memoro's judgement of its own processes. Until 2026-10-03 the digest
  had a standing "Not readable" section here instead.

### What it does not read

- **Deploy age is in no route.** The digest computes it itself, from mc's
  record and `/api/version`'s `build_time`, and calls it stale past its
  own 36-hour threshold — the one memoro's removed `checkDeployAge` used.
- **`/ping-kv` is not called.** It writes a probe key and deletes it again.
  That is a write, and the Contract keeps the helper out of it. KV is
  reported from `/admin/health`, which only `get`s a key.

## The delta, and why the digest is its own state

**There is no delta anywhere in memoro.** `/api/admin/errors` takes a
`since` and a `limit` and returns the top N by `last_seen`; nothing records
what a previous run saw. So `--since` filters rows, but it cannot say what is
*new*.

The previous digest is therefore the only baseline there is, which makes the
digest's own format the state. Every digest ends with a machine-readable
block:

    <!-- mc-helper:state v1
    fingerprint a1b2c3 41
    failing deploy-stale
    -->

Two lists: the fingerprints this digest saw with their counts, and the named
operational conditions that were failing when it was written
(`deploy-stale`, `d1-unreachable`, `d1-unhealthy`, `health-<service>`,
`nightly-tasks-failed`, `nightly-stale`, `operations-action-<key>`). The next
run diffs against them.

- `health-<service>` — a service `/admin/health` reports as anything but
  `healthy`, e.g. `health-r2`. `not_configured` counts: a binding missing in
  production is worth one line.
- `nightly-tasks-failed` — the nightly scheduler's latest run is `partial`
  or failed, or it counts a failed task.
- `nightly-stale` — the server concludes the nightly run is stale or has no
  run data.
- `operations-action-<key>` — an operation the server concludes needs
  `action`, e.g. `operations-action-claims.resolver`. One name per operation,
  not per reason code or count, so a standing backlog is new once, the day it
  starts, and not every day after.

An unread route raises none of these: a 401 on `/admin/health` is the
section's *could not read*, not an unhealthy service.

`d1-unreachable` is not raised when **no request to production got an answer
at all** in the run: `/admin/analysis`, `/admin/health`,
`/admin/operations/status`, `/ping-d1` and `/api/version` all threw rather
than returned (a route skipped for want of a token is left out of the count).
That is the collector without a network, and the digest says so in one line at
the top instead; no service or operation condition is raised either. On 2026-09-15, 09-29 and
10-02 every request said `fetch failed`, the digest opened on
`! d1-unreachable`, and production was healthy. A refusal or a 5xx is an
answer, so it does not count, and one answer anywhere is enough to raise
`d1-unreachable` as before.

The baseline is **the newest digest that is not the one being written**, so a
second run on the same day measures against yesterday instead of comparing
today's file with itself and reporting nothing new. A first run has no
baseline and says `first digest — no baseline` rather than calling all fifty
fingerprints new.

Each repository's baseline is its own: the name carries the repository, so a
delta is never measured against the other system's digest. memoro also
accepts the older unprefixed `errors-<date>.md`, because renaming a file whose
only purpose is to be *the previous one* would otherwise throw away a day of
delta.

## Two repositories, one eye

memoro's production is the deployed service — seven remote sources, an admin
token, wrangler. memoro-cli has no server, and for a week that was read as
"nothing to collect", so every failure in mc itself was found by a person
noticing it. On 2026-08-30 sixteen gate rounds stopped on a held lease in one
day, and that was a feeling rather than a number.

memoro-cli has a production. It is this machine, and mc records what happens
there in four files: `logs/mc.log` (every invocation and how it ended),
`gate-rounds.jsonl` (every round, including the ones that started and never
finished), `repo-leases/leases.log` (claims, releases, reaps) and
`runner/log/runs.tsv` (every session). The eye now reads both.

The second half reads no network and holds no credential, which is why it can
run every day without asking anybody for a token — and why a memoro collect
that fails on an expired wrangler login does not cost memoro-cli its digest.

It is the **same** delta, state block and threshold, deliberately: a second
implementation of "new since yesterday" would be a second answer waiting to
disagree with the first. A fingerprint on this side is a failure *signature*
with its variables removed — pull request numbers, pids and commits become
`N` and `<hash>` — so two rounds that both stopped on `lease` are one
fingerprint seen twice. Without that the digest could never say "sixteen".

A `runs.tsv` row is a finding unless its note says `success` and its exit is
`0` or `143`. 143 is the runner's own SIGTERM: a session that lingers
`resultGraceMs` after answering is killed with its result standing, and since
that grace came in on 2026-09-25 about three quarters of all session rows end
that way. Counting them made every newly started goal a new fingerprint and
buried the sessions that did fail. A `success` row with any other exit is still
named, exit code and all.

One turn per digest, not one over both: `repo:` is the frontmatter key
everything downstream routes on, and a reader left to infer it would get it
right most days. The days it did not would be a proposal filed against the
wrong system.

## The digest

`~/mc/intake/errors-<repo>-<date>.md`, in this order:

- **New since the last digest** — the agenda. One bullet per new fingerprint
  and per newly failing condition, marked `!` at or above the threshold and
  `·` below it.
- **Error fingerprints** — the window's table, with the per-status group
  counts above it. Context, not a to-do list.
- **Analysis items** — what the server's own LLM pass produced, read
  directly. The helper never fires the `POST` that *runs* that pass; it runs
  on the server's own cadence.
- **AI-provider errors** — provider, model, refusal reason, calls.
- **Health** — `/admin/health`'s verdict and one row per service, then
  `/ping-d1`'s D1 verdict and the calls it timed.
- **Deploy** — last success, age, consecutive failures, or the silent index;
  and `origin/main` locally.
- **Operations** — one row per operation with the server's conclusion, the
  nightly tasks that did not complete, the incident summary.
- the state block.

## The turn

One headless session with the `intake` role (`canon/roles/intake.md`,
Sonnet), standing in `~/mc/intake/`, timeout 10 minutes, given **one file by
name** and asked for one outcome.

The role is `intake`, and the eye keeps the name `helper` for its verb, its
run rows and its state under `~/mc/helper/`: a name that is only an identifier
in those places is not worth a migration. The turn is told there is nobody to
ask; the desk (`mc martin`) is where Martin is asked.

**The file is named; the ground is given.** The prompt carries the filename and
then what the turn judges it against — every unfinished goal under `~/mc/programs/`, with its stage, status and
last Next, the historical repository log,
and the proposals already waiting. Its cwd is the intake directory and the
repositories are elsewhere on the disk: a turn that cannot reach them cannot
accidentally write in them either, which is cheaper than trusting it not to. The
file itself is the one exception, and it has to be.

**Which system it belongs to is read from the name when the name says it.**
`repoOfFile` answers `memoro` or `memoro-cli` for the collector's own
`errors-<repo>-<date>.md` and the legacy unprefixed `errors-<date>.md`, and
`null` for everything else. On a known name the prompt tells the turn; on `null`
it tells the turn to decide from what it read and say which in the proposal.
`repo:` is what everything downstream routes on, and a finding filed against the
wrong system is worse than one not filed — but a file Martin dropped in belongs
to whichever system its contents say, and the turn is the only reader that can
tell.

**One file, one outcome.** One proposal or none. Not two from one file — one
report is one proposal — and no proposal is the right answer whenever the file
does not warrant one. The turn says in one line which it did and why.

**A file it cannot read whole is said so, not judged from its head.** Past the
tool's read limit, or in a form it cannot open: a proposal that names the limit,
or no proposal with that as the reason. Measured on 2026-09-05 against 6 MB of
`/dev/urandom` — no proposal, and the line read *"high-entropy binary with no
header, magic bytes, or structure — the file is unopenable, and there is nothing
to judge it against"*. Two large text files did not reach the rule at all: a
23 MB log and a 240 000-line one were both counted with shell tools and reported
as counted, which is the better answer. The failure this guards against is the
confident summary of a file somebody saw the first page of.

**Where a proposal goes is the area it concerns.** An area is an area page a
repository declares on origin/main (a distinct `page` of its `.mc/areas.json`),
keyed `<repo>/<slug>` by the page's file name: `memoro-cli/system`,
`memoro/trust`, `memoro/delivery` and the rest. `helperGround` reads the declared
pages from the checkouts it already reads, and the prompt lists their keys (the
directories under `~/mc/areas/` when none could be read) with the two fallbacks
for a finding with no clear area: `memoro-cli/system` when mc would change,
`memoro/delivery` when memoro would change. There is no ownerless place, and a
programme is an order, not a place for a proposal: the programmes are in the
prompt as ground only.

**What it wrote is measured, not believed.** `runHelperTurn` lists every
area's `proposals/` (`listAllProposals`, `src/mc/area-proposals.js`) before and
after and reports the difference, by area. A turn that says it filed three and
filed none is reported as having filed none.

Its output is zero or more `~/mc/areas/<repo>/<area>/proposals/<date>-<system>-<slug>.md`, system
`mc` or `memoro`, with prose inside. The turn is told the system when the
digest's name says it (`errors-<repo>-<date>.md`); a file whose name says
nothing is decided from what the turn reads, and the turn puts the system in
the name. `describeTurn` names a new file whose name carries no system, and
that file is never renamed: mc does not guess a system from its text, because
that is the parse the listing was rewritten to avoid. **mc does not read a
proposal** — `listAllProposals` returns filenames and never opens one.

The role's judgement rules are in the role file, and
three of them matter enough to repeat: what was already there yesterday has
already been seen; a proposal that duplicates a live goal is noise; **zero
proposals is a good answer** — a quiet day should cost Martin nothing to
read.

The turn writes only a proposal in an area's `proposals/`. It changes no goal, code,
production data or credential, opens no PR or session, and asks no question:
there is nobody to answer one.

## When the two halves run

Two gates, because they answer two different questions. `mc run` runs both at
the top of every chore pass — its loop beside the lanes that take goals, one
pass every `--idle-sleep` ([`mc-run.md`](mc-run.md) § *The pick, in order*) —
and calls `collectHelper` and `drainIntake` directly rather than the verb.
Neither is a goal build: no worktree, no branch, no PR.

**The collect is a day.** It runs once per calendar day, at the top of
the first chore pass after 05:00Z, and writes one digest per repository. `helperDue`
(`run-plan.js`) reads `~/mc/runner/log/runs.tsv` and nothing else — there is no
stamp file beside it to fall out of step with — and looks for a row
whose `kind` is `helper` and whose date is today. The row goes in whether the
collect worked or not, which is the whole of "a failed collect is logged, never
retried within the day": a `collect-failed` row closes the day exactly as a
successful one does.
There is no model in this half — it writes two files and two rows.

**The drain is a question about a directory.** `runIntakeDrain` asks only *is
there a file in the inbox?*, so a pass can drain without collecting, and
collect and drain in the same pass. It takes the oldest `INTAKE_PER_ROUND` = 3
files — oldest by the date **in the name** (`intakeQueue`), not by the name
itself, because `errors-memoro-2026-09-04.md` sorts before
`errors-memoro-cli-2026-08-31.md` as a string, and a name with no date in it
sorts last, which is arrival order too.

Three is what a pass can afford: a turn is capped at ten minutes and measured
at 39–193 s on files Martin dropped in and 115–691 s on a digest, so a pass's
drain is bounded at half an hour and usually far under it, beside a lane's
ninety-minute session. One a pass would take thirteen passes to clear a backlog of
thirteen; the whole inbox in one pass has no bound at all and would stop the
chores for a morning after Martin drops forty screenshots in. The constant is
still called `INTAKE_PER_ROUND`, from when the chores ran inside the runner's
round.

Sharing one gate is what filled the directory in the first place: the runner
could read one file a day, and only if it had also collected.

**The rows.** The collect writes one row per repository, carrying
`helper` in both the name and the kind column, with the note
`success,<repo>,<n>-new` or `collect-failed,<repo>`. Each drained file writes a
row of its own: `kind: intake`, **the file in the name
column**, note `success,<n>-proposals` or the turn's own reason (`no-tool`,
`no-role`, `timeout`, `turn-threw`). Its own kind, so a drain that happened to
run does not close `helperDue` for the day and so a reader can tell the script
that read production from the model that read one file; the file in the name
column, because that is the column for naming the thing a row is about.
`summariseRuns` counts kinds generically and the page's day line prints them the
same way, so both are counted with no change. The twelve `helper` rows written
before 2026-09-05 mean both things, and nothing re-reads them.

**The outcome goes first in both notes.** `summariseRuns` counts a note that
does not start with `success` as a failure, and every helper row ever written
read `memoro,success,0-proposals` — so the brief and the page had counted every
helper day as a failed run since the row existed.

The turn's tokens go in the same `input`/`output`/`cache_read`/`cache_write`
columns a goal session uses, so the page can price the day honestly. `run.js`'s header
used to say the runner never calls a model; it does now, up to three times a
chore pass.

**`mc run --once` runs neither.** That flag exists to watch one goal session, and
production reads plus model turns are not what somebody typing it asked for. The
real runner never passes `--once`, so this costs nothing.

A `~/mc/runner/STOP` file stops both. The drain checks it between files, never
inside one, and a turn that hit the quota pauses the runner through its shared quota pause.

`mc helper --intake` at a terminal goes through the same `drainIntake`, the same
cap and the same archive — one drain, not two. The desk has no schedule at all:
it runs when Martin opens it.

## Who acts on it

No session turns a proposal into work on its own, with one bounded exception.

- **The manager's curation turn** ([mc-manager.md](mc-manager.md)) — its prompt
  lists the waiting proposals of every area's `proposals/`, each with its area,
  oldest first. It creates no programme: a proposal that reports a
  defect against an area text, in an area with no repair in flight, is put to
  Martin with `mc martin propose`, and Martin creates that area's repair
  programme (`mc programs create … --area … --from-proposal`); the others wait.
- **Martin**, at `mc martin`, orders one (`mc programs create … --from-proposal`,
  which archives it in its area's `proposals/archive/` under `Utfall: ordered in
  programme <name>`) or has it archived there with its own `Utfall:` line. The
  proposals the desk files and the eye's are read the same way, because they are
  the same file. `mc proposals` counts what waits, by area.
- **The page (`mc`)** puts digests under HELPER and proposals under BRIEF.
  The digest view shows its age,
  what is new in it, how many proposals are waiting — and the `!` lines
  themselves, first, three named and the rest counted. A count is a number
  somebody has to go and look up; the line is the thing that makes them look.
  With no digest it says `no digest yet — mc helper --intake has not run`
  rather than printing a zero that would read as "production is quiet". The
  section reads the newest digest **in the inbox**, and the inbox now drains —
  see *What is not done*.

## The Contract

- The eye **reads** production; its sole write is the receipt of verified local suggestion copies. No other purge or status
  change on an error, no deploy, not even `/ping-kv`'s probe key.
- The eye never lists, edits or deletes a proposal that is already waiting.
  It only adds.
- It changes no goal. Proposals are its only output.
- No resident session, no watcher, no pulse. The eye runs when the runner
  runs it and exits.
- Alerting beyond the page — push, mail, macOS notification — is a separate
  decision, not part of this.

## Where the code is

| file | what |
|---|---|
| `src/mc/commands/helper.js` | the verb: the refusal of the bare call, and behind `--intake` the collect and the same drain the runner uses |
| `src/mc/helper-collect.js` | the eight sources, the delta, the state block, the rendered digest, `helperDir`, `intakeDir`, `intakeArchiveDir` |
| `src/mc/helper-turn.js` | the prompt over one named file, `repoOfFile`, the ground: the unfinished goals under `~/mc/programs/` and each checkout's historical log, the headless session, the measured `wrote` — and `drainIntake`, the loop that archives every file the moment its turn ends |
| `canon/roles/intake.md` | what the turn is, what it may write, how it judges |
| `src/mc/run-plan.js` | `helperDue` and `collectNote` for the day; `intakeQueue`, `intakeNote`, `INTAKE_KIND` and `INTAKE_PER_ROUND` for the drain |
| `src/mc/run.js` | `runHelperDay` — the daily collect — and `runIntakeDrain`, the inbox every chore pass |
| `src/mc/paths.js` | `RUNNER_HOME` and the three tables that left the inbox: `runnerTablePath` for the writer, `runnerTableLabel` for the brief |
| `src/mc/area-proposals.js` | where proposals live: `areasHome`, `areaProposalsDir`, `areaProposalsArchiveDir`, the area keys (`declaredAreaKeys`, `areaKeysOnDisk`), the fallbacks and `listAllProposals` — the names, and nothing about what is in them |
| `src/mc/brief-collect.js` | `proposalSystem`, the system a proposal's name carries, and the three sections read from `~/mc/runner/` |
| `src/mc/page-collect.js`, `page-render.js` | `newErrorLines`, `intakeSection`, the INTAKE block |

The intake role file reaches its session the same way every other role file does —
`canon/roles/all-sessions.md`, then the role's own words,
assembled by `instructionsFor`. That mechanism is [`mc-roles.md`](mc-roles.md).

mc does not read a proposal. It used to parse a fixed frontmatter and fixed
section names out of every file, in three places that disagreed with each
other: a proposal whose first prose line was not marked `# ` was counted by the
page, missing from the brief, and recorded as "wrote nothing" by the very turn
that had just written it, with no error anywhere. The parse existed so a script
could say what kind of thing each file was; nothing needs that. `listAllProposals`
returns the markdown names by area, and a session that has to know what is in
one opens it.

Tests: `tests/mc/helper-collect.test.js` (the digest on stubbed script output
and stubbed routes, the delta against a previous digest, the failure domains
kept separate), `tests/mc/helper-turn.test.js` (the prompt as a pure function over a named
file, `repoOfFile`, and the drain — including the file that is archived after a
turn that threw), `tests/mc/commands/helper.test.js` — where the refusal cases hold the thing
worth holding down, that a call without `--intake` or `--collect` reaches
neither the collect step nor the model and exits 2, and where the verb's drain is handed its own `files`
and `move` so the real inbox is out of reach even when the suite is run without
`tests/_isolate-home.mjs` — `tests/mc/run-plan.test.js` (`intakeQueue`'s order,
`intakeNote`, the two gates), the helper and intake blocks of
`tests/mc/run.test.js` (the day's collect and the drain driven end to end on
fakes: one row per file naming it, the failed turn's file archived all the same,
`decisions-archive/` untouched, the cap and what is left over) and the INTAKE
cases in `tests/mc/page.test.js`. No network and no model in any of them.

## What is not done

**The delta's baseline is in the room that now drains.** `previousDigest` reads
`~/mc/intake/` and only `~/mc/intake/`, so the baseline for tomorrow's digest is
yesterday's file — the same file the drain archives the moment its turn ends.
Measured 2026-09-05 against the real function: with yesterday's digest in the
inbox the baseline is `errors-memoro-2026-09-04.md`; with it moved to
`~/mc/runner/log/intake/<date>/` the baseline is `null`, which renders as *first
digest — no baseline* and an empty *New since the last digest*. Today's backlog
of fourteen files hides it — the drain takes three a pass, oldest first, so the
newest digest is not archived on the day it is written — but once the inbox is
empty every day's digest will be a first digest, and *the delta is the agenda*
is the rule the whole turn judges by. The fix is a baseline that looks in the
archive as well as the inbox; proposal `2026-09-05-digest-baseline-archived.md`.

**The page's INTAKE section reads a name the collector stopped writing.**
`readDigest` (`page-collect.js`) matches `errors-<date>.md` only, so it has not
seen a digest since the repository prefix landed: measured 2026-09-05, it read
`errors-2026-08-30.md`, six days stale, while today's two digests sat beside it.
Once the inbox drains it will find nothing at all and say `no digest yet`. That
is not the drain's doing, but the drain makes it permanent; proposal
`2026-09-05-page-intake-digest.md`.

`scripts/sync-todo.mjs`, the `/improve` command and the `docs/TODO.md`
production sentinels in `~/memoro` still exist. Decision `mc-2` retires them
once the helper has run for a week: two systems doing the same thing, and
this is the one that puts proposals where the manager and Martin can see them instead of
making a human in a terminal into the queue. The helper has to earn it first.

## Anonymous app suggestions

`collectHelper` for memoro also collects `suggest_improvement` through the ledgered token-only `GET /api/admin/suggestions`. This is the suggestion exception in memoro's production-data-access standard; it grants no access to account content. It runs on the existing runner collection cadence and on `mc helper --collect`. The retired user_feedback form is unrelated.

Each exact kind/text pair becomes one `intake/suggestion-<sha256>.md`, retaining every original id, kind, text, build and UTC day. Existing copies are found in the inbox and the intake archive, so retries do not requeue an already judged file. Atomic write, file/directory sync and exact read-back precede `POST /api/admin/suggestions/receipt`, which names only that batch's copied ids. A receipt is a transfer acknowledgement, not a new approval request (Martin, 2026-11-16 and 2026-11-18). An unavailable list, invalid row, failed copy or unconfirmed receipt is visible in collection notes and the User feedback maintenance row; unrelated error collection continues. Next collection retries unacknowledged ids. No new programme or goal is created by collection. The intake role routes the original report to its area and preserves provenance.

The local status in `helper/suggestions/status.json` describes the last collection and pending receipts, not a live server backlog count. A successful empty list is zero; a failed read is an error, never proof that no feedback exists. At most three batches of 200 are fetched per collection (the app admits 500 waiting rows).
