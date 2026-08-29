---
status: ready
next: "Step 4 — close-out: `docs/technical/mc-helper.md` (the two halves, the daily gate in `mc run`, the intake directory, what the digest cannot reach and why) and a `project_log.md` entry. Done when a reader who has never seen the helper can say what it reads, when it runs, what it writes and who acts on it, without opening the source."
budget: 150k
needs: []
---

# mc helper — production errors and maintenance, watched by a script, read by one model turn

## Goal

Somebody keeps an eye on memoro.me all the time, and it is not Martin
staring at `admin.html`. memoro already records what matters — grouped
worker errors in D1 (`worker_errors`, written by the tail worker),
AI-provider errors, the server's own analysis pass behind
`/admin/analysis`, the deploy log in `deploy:index`, and the nightly and
morning tasks' outcomes in `operational_events` — but nothing reads it
unless a person does, and nothing alerts (survey 2026-08-29: no uptime
check, no notifier, no Logpush; `survey-errors.mjs` needs a hand-computed
`--since`). Some of it does not reach a script at all: measured against
production on 2026-08-29, the `/api/admin/*` observability routes answer
401 to an admin token and only a browser session opens them.

`mc helper` is the investigation's §12.3, as decided there: **a script
first** — a daily digest into `~/mc/intake/errors-<date>.md` from the
existing admin scripts and routes, with the delta against the previous
digest (new fingerprints, new failures of a nightly task, a deploy older
than main by more than a day); **one model turn second** — `claude -p`
(Sonnet by default) reads the digest, `docs/project/project_log.md` and the
PLAN.md frontmatters and writes **proposals** to `~/mc/intake/proposals/`:
a new project with step 1 = investigate, or a step for an existing one.
The helper never writes `queue.md` — Martin, in `mc brief`, moves a
proposal into the queue or drops it. No resident, no pulse, no rotation:
the runner runs `mc helper` once a day as a step of its own kind, logged
in runs.tsv like everything else, and `mc status` shows the last digest,
the new-error count and the proposals waiting.

## Success criteria

- [x] `mc helper --collect [--since <iso>] [--limit <n>] [--threshold <n>]`
      writes `~/mc/intake/errors-<date>.md`, each section saying what it
      could not read. No model, no write to production. The sources and
      their auth differ, and the surface matters more than the plan first
      assumed — `/admin/*` is the admin-token surface, `/api/admin/*` is
      session-admin:
      - error fingerprints — `scripts/admin/survey-errors.mjs --env
        production --limit <n> --since <iso>`, which resolves the admin
        token itself through `scripts/_lib/admin-token.mjs` and prints
        JSON on stdout;
      - analysis items — `GET /admin/analysis` with the bearer token, the
        server's own LLM pass over errors and feedback (decision mc-2);
        the helper never triggers the `POST` that runs it;
      - AI-provider errors — `inspect-ai-provider-errors.mjs --env
        production --days 1`, which does **not** use the admin token but
        shells out to `wrangler d1 execute memoro-db --remote`, so it
        fails differently and may fail alone;
      - deploys — `GET /admin/deploy/logs?limit=20`, the same
        `deploy:index` KV key the nightly `checkDeployAge` reads;
      - D1 health — `GET /ping-d1`, which needs no credential.
- [x] The delta is computed by the collect step against the previous
      digest's fingerprint set, not by `--since` alone: `--since` is passed
      through to `/api/admin/errors` and filters rows, but neither the
      script nor the route reports what is new relative to a prior run.
      The digest carries its own `<!-- mc-helper:state v1 -->` block for
      exactly this, and a second run on the same day measures against
      yesterday rather than against itself.
- [x] The deploy section reports what is actually reachable, and it is more
      than the plan expected: `/admin/deploy/logs` returns the deploy index
      itself, so the digest computes last success, age and consecutive
      failures the same way `checkDeployAge` does (36 h), next to the local
      `origin/main`. An **empty** index is reported as a silent webhook,
      not as a healthy deploy — which is what production shows today.
- [x] The digest names what it cannot reach and why, rather than carrying a
      section that is always empty: the nightly and morning task outcomes
      are behind `/api/admin/operations/status`, and full service health
      behind `/api/admin/health`, both session-admin. Exposing them to the
      admin token is the helper's first candidate proposal.
- [x] `mc helper` = collect, then one headless turn with the `helper`
      role from `canon/roles/helper.md` (model from the role, Sonnet)
      that writes zero or more `~/mc/intake/proposals/<date>-<slug>.md`,
      each with: the evidence (fingerprint, count, first/last seen), the
      proposed project or step, and a one-line "done when". It edits no
      file outside `~/mc/intake/`: the turn stands in `~/mc/intake/` and is
      *given* the digest, the plans on main and the project log in its
      prompt rather than sent to find them, so the repositories are not in
      its reach at all.
- [x] `mc run` runs `mc helper` once per calendar day (first round after
      05:00Z), as kind `helper` in the existing `kind` column of runs.tsv
      and `helper` in the name column; a failed collect is logged, never
      retried within the day. The row *is* the gate — there is no stamp file
      beside it to fall out of step with — and it is written whether the run
      worked or not, which is the whole of "never retried within the day".
      `mc run --once` does not run it: that flag exists to watch one step,
      and a model turn over production is not what it asked for.
- [x] `mc brief --collect` lists the proposals under a "Proposals" section
      — file, what it proposes (project or step, repo, project), title and
      the one-line "done when" — so the brief session can move them. It
      landed with step 2 rather than step 3: "a proposal Martin can read in
      `mc brief`" is step 2's own success criterion.
- [x] `mc status` gets a HELPER block: last digest time, new fingerprints
      in it, proposals waiting — and the `!` lines themselves, first, right
      under the heading. It is the page's INTAKE section: `mc status` became
      bare `mc` while this plan was being run (decision mc-3, mc-ui step 4),
      and INTAKE was already the helper's block on it. See "What the code
      taught us".
- [x] A digest line with a new fingerprint above a threshold (default 20
      hits in 24 h) is marked `!`. The page prints those lines whole, first
      in the section, three of them and then a count.
- [x] Tests: the digest on stubbed script output and stubbed routes; the
      delta against a previous digest; the failure domains kept separate —
      no network, no model. Proposals parsing landed with step 2; the daily
      gate (`helperDue`, `helperNote`, and the round driven end to end on
      fakes) and the page's `!` lines landed with step 3.

## Contract

- The helper reads production; it never writes to it. No purge, no
  status change on an error, no deploy.
- The helper never writes `queue.md` or any PLAN.md. Proposals are its
  only output.
- No resident session, no watcher. It runs when the runner runs it and
  exits.
- Alerting beyond `mc status` (push, mail, macOS notification) is a
  separate decision, not a step here.

## Steps

- [x] **0. Decision** — `~/mc/mc-utredning/decisions/mc-2.md`, answered
      2026-08-29: **A**, this shape. Set up `mc helper` with intake as
      planned. The ruling adds a source and settles `/improve`: the machine
      behind `/improve` is good and is reused, its surface is not. Collect
      reads the analysis directly and puts the items in the digest beside
      the raw fingerprints; the LLM pass itself (`POST`) runs on the
      server's own cadence, never once a day from the helper. The
      `/improve` command and the `docs/TODO.md` sentinels are not used —
      they make a human in a terminal into the queue, cost a repo commit
      per sync, and put proposals where `mc brief` cannot see them.
      `scripts/sync-todo.mjs` is retired in a later step, once the helper
      has run for a week (utredningen §9: two systems doing the same thing,
      one should go). That retirement is **step 5** below.
- [x] **1. The digest** — `mc helper --collect`. Done: one digest written
      from production 2026-08-29 (50 fingerprints, 2.5 s) and a second run
      against it named only the new ones.
- [x] **2. The proposal turn** — `canon/roles/helper.md`, `mc helper`.
      Done: run for real on 2026-08-29 against the day's digest (50
      fingerprints), one headless Sonnet turn, 109 s, three proposals —
      the two the plan predicted (`/api/admin/*` unreachable to a token;
      the silent deploy webhook) and one it found on its own (a
      `touchSession` KV rate-limit burst next to the slow-auth
      fingerprints). All three then read back out of
      `mc brief --collect`'s Proposals section.
- [x] **3. Runner and status** — daily kind `helper` in `mc run`; the
      HELPER block. Done: the real `createRunner` on real files, its clock
      moved through seven rounds across 2026-08-29 and 08-30 and only the
      two halves of `mc helper` stood in for, wrote exactly two rows —
      `2026-08-29T05:10:00Z helper helper 0 … success,1-proposals` and the
      same the next morning — with the 04:30 round silent and the 09:00 and
      22:00 rounds silent. The page's INTAKE section printed a real digest's
      four `!` lines, three named and one counted.
- [ ] **4. Close-out** — `docs/technical/mc-helper.md`, `project_log.md`.
- [ ] **5. Retire `sync-todo.mjs`** — in `~/memoro`, a week after the
      helper has been running (decision mc-2). Done when `/improve`,
      `scripts/sync-todo.mjs` and the `docs/TODO.md` production sentinels
      are gone and the analysis reaches Martin only through the digest.
      Not before: the helper has to have earned it first.

## What the code taught us

Surveyed 2026-08-29 against `~/memoro` and this repo, read-only, no
production calls made.

- **The four sources do not share one auth path.** `survey-errors.mjs`
  and the two routes are HTTP + `ADMIN_TOKEN` (resolved from
  `.dev.vars` by `scripts/_lib/admin-token.mjs`, which already walks up
  from a worktree to the main checkout, so collect works from anywhere).
  `inspect-ai-provider-errors.mjs` is different: it `spawnSync`s
  `wrangler d1 execute memoro-db --remote --json`. The digest must treat
  it as its own failure domain — wrangler being unauthenticated must not
  cost us the other three sections.
- **`--env` defaults to `local` on both scripts.** Collect must pass
  `--env production` explicitly or it will silently digest an empty local
  database. `survey-errors.mjs` also honours `MEMORO_BASE_URL`; the
  production default in the script is `https://meetmemoro.app`.
- **Deploy age is not reachable from any admin route.** `checkDeployAge`
  (`src/automation/tasks/deploy-monitor.js`) reads the `deploy:index` KV
  key and returns `{ lastDeploy, ageHours, stale, consecutiveFailures }`,
  but it runs as a nightly task, and `buildAdminOperationsStatus` passes
  every task result through `normalizeCountObject`, which keeps only keys
  in `SAFE_COUNT_KEYS` — a list that contains none of those four. So
  `/api/admin/operations/status` exposes the task's status and an empty
  `counts`. No route reads `deploy:index`. The plan's "deploy age vs
  main" therefore cannot be built from the routes as written; success
  criteria revised accordingly, within the Contract.
- **There is no delta anywhere.** `/api/admin/errors` takes `since` and a
  `limit` capped at 200, and `summariseErrors` returns the top N by
  `last_seen` plus per-status group counts. Nothing records what a
  previous run saw. The previous digest file is the only possible
  baseline, which makes the digest's own format the state — worth keeping
  machine-readable for that reason alone.
- **`runs.tsv` already has a `kind` column** (`ts name kind exit seconds
  pr turns input output cache_read cache_write session note`; values so
  far `triage` and `step`). `helper` is a new value, not a schema change.
- **`mc run` does not exist yet** — PR #421 is open, and the live runner
  is `~/mc/bin/runner.sh`. Step 3 is gated on it; recorded as
  `needs: [mc-run]`.
- **`~/mc/intake/` does not exist.** Collect creates it and
  `~/mc/intake/proposals/` on first run rather than assuming them.
- **The helper's own help text broke every subprocess test.** Step 1 wrote
  ``one `!` `` into `HELP_TEXT`, which is a template literal: the two
  backticks closed and reopened it, and `src/mc/help-text.js` stopped
  parsing. `mc --help` — and with it 115 of the suite's tests, every one
  that spawns the CLI — had been failing since. Escaped, and the count is
  back to the two that fail on this machine for their own reasons.
- **Proposal parsing lives in `brief-collect.js`, not with the turn.** It
  needs `planFields`, and `helper-turn.js` already imports that module for
  the plans on main; putting `scanProposals` the other way round would have
  made the two files import each other. The brief is also where it belongs
  by meaning: that file already scans `decisions/`, and both are lists of
  things waiting for Martin.
- **The turn is given its material, not sent to find it.** Everything it
  judges — the digest, every PLAN.md frontmatter on origin/main, the project
  log, the proposals already waiting — is in the prompt (22 kB against the
  real digest), and its cwd is `~/mc/intake`. A turn that cannot reach the
  repositories cannot write in them either, which is cheaper than trusting
  it not to.
- **What it wrote is measured, not believed.** `runHelperTurn` lists
  `proposals/` before and after and reports the difference, so a turn that
  says it filed three and filed none is reported as having filed none.
- **`mc status` is the page now, and the HELPER block was already on it.**
  Between step 2 and step 3, mc-ui step 4 (decision mc-3) made bare `mc` the
  one page and left `mc status <name>` as one project; the board `mc status`
  used to print is gone, and so is `renderStatus`. The page already had an
  INTAKE section reading the newest `errors-<date>.md` and counting the
  proposals — the plan's "last digest time, new fingerprints, proposals
  waiting" was built there by somebody else. What was missing was the last
  clause: the `!` lines *themselves*, first. So step 3 did not add a block; it
  finished the one that exists. `intakeSection` now carries `loud_lines` and
  `more_loud`, and `newErrorLines` parses the bullets the digest writes rather
  than only counting them.
- **The runs.tsv row is the whole gate.** `helperDue` reads runs.tsv and
  nothing else — no stamp file, no separate state — and the row goes in
  whether the run worked or failed. That is what makes "a failed collect is
  logged and never retried within the day" one rule instead of two: a
  `collect-failed` row closes the day exactly as a successful one does.
- **The note has to start with `success`.** `summariseRuns` in
  brief-collect.js counts any row whose note does not start with `success` as
  a failure, and the page's day line prints that count. A quiet helper day is
  not a failure, so the note is `success,0-proposals` — the same
  `success,<something>` shape `success,merged` and `success,open` already use.
- **The runner does call a model once a day now.** run.js's own header said it
  never does. The helper turn is not a step — no worktree, no branch, no PR —
  but it is a model call the runner is the parent of, and its tokens go in the
  same runs.tsv columns so the page can price the day honestly. `runHelperTurn`
  now returns `input`/`output`/`cacheRead`/`cacheWrite` for that reason alone.
- **`mc run --once` does not run the helper.** `--once` exists to watch a
  single step. Two minutes of production reads and a model turn is not what
  somebody typing it asked for, and skipping it costs the real runner nothing
  — it never passes `--once`.
- **The one-line wordings moved out of the command.** `describe`, `turnLine`
  and `unreadable` lived in `commands/helper.js`, and the runner needs the
  same sentences in `runner.log`. They are `describeDigest` and
  `unreadableSections` in helper-collect.js and `describeTurn` in
  helper-turn.js now; the command imports them. A runner log and a terminal
  cannot describe the same digest differently any more.
- **mc-1 is spent.** Its ruling (pm/pm-helper dormant, `mc watch`
  removed, `worker` kept) landed in #422 and #423 and touches nothing
  here. The reserved role name `helper` it mentions is free for
  `canon/roles/helper.md`.

## Documents

- `~/mc/mc-utredning/utredning-2026-08-24.md` §12.3 — the design
- `~/memoro/docs/technical/operations-observability.md`, `logging.md` — what is recorded, and where
- `~/memoro/scripts/admin/survey-errors.mjs`, `inspect-ai-provider-errors.mjs`, `scripts/help.mjs`
- `~/memoro/src/routes/admin/health.js`, `operations.js`, `errors.js`; `src/operations/admin-status.js`; `src/automation/tasks/deploy-monitor.js`
- `docs/project/mc/mc-run/PLAN.md` — the runner that runs it; `mc-dormant` — why there is no pm-helper
