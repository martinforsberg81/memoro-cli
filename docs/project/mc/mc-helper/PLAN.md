---
status: waiting-decision
next: "Waiting on `~/mc/mc-utredning/decisions/mc-2.md` (which shape the helper takes). Then Step 1 — `mc helper --collect`: the error and maintenance digest from what memoro already records, no model — done when `~/mc/intake/errors-<date>.md` is written from production and names the new fingerprints since the previous digest."
budget: 150k
needs: []
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

- [ ] `mc helper --collect [--since <iso>]` runs from `~/memoro` with the
      admin token `scripts/_lib/admin-token.mjs` provides and writes
      `~/mc/intake/errors-<date>.md`: new and top error fingerprints since
      the previous digest (`scripts/admin/survey-errors.mjs`), AI-provider
      errors (`inspect-ai-provider-errors.mjs --days 1`), health
      (`/api/admin/health`), operations status (nightly/morning task
      outcomes, staleness, deploy age vs main), each section saying what
      it could not read. No model.
- [ ] `mc helper` = collect, then one headless turn with the `helper`
      role from `canon/roles/helper.md` (model from the role, Sonnet)
      that writes zero or more `~/mc/intake/proposals/<date>-<slug>.md`,
      each with: the evidence (fingerprint, count, first/last seen), the
      proposed project or step, and a one-line "done when". It edits no
      file outside `~/mc/intake/`.
- [ ] `mc run` runs `mc helper` once per calendar day (first round after
      05:00Z), as kind `helper` in runs.tsv; a failed collect is logged,
      never retried within the day.
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
- [ ] **1. The digest** — `mc helper --collect`. Done when one digest is
      written from production and a second run names only what is new.
- [ ] **2. The proposal turn** — `canon/roles/helper.md`, `mc helper`.
      Done when a real digest yields a proposal Martin can read in
      `mc brief`.
- [ ] **3. Runner and status** — daily kind `helper` in `mc run`; the
      HELPER block. Done when runs.tsv shows one `helper` row per day for
      two days.
- [ ] **4. Close-out** — `docs/technical/mc-helper.md`, `project_log.md`.

## What the code taught us

- (empty)

## Documents

- `~/mc/mc-utredning/utredning-2026-08-24.md` §12.3 — the design
- `~/memoro/docs/technical/operations-observability.md`, `logging.md` — what is recorded, and where
- `~/memoro/scripts/admin/survey-errors.mjs`, `inspect-ai-provider-errors.mjs`, `scripts/help.mjs`
- `~/memoro/src/routes/admin/health.js`, `operations.js`, `errors.js`; `src/automation/tasks/deploy-monitor.js`
- `docs/project/mc/mc-run/PLAN.md` — the runner that runs it; `mc-dormant` — why there is no pm-helper
