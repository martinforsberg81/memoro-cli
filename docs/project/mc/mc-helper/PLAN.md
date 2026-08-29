---
status: waiting-decision
next: "Waiting on `~/mc/mc-utredning/decisions/mc-2.md` (which shape the helper takes) — it carries no `**Beslut:**` line yet, and the file itself says the runner leaves this plan alone until it does. mc-1 is answered but concerns `mc-dormant`/`mc-brief` and is already applied (#422, #423); it does not unblock this plan. Then Step 1 — `mc helper --collect`: the error and maintenance digest from what memoro already records, no model — done when `~/mc/intake/errors-<date>.md` is written from production and names the new fingerprints since the previous digest."
budget: 150k
needs: [mc-run]
---

# mc helper — production errors and maintenance, watched by a script, read by one model turn

## Goal

Somebody keeps an eye on memoro.me all the time, and it is not Martin
staring at `admin.html`. memoro already records what matters — grouped
worker errors in D1 (`worker_errors`, written by the tail worker),
AI-provider errors, the nightly and morning tasks' outcomes in
`operational_events`, deploy age, and D1/R2/KV health behind
`/api/admin/health` and `/api/admin/operations/status` — but nothing reads
it unless a person does, and nothing alerts (survey 2026-08-29: no uptime
check, no notifier, no Logpush; `survey-errors.mjs` needs a hand-computed
`--since`).

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

- [ ] `mc helper --collect [--since <iso>]` runs from `~/memoro` and writes
      `~/mc/intake/errors-<date>.md` with four sections, each saying what
      it could not read. No model. The sources and their auth differ:
      - error fingerprints — `scripts/admin/survey-errors.mjs --env
        production --limit <n>`, which resolves `ADMIN_TOKEN` itself
        through `scripts/_lib/admin-token.mjs` and prints JSON on stdout;
      - AI-provider errors — `inspect-ai-provider-errors.mjs --env
        production --days 1`, which does **not** use the admin token but
        shells out to `wrangler d1 execute memoro-db --remote`, so it
        fails differently and may fail alone;
      - health — `GET /api/admin/health` with the same bearer token;
      - operations status — `GET /api/admin/operations/status`: nightly and
        morning task outcomes and staleness.
- [ ] The delta is computed by the collect step against the previous
      digest's fingerprint set, not by `--since` alone: `--since` is passed
      through to `/api/admin/errors` and filters rows, but neither the
      script nor the route reports what is new relative to a prior run.
- [ ] The deploy section reports what is actually reachable: the nightly
      `checkDeployAge` task's pass/fail from operations status, plus the
      local date of `origin/main` in `~/memoro`. The deployed commit and
      its age are **not** exposed by any admin route (see What the code
      taught us) — the section says so in one line rather than guessing,
      and "expose deploy age" is a candidate for the helper's first
      proposal.
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
- [ ] A digest line with a new fingerprint above a threshold (default 20
      hits in 24 h) is marked `!` and `mc status` prints it first.
- [ ] Tests: the digest on stubbed script output and stubbed routes; the
      delta against a previous digest; proposals parsing; the daily gate
      in the runner; the status block — no network, no model.

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

- [ ] **0. Decision** — `~/mc/mc-utredning/decisions/mc-2.md`: this shape,
      or the admin UI alone, or an external uptime/alert service first.
      Still open — no `**Beslut:**` line as of 2026-08-29.
- [ ] **1. The digest** — `mc helper --collect`. Done when one digest is
      written from production and a second run names only what is new.
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
