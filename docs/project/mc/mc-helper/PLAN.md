---
status: ready
next: "Step 2 — the proposal turn: `canon/roles/helper.md` and bare `mc helper`, one headless Sonnet turn that reads the digest, `docs/project/project_log.md` and the PLAN.md frontmatters and writes zero or more `~/mc/intake/proposals/<date>-<slug>.md`. Done when a real digest yields a proposal Martin can read in `mc brief`. The first one is already named by the digest: `/api/admin/operations/status` and `/api/admin/health` are session-admin only, so the nightly and morning outcomes reach no script; second is the deploy webhook, which writes nothing into `deploy:index`."
budget: 150k
needs: [mc-run]
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
- [ ] `mc helper` = collect, then one headless turn with the `helper`
      role from `canon/roles/helper.md` (model from the role, Sonnet)
      that writes zero or more `~/mc/intake/proposals/<date>-<slug>.md`,
      each with: the evidence (fingerprint, count, first/last seen), the
      proposed project or step, and a one-line "done when". It edits no
      file outside `~/mc/intake/`.
- [ ] `mc run` runs `mc helper` once per calendar day (first round after
      05:00Z), as kind `helper` in the existing `kind` column of runs.tsv;
      a failed collect is logged, never retried within the day.
- [ ] `mc status` gets a HELPER block: last digest time, new fingerprints
      in it, proposals waiting; `mc brief --collect` lists the proposals
      under a "Proposals" section so the brief session can move them.
- [x] A digest line with a new fingerprint above a threshold (default 20
      hits in 24 h) is marked `!`. `mc status` printing it first is step 3.
- [x] Tests: the digest on stubbed script output and stubbed routes; the
      delta against a previous digest; the failure domains kept separate —
      no network, no model. Proposals parsing, the daily gate in the runner
      and the status block come with steps 2 and 3.

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
- [ ] **2. The proposal turn** — `canon/roles/helper.md`, `mc helper`.
      Done when a real digest yields a proposal Martin can read in
      `mc brief`. `canon/roles/` today holds `brief.md`, `plan.md` and
      `worker.md`; `helper.md` is new and follows their shape.
- [ ] **3. Runner and status** — daily kind `helper` in `mc run`; the
      HELPER block. Done when runs.tsv shows one `helper` row per day for
      two days. Blocked on mc-run step 1 (PR #421, open): today the runner
      is `~/mc/bin/runner.sh`, and the daily gate belongs in `mc run`, not
      in the shell script that is about to be deleted.
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
