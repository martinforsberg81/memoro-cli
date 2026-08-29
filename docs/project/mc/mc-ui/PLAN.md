---
status: ready
next: "Step 4 — The front door: bare `mc` prints the page and, at a TTY, the menu moved from `commands/work.js` with `b`/`p`/`s`/`w` added; `mc --watch`; bare `mc work` routes to the same; `mc list`, bare `mc status`, the status board flags and their modules and tests removed; `HELP_TEXT` leads with the two surfaces — done when `mc` at a TTY shows the page and opens a workarea by number, `mc --json` exits 0 without a prompt, `mc list` and `mc status` say where they went, and `npm test` is green minus the known V1 set."
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

Decided 2026-08-29 (`~/mc/mc-utredning/decisions/mc-3.md`, in session):
**two surfaces and no more.** `mc` is the page and, at a TTY, the menu
`mc work` has today underneath it; `mc --watch [seconds]` is the same page
redrawn, no prompt. Bare `mc work`, `mc list`, bare `mc status`, `mc status
--sessions|--watch|--wait` and the old board go in this project. `mc status
<name>` (one project) and `mc work <name> …` stay as verbs.

## Success criteria

- [ ] Bare `mc` prints the page (per decision mc-3) in under 300 ms with no
      network — measured against today's 1.92 s for `mc status --offline`.
- [x] Five sections, in this order: **NOW** (the running step with kind,
      tool, model, elapsed against budget; a pending STOP; live tmux
      `mc-<name>` areas; a foreground `mc brief`/`mc plan`), **QUEUE**
      (depth, runnable count, the next few by name and kind, skips counted
      by reason), **DECISIONS** (count, the first three), **INTAKE** (digest
      date, new errors, proposals waiting), **WORK** (one numbered row per
      workarea — name, plan status, `next`, last runner step and PR, live
      mark — live first, then by last activity; then one line: N projects
      on main without a workarea, `mc status <name>`).
- [ ] At a TTY, `mc` ends in the menu `mc work` has today (`menu()` in
      `commands/work.js`, moved, not rewritten): a number or a name opens
      the workarea through `openArea`, `n` starts one, `b` runs `mc brief`,
      `p <name>` runs `mc plan <name>`, `s <name>` prints `mc status
      <name>`, `w` switches to watch, `q` quits; any other line is parsed as
      a `mc work` verb as today. Without a TTY, or with `--json`, it prints
      and exits 0.
- [ ] `mc --watch [seconds]` redraws the page every 15 s by default until
      ctrl-c and leaves the terminal clean; no prompt.
- [ ] Removed, with their tests: bare `mc work` (prints the page and menu —
      it *is* `mc`), `mc list` and `src/cli/list.js`, bare `mc status`
      (prints "mc status is now mc", exit 2), `--sessions|--watch|--wait`
      on `mc status`, `commands/status-board.js`, `work-status.js`, the
      board half of `status-render.js` (the `painter`/`width`/`pad`/`clip`
      half stays). `mc status <name>` and `mc work <name> …` unchanged.
- [ ] A number where a number answers the question, a line only where the
      identity matters; each count names the verb that expands it.
- [x] Width-aware and coloured: `stdout.columns` clamped 60–160 through
      `width`/`pad`/`clip` from `status-render.js`; colour only on a TTY and
      only when `NO_COLOR` is unset **or empty** (the convention is any
      non-empty value; `src/cli/list.js` tests `!== '1'`, which is wrong —
      `src/cli/list.js` goes in step 4, so the wrong test goes with it).
- [x] `--json` is the same object the renderer takes, one key per section;
      `--fresh` does the `git fetch` and `gh pr list` that `mc status` does
      by default today; without it the page reads a cache and says its age.

- [x] No new dependency; the renderer is ANSI by hand, as the repo is.
      Tests build every section from fixtures (`current.json`, `runs.tsv`, a
      decisions tree, a `docs/project` tree, an intake dir) — no git, gh or
      tmux.

## Contract

- Reads only. No model, nothing started (D-0102) — with one exception, named:
  `mc run` writes `~/mc/runner/current.json`, because what is running now
  exists nowhere else.
- Step 1 edits `src/mc/run.js`, which `mc-run` owns. It adds a write and
  changes no rule; if `mc-run` is mid-step on that file, this step waits.
- Two surfaces that list, `mc` and `mc --watch`, and none other. A verb
  that prints a list of areas, sessions or projects is a regression.
- The menu's behaviour is `mc work`'s today, moved: what a number, a name,
  `n` and a typed verb do does not change.
- The estimated cost stays labelled list-price, never what Martin pays.
- INTAKE is empty until `mc helper` writes it (decision mc-2, answered A);
  it says "no digest yet", never a zero that looks like health.

## Steps

- [x] **0. Decision** (2026-08-29) — `~/mc/mc-utredning/decisions/mc-3.md`:
      A, sharpened to two surfaces; the removals are this project's.
- [x] **1. What is running now** (2026-08-29) — `mc run` writes `~/mc/runner/runner.json`
      (pid, started) at start and `~/mc/runner/current.json` (name, kind,
      tool, model, budget_minutes, started, pid, worktree) at step start,
      both through `atomic-write.js`, each removed when its scope ends; the
      collector reads them, plus `~/mc/runner/STOP`, plus `quota` rows in
      the last 24 h; `runnerAlive()` becomes "runner.json's pid is alive"
      and the pgrep goes; `kindFor` is replaced by `chooseKind` from
      `run-plan.js`. Done when `mc status --json` carries a `now` block
      within a second of a step starting and nothing there a second after
      it ends — verified with a real runner writing to a real work root
      while `mc status --json` ran in its own process.
- [x] **2. Instant** (2026-08-29) — `listPlans` reads one `ls-tree` and one
      `cat-file --batch` per repository (`parseCatFileBatch` walks the stream
      by byte size, so a plan full of em-dashes survives it); `page-cache.js`
      keeps `~/mc/runner/plans.json` keyed per repository by the
      `origin/main` sha and `~/mc/runner/prs.json` stamped with when it was
      asked; the page is offline and `--fresh` is the opt-in that fetches,
      asks GitHub and refills both; without it the page says the PR cache's
      age. `mc run` keeps its own injected git through `showBatch`. Done:
      `time node src/mc-cli.js status` is 0.10–0.15 s on a quiet machine and
      0.20–0.22 s under load average 15, against 1.34 s before; a PATH shim
      that logged every `git` and `gh` recorded exactly two
      `git rev-parse origin/main` on the default page — no fetch, no gh.
      **The cold path is not under 300 ms**: the first print after
      origin/main moves re-reads both repositories and costs 0.31 s quiet,
      0.48 s loaded. It happens once per merge, and the runner could warm
      the cache in the round it already fetches in — not done here.
- [x] **3. The page** (2026-08-29) — `src/mc/page-collect.js` builds the five
      sections and `page-render.js` draws them; `mc status` prints them today
      and `mc` prints them in step 4. NOW adds the live tmux areas (one
      `tmux ls` carrying `#{session_created}`) and the foreground register
      `~/mc/runner/foreground/<pid>.json`, empty until step 5 writes it;
      QUEUE counts its depth, what is runnable and the skips by reason (a
      live area is a reason of its own); DECISIONS counts and names three;
      INTAKE reads the newest `~/mc/intake/errors-<date>.md`, the bullets
      under "New since the last digest" and the proposals; WORK is one
      numbered row per workarea — the number the menu will open — live first,
      then by the later of the area's mtime and its last runner step, with
      one count line for the projects on main without a workarea. Width comes
      from `stdout.columns` clamped 60–160 through `width`/`pad`/`clip`, now
      exported from status-render.js; colour only on a TTY and only when
      `NO_COLOR` is unset or empty. Done: all five print against the real
      `~/mc` in 0.09–0.14 s, no line exceeds the terminal at 40/60/100/200
      columns, `--json` is the object the renderer takes (the test renders the
      parsed JSON and compares), and `tests/mc/page.test.js` builds every
      section from fixtures plus a temporary work root with no git, gh or
      tmux.
- [ ] **4. The front door** — bare `mc` prints the page and, at a TTY, the
      menu moved from `commands/work.js` with `b`/`p`/`s`/`w` added;
      `mc --watch`; bare `mc work` routes to the same; `mc list`, bare
      `mc status`, the status board flags and their modules and tests
      removed; `HELP_TEXT` leads with `mc`, `mc --watch`, `mc brief`,
      `mc plan`, `mc run`, `mc merge`, `mc status <name>`, `mc work <name>`.
      Done when `mc` at a TTY shows the page and opens a workarea by number,
      `mc --json` exits 0 without a prompt, `mc list` and `mc status` say
      where they went, and `npm test` is green minus the known V1 set.
- [ ] **5. Foreground register** — `mc brief`/`mc plan`/`mc worker` write
      `~/mc/runner/foreground/<pid>.json` (verb, area, tool, model, started)
      at launch and remove it at exit, so NOW names the verb. Done when a
      running `mc brief` appears in NOW as "brief" and is gone after exit.
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
- **The step's pid is the runner's pid.** The session is a `spawnSync` child
  of the runner and its pid is never handed back, so `current.json` names the
  runner. That is the right pid anyway: it is the one whose death means the
  step is over, and both files are tested for life the same way.
- **A step that throws must still clear `current.json`.** The write is paired
  with a `finally` around the session call, not with the normal return — a
  crash in the middle would otherwise leave the page claiming a step forever.
- **One `git show` per plan was the whole cost.** Replacing 47 of them with
  two `cat-file --batch` calls took the page from 1.34 s to 0.31 s before a
  cache existed at all; the cache then takes it to 0.11 s. The brief got the
  same win for free — `mc brief --collect --offline` is 0.64 s. Which means
  the cache buys the last 0.2 s, and the batch read bought the first 1.0 s:
  if the cache ever gets in the way, it can go without losing much.
- **A sha is a better cache key than a clock.** `plans.json` is keyed by
  `origin/main`, so a hit is exactly what a fresh read would return and the
  page has no staleness to confess. Open PRs have no such key — one closes
  without moving any sha — so `prs.json` is stamped instead, written only by
  `--fresh`, and its age is printed. The two files are not the same kind of
  cache and the code says so.
- **The Contract's "reads only" now has a second exception.** Step 2, as
  approved, writes `plans.json` and `prs.json`. They are a read-through
  cache of what the page already reads — delete both and `--fresh` refills
  them — not state anything else depends on, so this is recorded rather than
  escalated. The Contract's point stands: no model, nothing started.
- **`renderStatus` hardcodes 34/17/70-column pads** and never asks
  `stdout.columns`, while `status-render.js` already exports the
  `painter`/`width`/`pad`/`clip` it needs.

- **A count is only honest if the section knows what it cannot see.** INTAKE
  exists now — `mc helper` ran on 2026-08-29 and wrote
  `~/mc/intake/errors-2026-08-29.md` — but its first digest has no baseline,
  so the section says "first digest — no baseline" rather than "0 new errors".
  The same rule keeps the foreground list empty rather than claiming nothing
  is running: nothing has registered, which is not the same as nothing being
  there. Step 5 makes the difference disappear.
- **The tmux call already had the answer to "how long".** `tmux ls -F
  '#{session_name} #{session_created}'` costs what `-F '#S'` cost and carries
  the epoch second the area was opened, so a live row can say `open 3 h`
  without a second call. NOW needs no `ps` and no `lsof`.
- **`clip` fills its column exactly, so a clipped name touches its
  neighbour.** Every column now clips one short of its pad — the ellipsis is
  the last character, never the last column. Found by reading the real page,
  not by a test.
- **Escape sequences must be added after the width is decided.** `clip` slices
  by character index, so clipping a string that already carries colour cuts an
  escape in half. Every heading and prose line is measured and cut as plain
  text and painted afterwards; the row helper only ever pads text whose width
  it set itself.
- **The 24 h summary counts a timeout as a timeout and not a failure**
  (`summariseRuns`), which is why the page's own line reads `failed 0, timed
  out 1` for a run that did both. The page repeats the runner's arithmetic
  rather than inventing its own.

## Documents

- `docs/project/mc/mc-ui/investigation-2026-08-29.md` — inventory, mock-up, options
- `~/mc/mc-utredning/decisions/mc-3.md` — the decision (A, two surfaces)
- `src/mc/page-collect.js`, `src/mc/page-render.js` — the five sections and how they look (step 3)
- `src/mc/page-cache.js` — plans.json and prs.json, the two caches step 2 added
- `src/mc/commands/work.js` `menu()`/`typed()`/`startSomething()` — the menu that moves under the page
- `docs/project/mc/mc-status/PLAN.md` — the page this rebuilds; `mc-run` — the writer of `current.json`; `mc-helper` — the writer of intake
- `~/mc/mc-utredning/utredning-2026-08-24.md` §12.5 — the five parts the page must show
