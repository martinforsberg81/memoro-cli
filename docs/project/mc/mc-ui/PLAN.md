---
status: waiting-decision
next: "Waiting on `~/mc/mc-utredning/decisions/mc-3.md` (what bare `mc` is, and static or live) — it carries no `**Beslut:**` line yet, and the front door cannot be rebuilt before its shape is chosen. Then Step 1 — `mc run` writes `~/mc/runner/current.json` while a step is in flight and removes it when the step ends — done when `mc status --json` names the running project, its kind, tool, model, start time and budget within a second of a step starting, and carries nothing there within a second of it ending."
budget: 150k
needs: []
---

# mc ui — one polished page, and it is what `mc` prints

## Goal

Bare `mc` today prints the V1 sessions table — `mc sessions · 1 local · 0
cloud`, one row, a session nobody has opened since June. It is the front
door of the whole system and says nothing true about it. The page that does
say something true, `mc status`, is a second verb, misses the sections
Martin asked for, hardcodes its column widths, uses no colour, and takes
1.9 s offline. This project makes one page, makes it what `mc` prints, and
adds the three things it cannot say today: **what is running right now**,
**how deep the queue is and what is in it**, **how much waits in intake**.

## Success criteria

- [ ] Bare `mc` prints the page (per decision mc-3) in under 300 ms with no
      network — measured against today's 1.92 s for `mc status --offline`.
- [ ] Six sections, in this order: **NOW** (the running step with kind, tool,
      model, elapsed against budget; a pending STOP; live tmux `mc-<name>`
      areas; a foreground `mc brief`/`mc plan`), **QUEUE** (depth, runnable
      count, the next few by name and kind, skips counted by reason),
      **DECISIONS**, **INTAKE** (digest date, new errors, proposals waiting),
      **PROJECTS** (counts by status, then today's rows), **WORKAREAS
      WITHOUT A PROJECT**.
- [ ] A number where a number answers the question, a line only where the
      identity matters; each count names the verb that expands it.
- [ ] Width-aware and coloured: `stdout.columns` clamped 60–160 through
      `width`/`pad`/`clip` from `status-render.js`; colour only on a TTY and
      only when `NO_COLOR` is unset **or empty** (the convention is any
      non-empty value; `src/cli/list.js` tests `!== '1'`, which is wrong).
- [ ] `--json` is the same object the renderer takes, one key per section;
      `--fresh` does the `git fetch` and `gh pr list` that `mc status` does
      by default today; without it the page reads a cache and says its age.
      `--watch [seconds]` redraws until ctrl-c, leaving the terminal clean.
- [ ] No new dependency; the renderer is ANSI by hand, as the repo is.
      Tests build every section from fixtures (`current.json`, `runs.tsv`, a
      decisions tree, a `docs/project` tree, an intake dir) — no git, gh or
      tmux.

## Contract

- Reads only. No model, nothing started (D-0102) — with one exception, named:
  `mc run` writes `~/mc/runner/current.json`, because what is running now
  exists nowhere else.
- Step 1 edits `src/mc/run.js`, which `mc-run` owns. It adds a write and
  changes no rule; if `mc-run` is mid-step on that file, this step waits.
- The old sessions table is not restyled — it is V1 surface on its way out
  (`mc-dormant`); this only stops it being the first thing seen.
- The estimated cost stays labelled list-price, never what Martin pays.
- INTAKE is empty until `mc helper` writes it (decision mc-2, answered A);
  it says "no digest yet", never a zero that looks like health.

## Steps

- [ ] **0. Decision** — `~/mc/mc-utredning/decisions/mc-3.md`: bare `mc` is
      the page (static, `--watch` for live), a live dashboard by default, or
      a short summary with `mc status` kept whole. Open as of 2026-08-29.
- [ ] **1. What is running now** — `mc run` writes `~/mc/runner/current.json`
      (name, kind, tool, model, budget_minutes, started, pid, worktree) at
      step start through `atomic-write.js` and removes it at the end; the
      collector reads it, plus `~/mc/runner/STOP`, plus `quota` rows in the
      last 24 h. Done when `mc status --json` carries a `now` block within a
      second of a step starting and nothing there a second after it ends.
- [ ] **2. Instant** — plans read with one `git cat-file --batch` per
      repository behind a `~/mc/runner/plans.json` cache keyed by the
      `origin/main` sha; open PRs cached to `~/mc/runner/prs.json`; offline
      becomes the default, `--fresh` the opt-in. Done when the page prints
      in under 300 ms with no network, measured with `time`.
- [ ] **3. The page** — the six sections, the width and colour rules, the
      counts, `--json` parity. Done when all six print against the real
      files and the fixture tests pass.
- [ ] **4. The front door** — bare `mc` prints it (per mc-3); the sessions
      table answers only to `mc list`; `HELP_TEXT` leads with the page. Done
      when `mc` and `mc status` print the same page and nothing on the first
      screen of `mc --help` names a mechanism that no longer runs.
- [ ] **5. Live** — `--watch [seconds]`, and a foreground register so
      `mc brief`/`mc plan`/`mc worker` record verb, area, tool, model and
      start time. Done when a running `mc brief` appears in NOW and is gone
      from it after it exits.
- [ ] **6. Close-out** — `docs/technical/mc-ui.md`, `project_log.md`.

## What the code taught us

Measured here 2026-08-29 07:10–07:20Z; the numbers, and what is only
assumed, are in `investigation-2026-08-29.md`.

- **The runner's current step exists nowhere a program can read it.**
  `runs.tsv` gets its row only after the step ends (`run.js`), so the fact
  Martin asked for first is the one mc does not have. A step was in flight
  while `mc status` printed `next: docx-editor`.
- **`runnerAlive()` can lie both ways** — `tmux has-session -t runner` is
  true for a pane whose process died, and the `pgrep -f 'runner.sh|mc run'`
  fallback matched a `claude -p` step session whose prompt contained the
  words "mc run" — and **a pending STOP is invisible**: `~/mc/runner/STOP`
  was placed at 07:14Z and the page still read "running".
- **The offline page is 1.92 s and 1.45 s of it is one loop**: `listPlans`
  spends a `git show` per plan (37 in memoro alone).
- **The old board is no model for this.** `mc status --sessions` takes
  7.26 s and `listConversations` alone 0.70 s over 1 417 transcripts. The
  cheap half — `tmux ls` (5 ms) and one `lsof`+`ps` (66 ms, 32 processes) —
  is all NOW needs.
- **Two answers to one question:** `kindFor` (status-collect.js) and
  `chooseKind` (run-plan.js) decide the same thing from different inputs,
  and the page's copy cannot see `reconcile` at all.
- **`renderStatus` hardcodes 34/17/70-column pads** and never asks
  `stdout.columns`, while `status-render.js` already exports the
  `painter`/`width`/`pad`/`clip` it needs.

## Documents

- `docs/project/mc/mc-ui/investigation-2026-08-29.md` — inventory, mock-up, options
- `~/mc/mc-utredning/decisions/mc-3.md` — the open question
- `docs/project/mc/mc-status/PLAN.md` — the page this rebuilds; `mc-run` — the writer of `current.json`; `mc-helper` — the writer of intake
- `~/mc/mc-utredning/utredning-2026-08-24.md` §12.5 — the five parts the page must show
