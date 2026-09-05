# mc helper — the desk, and the eye on production

Two things get noticed about memoro: what production says, and what Martin
says. `mc helper` is the door for both, and **the only thing either of them
produces is a proposal** — a file in `~/mc/proposals/` that nobody
acts on until Martin picks it up at `mc brief` or `mc plan`.

| | what it does |
|---|---|
| `mc helper` | **the desk.** A foreground session in `~/mc/helper/` that takes Martin's report of a bug or something that should be better, and writes it as a proposal. No digest, no production, no fix |
| `mc helper --intake` | **the eye.** The day's digest per repository, then the inbox drained: one headless turn per file, oldest first, each file archived the moment its turn ends |
| `mc helper --collect` | the eye's script half alone: write `~/mc/intake/errors-<repo>-<date>.md` for each repository, with the delta against that repository's previous digest. **No model, no writes to production** |
| `--since <iso>` | the window; default is the last 24 h |
| `--limit <n>` | fingerprints asked for; default 50, the route caps at 200 |
| `--threshold <n>` | hits at or above which a *new* fingerprint is marked `!`; default 20 |
| `--model <model>` | override the role's model — the turn's, or the desk session's |

The three digest flags belong to the eye. On the bare verb they are refused
by name: somebody who types `mc helper --since` is asking for a digest
window, and opening a session that ignores them would answer a question they
did not ask.

Nothing here writes `~/mc/queue.md`. A proposal is read at the next brief and
Martin queues it or drops it — that is the arrangement that lets the eye run
unattended every day, and it is why the desk can hand him something without
having decided anything.

## The inbox

`~/mc/intake/` is an inbox. Anyone may drop a file in it — an error log, a
screenshot, a note — and the collect step adds one digest a day per repository.
Nothing stays in it: **one file, one turn, one outcome**, and the file is
archived under `~/mc/runner/log/intake/<date>/` the moment its turn ends. A new
round takes the next files, until the directory holds nothing.

The archive is unconditional, and that is what makes this an inbox rather than
a pile. A turn that failed, timed out, hit the quota or threw has still had its
turn; a file put back for the next round is a file every round after this one
takes again. An inbox that keeps what it could not judge never drains.

**The turn opens the file itself.** It is named in the prompt, never inlined in
it: the turn stands in `~/mc/intake/`, so a name is enough, and a screenshot has
no text to inline. That is the whole reason the inbox can hold anything.

### It is not `~/mc/proposals/`

The two rooms differ by who has done the judging. The inbox is raw material
nobody has read yet, and it costs a turn to work out what is in it.
`~/mc/proposals/` is the other end: a session already understood the thing and
wrote down what should happen about it. A session that has done the judging and
drops its finding in the inbox asks a second session to work it out again from
less than it had.

### What left it, and why it was never an inbox item

`mc run` writes three tables about its own rounds — `undocumented-closures.md`,
`unplanned-workareas.md` and `unreadable-plans.md`. They sat in `~/mc/intake/`
until 2026-09-05 and now live in `~/mc/runner/`, beside `held.json`,
`runner.json` and `log/`. `RUNNER_HOME` and the three filenames are in
`src/mc/paths.js`, with `runnerTablePath` for the runner that writes them and
`runnerTableLabel` for the brief that names them to a person, so the writer and
the label cannot drift.

Two of them are rewritten **whole every round**, which is the property that made
the old room wrong the moment the inbox was asked to drain: a turn that read one
and filed it away would find it back next round, and the round after, forever.
They are the runner's own output about its own rounds, read by exactly one
reader — `mc brief --collect`, which renders a section for each — and they
belong beside the rest of the runner's state. The three files were moved by
hand: a migration for three files that are rewritten every round is more code
than it saves.

`~/mc/intake/decisions-archive/` is skipped rather than drained. It is a
directory and an archive already; the drain lists files.

## The desk

`mc helper` with no flags opens a fresh foreground session — the terminal's,
never tmux, never `--resume` — standing in `~/mc/helper/`, wearing the
`helper` role (`canon/roles/helper.md`, Sonnet). Its shape is `mc brief`'s:
a room of its own under the work root, no repository, no workarea.

It stands in `~/mc/helper/` and **not** `~/mc/intake/`, which is the eye's
material and none of the desk's business. The role says so in the same
words: it does not read the digest, and it does not list, edit or delete a
proposal that is already waiting. Deciding one is `mc brief`'s job. Adding
is all the desk does.

It also does not fix anything — no code change, no branch, no PR, no deploy.
A report becomes a proposal and the work happens later, through `mc plan` and
`mc run`. What it *may* do is read: if Martin says the inbox is slow again,
going and looking at the code before writing is what makes the proposal worth
reading a week later. The repositories are elsewhere on the disk and open to
it; the one directory it writes to is `proposals/`.

Two things it nearly always has to ask, because they cannot be read out of
anything: which repository, and whether this is a new project or a step in
one that already exists. Both are frontmatter keys, and the frontmatter is
what `mc brief --collect` reads without a model.

Both directories — the room and `proposals/` — are made by the verb before
the session starts. A session told to write into a path that does not exist
has one avoidable way to fail.

## What the eye reads

memoro already records what matters — grouped worker errors in D1, the
server's own analysis pass, AI-provider refusals, the deploy log in
`deploy:index`. Before this verb, nothing read any of it unless a person
did, and nothing alerted: surveyed 2026-08-29, there was no uptime check, no
notifier and no Logpush. The eye does not add a monitoring system. It adds a
reader.

Six sources, and they do not share one failure domain. Each section of the
digest says what it could not read, and the run still succeeds: wrangler
being unauthenticated must not cost us the other five.

| section | how it is read | credential | timeout |
|---|---|---|---|
| error fingerprints | `scripts/admin/survey-errors.mjs --env production --limit <n> --since <iso>`, JSON on stdout | the script resolves `ADMIN_TOKEN` itself | 60 s |
| analysis items | `GET /admin/analysis` — the server's own LLM pass over errors and feedback | bearer `ADMIN_TOKEN` | 30 s |
| AI-provider errors | `scripts/admin/inspect-ai-provider-errors.mjs --env production --days 1` | **none** — it shells out to `wrangler d1 execute memoro-db --remote` | 180 s |
| deploys | `GET /admin/deploy/logs?limit=20` — the `deploy:index` KV key itself, beside the last `deployed` row of `~/mc/runner/log/deploys.tsv`, which `mc deploy` wrote | bearer `ADMIN_TOKEN` | 30 s |
| what is live | `GET /api/version` — `{ commit, build, build_time }`, kept in `~/mc/runner/version.json` for the page | none | 30 s |
| D1 health | `GET /ping-d1` | none | 30 s |

The deploy section has **two sources on purpose**. `/admin/deploy/logs` is the
GitHub webhook's, and it has been writing nothing for weeks; `deploys.tsv` is
written by `mc deploy` around the deploy itself and depends on no webhook at
all. The age is taken from whichever of them saw a deploy most recently — a
deploy Martin typed an hour ago is not stale because CI never heard of it — and
the digest says so plainly when the two are not describing the same deploy.
`mc deploy` runs `npm run deploy` on this machine and fires no Action, so that
is the ordinary case rather than a fault.

Three facts about that table are easy to get wrong and were measured, not
assumed:

- **`/admin/*` is the admin-token surface; `/api/admin/*` is session-admin.**
  Measured against production on 2026-08-29, `/api/admin/health`,
  `/api/admin/operations/status` and `/api/admin/analysis` all answer 401 to
  a bearer token — "Not logged in or session has expired." Only a browser
  session opens them.
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

### What it cannot reach, and says so

- **The nightly and morning task outcomes** are behind
  `/api/admin/operations/status`, and full service health behind
  `/api/admin/health` — both session-admin. The digest carries a standing
  "Not readable" section saying this in its own words rather than spending a
  request every day to rediscover the 401. Exposing them to the admin token
  is the helper's first candidate proposal.
- **Deploy age is in no route.** The nightly `checkDeployAge` computes
  `{ lastDeploy, ageHours, stale, consecutiveFailures }` and keeps them:
  `buildAdminOperationsStatus` passes every task result through
  `normalizeCountObject`, whose `SAFE_COUNT_KEYS` contains none of the four.
  So the digest computes the same verdict itself from the deploy index, with
  `checkDeployAge`'s own 36-hour threshold, so the two agree.
- **An empty deploy index is a silent webhook, not a healthy deploy.** That
  is what production showed on 2026-08-29, and it is reported as
  `deploy-webhook-silent` — the nightly task had been returning
  `stale: true` to no reader the whole time.
- **KV health is not read.** `/ping-kv` writes a probe key and deletes it
  again. That is a write, and the Contract keeps the helper out of it.

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
    failing deploy-webhook-silent
    -->

Two lists: the fingerprints this digest saw with their counts, and the named
operational conditions that were failing when it was written
(`deploy-webhook-silent`, `deploy-stale`, `deploy-failures`,
`d1-unreachable`, `d1-unhealthy`). The next run diffs against them.

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

memoro's production is the deployed service — five remote sources, an admin
token, wrangler. memoro-cli has no server, and for a week that was read as
"nothing to collect", so every failure in mc itself was found by a person
noticing it. On 2026-08-30 sixteen gate rounds stopped on a held lease in one
day, and that was a feeling rather than a number.

memoro-cli has a production. It is this machine, and mc records what happens
there in four files: `logs/mc.log` (every invocation and how it ended),
`gate-rounds.jsonl` (every round, including the ones that started and never
finished), `repo-leases/leases.log` (claims, releases, reaps) and
`runner/log/runs.tsv` (every step). The eye now reads both.

The second half reads no network and holds no credential, which is why it can
run every day without asking anybody for a token — and why a memoro collect
that fails on an expired wrangler login does not cost memoro-cli its digest.

It is the **same** delta, state block and threshold, deliberately: a second
implementation of "new since yesterday" would be a second answer waiting to
disagree with the first. A fingerprint on this side is a failure *signature*
with its variables removed — pull request numbers, pids and commits become
`N` and `<hash>` — so two rounds that both stopped on `lease` are one
fingerprint seen twice. Without that the digest could never say "sixteen".

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
- **Health** — D1's verdict and the calls it timed.
- **Deploy** — last success, age, consecutive failures, or the silent index;
  and `origin/main` locally.
- **Not readable** — the standing 401s, in prose.
- the state block.

## The turn

One headless session with the `intake` role (`canon/roles/intake.md`,
Sonnet), standing in `~/mc/intake/`, timeout 10 minutes, given **one file by
name** and asked for one outcome.

The role is `intake` and not `helper` because `helper` is the desk, and the
two want opposite things: the desk asks Martin, and the turn is told there is
nobody to ask. One file trying to be both is how a role stops being either.

**The file is named; the ground is given.** The prompt carries the filename and
then what the turn judges it against — every plan on `origin/main` in whichever
of the two checkouts is present, with its `status` and `next:`, the project log,
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

**What it wrote is measured, not believed.** `runHelperTurn` lists
`proposals/` before and after and reports the difference. A turn that says it
filed three and filed none is reported as having filed none.

Its output is zero or more `~/mc/proposals/<date>-<slug>.md`:

    ---
    name: <slug>
    repo: memoro | memoro-cli
    kind: project | step
    project: <existing project — only when kind is step>
    ---

    # <one line: what is wrong, or what is missing>

    ## Evidence      — what the file said, quoted
    ## Proposal      — a new project whose step 1 investigates, or one step
    ## Done when     — one line

That is the shape the desk writes and the shape to aim at, but it is not fixed
and nothing enforces it: **mc does not read a proposal.** `listProposals`
returns filenames and never opens one, so a turn that wrote `system:` and
`source:` instead of `repo:` — which one did, on 2026-09-05, for a note whose
name said no repository — costs a reader a second and nothing else. The roles
say the inside of a proposal is prose and not a form.

The role's judgement rules are in the role file, and
three of them matter enough to repeat: what was already there yesterday has
already been seen; a proposal that duplicates a live plan is noise; **zero
proposals is a good answer** — a quiet day should cost Martin nothing to
read.

The role forbids, in the same words: `queue.md`, any plan, any decision
file, anything outside `~/mc/proposals/`, production, a deploy, a
credential, a PR, a session, and a question — there is nobody to answer one.

## When the two halves run

Two gates, because they answer two different questions. `mc run` runs both at
the top of a round, before any step, and calls `collectHelper` and `drainIntake`
directly rather than the verb. Neither is a step: no worktree, no branch, no PR.

**The collect is a day.** It runs once per calendar day, at the top of
the first round after 05:00Z, and writes one digest per repository. `helperDue`
(`run-plan.js`) reads `~/mc/runner/log/runs.tsv` and nothing else — there is no
stamp file beside it to fall out of step with — and looks for a row
whose `kind` is `helper` and whose date is today. The row goes in whether the
collect worked or not, which is the whole of "a failed collect is logged, never
retried within the day": a `collect-failed` row closes the day exactly as a
successful one does.
There is no model in this half — it writes two files and two rows.

**The drain is a question about a directory.** `runIntakeDrain` asks only *is
there a file in the inbox?*, so a round can drain without collecting, and
collect and drain in the same round. It takes the oldest `INTAKE_PER_ROUND` = 3
files — oldest by the date **in the name** (`intakeQueue`), not by the name
itself, because `errors-memoro-2026-09-04.md` sorts before
`errors-memoro-cli-2026-08-31.md` as a string, and a name with no date in it
sorts last, which is arrival order too.

Three is what a round can afford: a turn is capped at ten minutes and measured
at 39–193 s on files Martin dropped in and 115–691 s on a digest, so a round's
drain is bounded at half an hour and usually far under it, beside a lane's
ninety-minute step. One a round would take thirteen rounds to clear a backlog of
thirteen; the whole inbox in one round has no bound at all and would stop the
runner for a morning after Martin drops forty screenshots in.

Sharing one gate is what filled the directory in the first place: a round could
read one file a day, and only if it had also collected.

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
columns a step uses, so the page can price the day honestly. `run.js`'s header
used to say the runner never calls a model; it does now, up to three times a
round.

**`mc run --once` runs neither.** That flag exists to watch one step, and
production reads plus model turns are not what somebody typing it asked for. The
real runner never passes `--once`, so this costs nothing.

A `~/mc/runner/STOP` file stops both. The drain checks it between files, never
inside one, and a turn that hit the quota pauses the runner the way a step's
does.

`mc helper --intake` at a terminal goes through the same `drainIntake`, the same
cap and the same archive — one drain, not two. The desk has no schedule at all:
it runs when Martin has something to say.

## Who acts on it

Nobody automatic. That is the point.

- **`mc brief --collect`** lists every waiting proposal under a **Proposals**
  section — file, what it proposes (project or step, repo, project), title
  and the one-line "done when". At the brief Martin queues one in
  `~/mc/queue.md` and deletes the file, or just deletes the file. It reads
  the desk's proposals and the eye's the same way, because they are the same
  file.
- **`mc plan <programme>`** is the other way in: open the programme the
  proposal belongs to, with the proposal in front of you. Nothing automatic
  carries one across — `mc plan` takes a programme, not a file, and a proposal
  is a candidate for a project rather than a project.
- **The page (`mc`)** has an INTAKE section: the newest digest and its age,
  what is new in it, how many proposals are waiting — and the `!` lines
  themselves, first, three named and the rest counted. A count is a number
  somebody has to go and look up; the line is the thing that makes them look.
  With no digest it says `no digest yet — mc helper --intake has not run`
  rather than printing a zero that would read as "production is quiet". The
  section reads the newest digest **in the inbox**, and the inbox now drains —
  see *What is not done*.

## The Contract

- The eye **reads** production. It never writes to it — no purge, no status
  change on an error, no deploy, not even `/ping-kv`'s probe key.
- The desk never reads the digest, and neither half lists, edits or deletes a
  proposal that is already waiting. Both only add.
- Neither writes `queue.md` or any plan. Proposals are the only output.
- The desk changes no code and opens no PR. A report becomes a proposal, and
  the work happens later, elsewhere.
- No resident session, no watcher, no pulse. The eye runs when the runner
  runs it and exits; the desk runs when Martin opens it and closes when he
  closes it.
- Alerting beyond the page — push, mail, macOS notification — is a separate
  decision, not part of this.

## Where the code is

| file | what |
|---|---|
| `src/mc/commands/helper.js` | the verb: the desk, and behind `--intake` the collect and the same drain the runner uses |
| `canon/roles/helper.md` | the desk: what it takes, what it writes, what it never touches |
| `src/mc/helper-collect.js` | the six sources, the delta, the state block, the rendered digest, `helperDir`, `intakeDir`, `intakeArchiveDir` |
| `src/mc/helper-turn.js` | the prompt over one named file, `repoOfFile`, the ground read from `origin/main`, the headless session, the measured `wrote` — and `drainIntake`, the loop that archives every file the moment its turn ends |
| `canon/roles/intake.md` | what the turn is, what it may write, how it judges |
| `src/mc/run-plan.js` | `helperDue` and `collectNote` for the day; `intakeQueue`, `intakeNote`, `INTAKE_KIND` and `INTAKE_PER_ROUND` for the drain |
| `src/mc/run.js` | `runHelperDay` — the daily collect — and `runIntakeDrain`, the inbox every round |
| `src/mc/paths.js` | `RUNNER_HOME` and the three tables that left the inbox: `runnerTablePath` for the writer, `runnerTableLabel` for the brief |
| `src/mc/brief-collect.js` | `listProposals` — the names, and nothing about what is in them — and the three sections read from `~/mc/runner/` |
| `src/mc/page-collect.js`, `page-render.js` | `newErrorLines`, `intakeSection`, the INTAKE block |

mc does not read a proposal. It used to parse a fixed frontmatter and fixed
section names out of every file, in three places that disagreed with each
other: a proposal whose first prose line was not marked `# ` was counted by the
page, missing from the brief, and recorded as "wrote nothing" by the very turn
that had just written it, with no error anywhere. The parse existed so a script
could say what kind of thing each file was; nothing needs that. `listProposals`
returns the markdown names, oldest first, and a session that has to know what
is in one opens it.

Tests: `tests/mc/helper-collect.test.js` (the digest on stubbed script output
and stubbed routes, the delta against a previous digest, the failure domains
kept separate), `tests/mc/helper-turn.test.js` (the prompt as a pure function over a named
file, `repoOfFile`, and the drain — including the file that is archived after a
turn that threw), `tests/mc/commands/helper.test.js` — where the desk's own
cases hold the thing worth holding down, that the bare verb reaches neither the
collect step nor the model, and where the verb's drain is handed its own `files`
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
of fourteen files hides it — the drain takes three a round, oldest first, so the
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
this is the one that puts proposals where `mc brief` can see them instead of
making a human in a terminal into the queue. The helper has to earn it first.
