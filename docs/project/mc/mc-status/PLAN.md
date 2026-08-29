---
status: ready
next: "Step 3 — retire the old board: sessions, leases and watcher pulses stay only behind `--sessions`, and the help text stops offering the mechanisms that no longer run — done when nothing `mc status` or `mc status --json` prints is about a mechanism that is gone, and `mc --help` says the same."
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

- [ ] `mc status` with no arguments prints, in this order:
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
      skippable with `--offline`), under 5 s with fetch cached.
- [x] `mc status <name>` keeps working for one project: its PLAN.md
      frontmatter, decisions, last three runs, open PR.
- [ ] Tests: each block built from fixture files (runs.tsv, decisions dir,
      a docs/project tree) — no git, no gh.
- [ ] The old status-board sections (sessions, leases, watcher state) are
      removed from the bare verb; `mc status --sessions` may keep them until
      cut-old-surface removes the code.

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
- [ ] **3. Retire the old board** — remove sessions/leases/watchers from the
      bare output (`--sessions` keeps them), update help text. Done when
      `mc status` shows nothing about mechanisms that no longer run.
- [ ] **4. Close-out** — `docs/technical/mc-status.md`, `project_log.md`.

## What the code taught us

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
- `~/mc/mc-utredning/underlag/usage48h.py` — the price table used in the investigation (list prices, 2026-06)
- `docs/project/mc/mc-run/PLAN.md` — the writer of runs.tsv
