# mc helper — the eye on production

Somebody keeps an eye on memoro.me all the time, and it is not Martin
staring at `admin.html`. `mc helper` is that somebody: **a script that
reads, and one model turn that thinks about what it read.**

memoro already records what matters — grouped worker errors in D1, the
server's own analysis pass, AI-provider refusals, the deploy log in
`deploy:index`. Before this verb, nothing read any of it unless a person
did, and nothing alerted: surveyed 2026-08-29, there was no uptime check,
no notifier and no Logpush. The helper does not add a monitoring system. It
adds a reader.

Two halves, one verb, and the split is the whole design:

| | what it does |
|---|---|
| `mc helper --collect` | the script half: read five sources, write `~/mc/intake/errors-<date>.md` with the delta against the previous digest. **No model, no writes to production.** |
| `mc helper` | that, then the model half: one headless turn that reads the digest and writes zero or more `~/mc/intake/proposals/<date>-<slug>.md` |
| `--since <iso>` | the window; default is the last 24 h |
| `--limit <n>` | fingerprints asked for; default 50, the route caps at 200 |
| `--threshold <n>` | hits at or above which a *new* fingerprint is marked `!`; default 20 |
| `--model <model>` | override the role's model for the turn |

Nothing here writes `~/mc/queue.md`. A proposal is read at the next brief
and Martin queues it or drops it — that is the arrangement that lets the
model half run unattended every day.

## What it reads

Five sources, and they do not share one failure domain. Each section of the
digest says what it could not read, and the run still succeeds: wrangler
being unauthenticated must not cost us the other four.

| section | how it is read | credential | timeout |
|---|---|---|---|
| error fingerprints | `scripts/admin/survey-errors.mjs --env production --limit <n> --since <iso>`, JSON on stdout | the script resolves `ADMIN_TOKEN` itself | 60 s |
| analysis items | `GET /admin/analysis` — the server's own LLM pass over errors and feedback | bearer `ADMIN_TOKEN` | 30 s |
| AI-provider errors | `scripts/admin/inspect-ai-provider-errors.mjs --env production --days 1` | **none** — it shells out to `wrangler d1 execute memoro-db --remote` | 180 s |
| deploys | `GET /admin/deploy/logs?limit=20` — the `deploy:index` KV key itself | bearer `ADMIN_TOKEN` | 30 s |
| D1 health | `GET /ping-d1` | none | 30 s |

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

## The digest

`~/mc/intake/errors-<date>.md`, in this order:

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

One headless session with the `helper` role (`canon/roles/helper.md`,
Sonnet), standing in `~/mc/intake/`, timeout 10 minutes — four times the
longest measured run.

**It is given its material, not sent to find it.** The prompt carries the
digest whole, every PLAN.md frontmatter on `origin/main` in whichever of the
two checkouts is present, with its `status` and `next:`, the project log, and the proposals already
waiting — 22 kB against a real 50-fingerprint digest. Its cwd is the intake
directory and the repositories are elsewhere on the disk: a turn that cannot
reach them cannot accidentally write in them either, which is cheaper than
trusting it not to.

**What it wrote is measured, not believed.** `runHelperTurn` lists
`proposals/` before and after and reports the difference. A turn that says it
filed three and filed none is reported as having filed none.

Its output is zero or more `~/mc/intake/proposals/<date>-<slug>.md`:

    ---
    name: <slug>
    repo: memoro | memoro-cli
    kind: project | step
    project: <existing project — only when kind is step>
    ---

    # <one line: what is wrong, or what is missing>

    ## Evidence      — the digest's own numbers, quoted
    ## Proposal      — a new project whose step 1 investigates, or one step
    ## Done when     — one line

The frontmatter is fixed because `mc brief --collect` has to say what kind of
thing each one is *without a model*. The role's judgement rules are in the
role file, and three of them matter enough to repeat: what was already there
yesterday has already been seen; a proposal that duplicates a live plan is
noise; **zero proposals is a good answer** — a quiet day should cost Martin
nothing to read.

The role forbids, in the same words: `queue.md`, any PLAN.md, any decision
file, anything outside `~/mc/intake/proposals/`, production, a deploy, a
credential, a PR, a session, and a question — there is nobody to answer one.

## When it runs

`mc run` runs it **once per calendar day, at the top of the first round
after 05:00Z**, before any step. It is not a step: it opens no worktree,
touches no branch and produces no PR.

**The runs.tsv row is the whole gate.** `helperDue` reads
`~/mc/runner/log/runs.tsv` and nothing else — there is no stamp file beside
it to fall out of step with — and looks for a row whose `kind` is `helper`
and whose date is today. The row goes in whether the run worked or not, which
is the whole of "a failed collect is logged, never retried within the day":
a `collect-failed` row closes the day exactly as a successful one does.

The row carries `helper` in both the name and the kind column, and the turn's
tokens in the same `input`/`output`/`cache_read`/`cache_write` columns a step
uses, so the page can price the day honestly. `run.js`'s header used to say
the runner never calls a model; it does now, once a day.

The note starts with `success` on a good day — `success,0-proposals`,
`success,3-proposals` — because `summariseRuns` counts any note that does not
start with `success` as a failure, and a quiet helper day is not a failure.
A bad day's note is `collect-failed`, or the turn's own reason (`no-tool`,
`no-role`, `timeout`).

**`mc run --once` does not run it.** That flag exists to watch one step, and
two minutes of production reads plus a model turn is not what somebody typing
it asked for. The real runner never passes `--once`, so this costs nothing.

A `~/mc/runner/STOP` file stops the helper as well as the steps.

## Who acts on it

Nobody automatic. That is the point.

- **`mc brief --collect`** lists every waiting proposal under a **Proposals**
  section — file, what it proposes (project or step, repo, project), title
  and the one-line "done when". At the brief Martin queues one in
  `~/mc/queue.md` and deletes the file, or just deletes the file.
- **The page (`mc`)** has an INTAKE section: the newest digest and its age,
  what is new in it, how many proposals are waiting — and the `!` lines
  themselves, first, three named and the rest counted. A count is a number
  somebody has to go and look up; the line is the thing that makes them look.
  With no digest it says `no digest yet — mc helper has not run` rather than
  printing a zero that would read as "production is quiet".

## The Contract

- The helper **reads** production. It never writes to it — no purge, no
  status change on an error, no deploy, not even `/ping-kv`'s probe key.
- It never writes `queue.md` or any PLAN.md. Proposals are its only output.
- No resident session, no watcher, no pulse. It runs when the runner runs it
  and exits.
- Alerting beyond the page — push, mail, macOS notification — is a separate
  decision, not part of this.

## Where the code is

| file | what |
|---|---|
| `src/mc/commands/helper.js` | the verb: flags, then collect, then the turn |
| `src/mc/helper-collect.js` | the five sources, the delta, the state block, the rendered digest |
| `src/mc/helper-turn.js` | the prompt, the ground read from `origin/main`, the headless session, the measured `wrote` |
| `canon/roles/helper.md` | what the turn is, what it may write, how it judges |
| `src/mc/run-plan.js` | `helperDue`, `helperNote`, `HELPER_KIND`/`HELPER_NAME` |
| `src/mc/run.js` | `runHelperDay` — the daily gate inside the round |
| `src/mc/brief-collect.js` | `parseProposal`, `scanProposals`, the brief's Proposals section |
| `src/mc/page-collect.js`, `page-render.js` | `newErrorLines`, `intakeSection`, the INTAKE block |

Proposal parsing lives in `brief-collect.js` rather than beside the turn
because it needs `planFields`, and `helper-turn.js` already imports that
module — the other arrangement would have made the two files import each
other. It also belongs there by meaning: that file already scans
`decisions/`, and both are lists of things waiting for Martin.

Tests: `tests/mc/helper-collect.test.js` (the digest on stubbed script output
and stubbed routes, the delta against a previous digest, the failure domains
kept separate), `tests/mc/helper-turn.test.js`, `tests/mc/commands/helper.test.js`,
the helper block of `tests/mc/run.test.js` (the daily gate driven end to end
on fakes) and the INTAKE cases in `tests/mc/page.test.js`. No network and no
model in any of them.

## What is not done

`scripts/sync-todo.mjs`, the `/improve` command and the `docs/TODO.md`
production sentinels in `~/memoro` still exist. Decision `mc-2` retires them
once the helper has run for a week: two systems doing the same thing, and
this is the one that puts proposals where `mc brief` can see them instead of
making a human in a terminal into the queue. The helper has to earn it first.
