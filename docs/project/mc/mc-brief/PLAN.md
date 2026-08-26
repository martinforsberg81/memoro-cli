---
status: ready
next: "Step 2 — `mc brief` (no flag) runs --collect and then opens a fresh foreground session (stdio inherit, never tmux, never --resume) with the brief file as its first prompt, the Coding Profile appended and the `brief` role overlay from canon/roles/brief.md — done when running it opens a session whose first assistant turn lists the pending decisions."
budget: 150k
needs: []
---

# mc brief — the evaluation and decision session

## Goal

Martin runs `mc brief` when he wants to. A script gathers everything that
happened since last time — what the runner merged, what it opened, what is
waiting on a decision, what is blocked — and a fresh Opus session opens with
that as its whole context. The session walks Martin through the pending
decisions one at a time with a recommendation, writes each answer as a
`**Beslut:**` line into the decision file (the runner's trigger), notes what
should be re-planned, and exits. Nothing in it lives longer than the
conversation; the state is in files the runner already reads.

This replaces the resident PM and the pm-helper. The runner needs neither; it
runs whether or not `mc brief` is ever called.

## Success criteria

- [ ] `mc brief --collect` writes `~/mc/brief/<ISO date>.md` with these
      sections, in this order: *Merged since last brief* · *Opened, not merged*
      · *Waiting on Martin* (decision files with no `**Beslut:**` line, one
      row each: file, question title, the session's recommendation) · *Plan
      status* (every `docs/project/*/*/PLAN.md` on origin/main of memoro and
      memoro-cli, with `status` and `next`) · *Runner* (last 24 h of
      `~/mc/runner/log/runs.tsv`: steps, kinds, failures, cache_read total) ·
      *Queue* (`~/mc/queue.md`). No model call. Under 10 s.
- [ ] `mc brief` (no flag) runs `--collect`, then starts a fresh interactive
      session **in the foreground — an ordinary terminal program, not tmux**
      (`stdio: 'inherit'`, the path at `src/mc/work-open.js:102`; model opus
      by default, `--codex` allowed through the adapter; Coding Profile
      appended; role overlay from `canon/roles/brief.md`) whose first prompt
      is the brief file. It does not use `--resume`. Martin closes it when
      the decisions are done.
- [ ] The role overlay instructs the session to: take decisions one at a
      time, always give a recommendation, write the answer as a line starting
      with `**Beslut:**` (date, Martin's word, one sentence why) at the end of
      the decision file, mark `waiting-decision` projects for the runner by
      that line alone (never edit PLAN.md from the brief session), and end
      when the list is empty or Martin says stop.
- [ ] "Last brief" is the mtime of the newest file in `~/mc/brief/`; the
      first run uses 24 h.
- [ ] `tests/mc/brief-collect.test.js` covers: decision-file scan (answered
      vs unanswered), PLAN.md status parsing, and the runs.tsv window.
- [ ] `mc brief` appears in `src/mc/help-text.js` with one line.

## Contract

- No model call inside `--collect`. The model is the interactive session only.
- The brief session never edits `PLAN.md`, never merges, never starts the
  runner, never writes to any inbox. Its only writes are `**Beslut:**` lines
  and `~/mc/brief/<date>.md`.
- No new daemon, watcher, or inbox. If something here needs to be woken, the
  design is wrong (D-0218, utredning §9).
- Lives in `src/mc/commands/brief.js` + `src/mc/brief-collect.js`; reuses
  `work-open.js`'s launch path for the session, `conversations.js` for nothing
  (no transcript reading).

## Steps

- [x] **1. Collect** — `mc brief --collect`. Done when the file above exists
      with all six sections, produced without a model, and the test passes.
      (2026-08-25: `src/mc/brief-collect.js`, `tests/mc/brief-collect.test.js`;
      7.1 s live with two repositories, 1.6 s `--offline`.)
- [ ] **2. Session** — `mc brief` launches the fresh session with the file as
      first prompt and the `brief` role overlay. Done when running it opens a
      session whose first assistant turn lists the pending decisions.
- [ ] **3. Answers land** — the overlay's `**Beslut:**` line format matches
      what `~/mc/bin/runner.sh` greps (`^\*\*Beslut`). Done when a decision
      answered in a brief session is picked up by the runner's next round on
      that project (observed once, in `runner.log`).
- [ ] **4. Close-out** — help text, `docs/technical/mc-brief.md` (what it is,
      what it reads, what it writes), row in `docs/project/project_log.md`.

## What the code taught us

- Decision files come in two shapes: a `## Rekommendation` heading (night-1
  sessions) and a bold lead `**Recommendation: option 2.**` (docx-editor).
  A file counts as a decision when it has a `# ` title and either shape of
  options/recommendation; `~/mc/pm/decisions/{README,log,merge-log}.md`
  have neither and are skipped.
- One fetch and two `gh pr list` per repository, run one after another,
  took 10.4 s — the whole budget. Concurrently: 7 s. `--offline` skips them.
- `~/mc/bin/runner.sh`'s `queue_names` fallback (`NF==4`) never matches
  `docs/project/<programme>/<project>/PLAN.md` (five fields), so only
  `queue.md` names run today. `mc run` must use depth five.

## Documents

- `~/mc/mc-utredning/utredning-2026-08-24.md` §9–13 — why a runner and a brief, not a PM
- `~/mc/decisions/2026-08-25-briefing.md` — the hand-made brief this verb replaces
- `~/mc/bin/runner.sh` — the runner; `waiting-decision` handling is the contract this must match
- `~/memoro/docs/project/README.md` — the plan-directory convention
