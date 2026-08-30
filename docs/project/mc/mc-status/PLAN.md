---
status: ready
next: "Step 4 — close-out: `docs/technical/mc-status.md` says what `mc status <name>` and the page read, which file every fact comes from, and what the old board was; `docs/project/project_log.md` gets a row — done when both exist, the doc names no mechanism that is gone, and `npm test` is no redder than main."
budget: 150k
needs: []
---

# mc status — the one page Martin looks at

## Goal

`mc status` answers, without a model and in seconds: what is the runner
doing and about to do, what is waiting on me, what happened in the last day
and what did it cost, and where does every project stand — per repo,
programme by programme. It replaces the old status board (sessions, leases,
watcher pulses) whose subjects no longer exist. Everything it shows is read
from files the runner and the sessions already write; it writes nothing.

## Success criteria

- [x] The page prints, in this order — on `mc`, not on `mc status`: decision
      mc-3 (2026-08-29) made the page the front door, and `mc status` now
      says so and answers only about a named project:
      1. **Runner** — is `runner.sh`/`mc run` alive (tmux `runner` or pid);
         queue: N projects, the next one and its kind (triage/step/
         reconcile/decision); last 24 h: steps by kind, merged / left open /
         failed / timed out; estimated cost: cache_read, input, output tokens
         summed per model from `~/mc/runner/log/runs.tsv`, priced with a
         price table in `src/mc/prices.js` (list price, dated; printed as
         "≈ $N list, quota is the real limit — /status").
      2. **Decisions** — every `~/mc/*/decisions/*.md` without a line starting
         `**Beslut:**`: file, first `# ` heading, which project waits on it
         (the `<programme>-` or `<name>-` prefix).
      3. **Projects** — for each repo (memoro, memoro-cli): programme →
         project rows with `status`, `next` (first 70 chars), last step from
         runs.tsv (when, kind, pr), open PR on the workarea branch if any, and
         whether a workarea exists. Read from origin/main of each repo plus
         the workarea branch when it differs (a plan not yet merged).
      4. **Workareas without a project** — `~/mc/*` with a worktree but no
         PLAN.md anywhere: the closure candidates.
- [x] `--json` emits the same as one object.
- [ ] No model call, no network beyond `git fetch` and `gh pr list` (both
      skippable with `--offline`), under 5 s with fetch cached. Measured
      2026-08-30 on a quiet machine: `mc status <name>` 2.3 s live and
      0.13 s `--offline` — inside the bound; the page, which is `mc` now,
      6.8 s either way, so the time is local work (24 worktrees walked, `ps`,
      one git per repo) and not the fetch. Left open deliberately: the page's
      speed is `mc`'s to answer, not this verb's.
- [x] `mc status <name>` keeps working for one project: its PLAN.md
      frontmatter, decisions, last three runs, open PR.
- [x] Tests: each block built from fixture files (runs.tsv, decisions dir,
      a docs/project tree) — no git, no gh (`tests/mc/status-collect.test.js`,
      `tests/mc/status-project.test.js`; git is injected, gh is a stub).
- [x] The old status-board sections (sessions, leases, watcher state) are
      gone from the bare verb — and `--sessions` went with them rather than
      keeping them, so cut-old-surface has no board left to remove.

## Contract

- Reads only. Never writes, never starts anything, never knocks.
- No model. The verb is a script (D-0102).
- Estimated cost is labelled as list-price estimate; never presented as what
  Martin pays. Tokens are from `runs.tsv` only (the runner's own accounting);
  interactive sessions are out of scope here.
- Lives in `src/mc/commands/status.js` + `src/mc/status-*.js`; does not
  import the old session-home code.

## Steps

- [x] **1. Runner + decisions + projects** (2026-08-25: `src/mc/status-collect.js`, `src/mc/prices.js`, `src/mc/commands/status-page.js`; 3.3 s live, 1.6 s `--offline`; `--json` included)
      — — the four blocks, text form.
      Done when the bare verb prints them against the real files and tests
      pass on fixtures.
- [x] **2. `--json` and `mc status <name>`** (2026-08-29: `src/mc/status-project.js`,
      `src/mc/commands/status-project.js`, `tests/mc/status-project.test.js`;
      `mc status docx-editor` 2.3 s live, 1.2 s `--offline`) — the frontmatter,
      the step, the decisions that belong to the project, its last three runs
      and the open PR on its branch. `--json` landed with step 1.
- [x] **3. Retire the old board** (2026-08-30) — the board itself was already
      gone (mc-ui, #441/#444, decision mc-3); what was left was the sentence
      it left behind. `mc status` stopped offering `mc --watch`, a page that
      was removed the day it landed, and `docs/mc-command-matrix.md` lost the
      `mc --watch [seconds]` row and the `w` key the menu no longer has.
      `tests/mc/status-project.test.js` now runs every `mc …` the sentence
      offers.
- [ ] **4. Close-out** — `docs/technical/mc-status.md`, `project_log.md`.

## What the code taught us

- The board was gone before this step arrived. mc-ui took the whole page to
  `mc` under decision mc-3 and removed `--sessions`, `--watch`, `--wait` and
  `--timeout` outright, rather than parking the board behind `--sessions`
  until cut-old-surface. `status-render.js` kept only the drawing primitives
  every other page borrows; `work-status.js` kept only the model that
  `mc repo status` and the lease-liveness check read. There was nothing left
  to delete here.
- What a retired surface leaves behind is a sentence pointing at it. Bare
  `mc status` sent a person to `mc --watch` — removed the same day it landed
  — which answers `unknown command "--watch"`. `docs/mc-command-matrix.md`,
  whose own rule is "if it is not listed here it does not exist", still
  listed it. A pointer is a surface too: the test now runs each `mc …` it
  offers, so it cannot rot into a menu of things that exit 2.
- `--offline` does not make the page faster, which says the 6.8 s is not the
  network. `mc status <name>` is 2.3 s live and 0.13 s offline, so the verb
  this project owns is well inside its bound and the number that misses it
  belongs to `mc`.
- Of the three subjects in this step's own `next:` — sessions, leases,
  watcher pulses — only sessions is gone. `mc repo claim|release|who`,
  `mc suite claim|release|who` and `mc repo watch start|stop|status` all
  still run, and `mc --help` is right to offer them. The old board read
  them; they did not go with it.
- `runs.tsv` has no model column; every row is priced as the runner's
  `MODEL` (opus) and the page says so. `mc run` should write the model.
- The estimate is large: a day of 30 steps ≈ $120 list, dominated by
  cache reads (0.1× input). It is labelled list, never what is paid.
- The bare verb and the old board share `src/cli/status.js`: no positional
  and none of `--watch/--wait/--timeout/--sessions` → the page; those flags
  → the board. `mc status <name>` still means a pre-V1 session until step 2.
- A name now means the project, not the session: `mc status --sessions
  <name>` is the pre-V1 session, and the routing in `src/cli/status.js`
  reads `--sessions` before it reads the positional. Nothing in the tests
  asked for a session by name, so the flip cost one line of help text and
  one row of `docs/mc-command-matrix.md`.
- The plan a person wants to see is the workarea's working copy, not
  origin/main: a step is written, pushed and only merged afterwards, so
  main is one step behind for as long as the PR is open. `mc status <name>`
  reads the workarea when there is one and says `differs from origin/main`
  when the two frontmatters disagree.
- A project's decisions are its own area, its own name, and the
  programme-wide `<programme>-<n>.md` files — narrower than `kindFor`'s
  test, which takes any file starting with the programme. That looseness is
  free for the runner (a false yes only lets a step start) but wrong on a
  page: under programme `mc` it handed `mc-status` the questions of
  `mc-run` and `mc-brief`.
- `next:` on a live plan is a paragraph — docx-editor's is 1 900 characters
  — so it gets a block of its own under `NEXT` rather than a label row, and
  the page folds it at 90 columns instead of clipping it.
- `mc status --json` used to be the board's machine form and nine test
  files (and any session watching the others) read it that way; they now
  say `--sessions --json`. Anything outside this repository that parsed
  the board from `mc status --json` needs the same word.

## Documents

- `~/mc/runner/log/runs.tsv` — column contract (ts name kind exit seconds pr turns input output cache_read cache_write session note)
- `~/mc/queue.md`, `~/mc/*/decisions/*.md`, `docs/project/*/*/PLAN.md` — the inputs
- The price table used in the investigation (list prices, 2026-06). Its script
  is gone from the workarea; what it produced is
  [`utredning-2026-08-24.md`](../utredning-2026-08-24.md) §1.1
- `docs/project/mc/mc-run/PLAN.md` — the writer of runs.tsv
