---
status: ready
next: "Step 1 — `mc status` (bare, no args) prints four blocks with no model call in under 5 s: RUNNER (queue with count and next project; steps in the last 24 h by kind with merged/open/failed; estimated list-price cost from runs.tsv token columns with the price table stated), DECISIONS (unanswered decision files under ~/mc/*/decisions/, one row each), PROJECTS per repo (programme → project: status, next truncated, last step time from runs.tsv, open PR number), and an --json form — done when the bare verb prints those blocks on this machine against the real files and a test covers each block's builder with fixture files."
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
- [ ] `--json` emits the same as one object.
- [ ] No model call, no network beyond `git fetch` and `gh pr list` (both
      skippable with `--offline`), under 5 s with fetch cached.
- [ ] `mc status <name>` keeps working for one project: its PLAN.md
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

- [ ] **1. Runner + decisions + projects** — the four blocks, text form.
      Done when the bare verb prints them against the real files and tests
      pass on fixtures.
- [ ] **2. `--json` and `mc status <name>`.** Done when both work and are
      tested.
- [ ] **3. Retire the old board** — remove sessions/leases/watchers from the
      bare output (`--sessions` keeps them), update help text. Done when
      `mc status` shows nothing about mechanisms that no longer run.
- [ ] **4. Close-out** — `docs/technical/mc-status.md`, `project_log.md`.

## What the code taught us

(empty)

## Documents

- `~/mc/runner/log/runs.tsv` — column contract (ts name kind exit seconds pr turns input output cache_read cache_write session note)
- `~/mc/queue.md`, `~/mc/*/decisions/*.md`, `docs/project/*/*/PLAN.md` — the inputs
- `~/mc/mc-utredning/underlag/usage48h.py` — the price table used in the investigation (list prices, 2026-06)
- `docs/project/mc/mc-run/PLAN.md` — the writer of runs.tsv
