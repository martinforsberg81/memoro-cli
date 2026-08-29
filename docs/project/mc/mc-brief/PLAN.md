---
status: ready
next: "Step 4 — close-out: `docs/technical/mc-brief.md` (what it is, what it reads, what it writes) and a row in `docs/project/project_log.md` — done when both exist and the help line still names `mc brief` (it already does, #417)."
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

- [x] `mc brief --collect` writes `~/mc/brief/<ISO date>.md` with these
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
      the decisions are done. (Coded and tested; the launch itself has never
      been watched — no headless session can watch it. Ticked when Martin
      runs `mc brief` once.)
- [x] The role overlay instructs the session to: take decisions one at a
      time, always give a recommendation, write the answer as a line starting
      with `**Beslut:**` (date, Martin's word, one sentence why) at the end of
      the decision file, mark `waiting-decision` projects for the runner by
      that line alone (never edit PLAN.md from the brief session), and end
      when the list is empty or Martin says stop.
- [x] "Last brief" is the mtime of the newest file in `~/mc/brief/`; the
      first run uses 24 h.
- [x] `tests/mc/brief-collect.test.js` covers: decision-file scan (answered
      vs unanswered), PLAN.md status parsing, and the runs.tsv window.
- [x] `mc brief` appears in `src/mc/help-text.js` with one line.

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
- [x] **2. Session** (2026-08-25: `canon/roles/brief.md`, session in `src/mc/commands/brief.js`, `tests/mc/commands/brief.test.js`; the interactive launch itself is not yet observed) — `mc brief` launches the fresh session with the file as
      first prompt and the `brief` role overlay. Done when running it opens a
      session whose first assistant turn lists the pending decisions.
- [x] **3. Answers land** (2026-08-29) — the overlay's `**Beslut:**` line is
      what the runner greps, and every question the runner watches now reaches
      the brief. Done when the line built from `canon/roles/brief.md`'s own
      template satisfies all three copies of the test, closes the question in
      the next brief, and no file the runner watches is missing from *Waiting
      on Martin*. The original wording — "observed once in `runner.log`" —
      could not be met from here and was revised; see *What the code taught
      us*. Verified: `tests/mc/commands/brief.test.js` (the round trip) and,
      against the live `~/mc`, 45 decision files with 10 unanswered and an
      empty "watched but never shown" list (was 41/9, and one of the 41 was a
      358 kB log).
- [ ] **4. Close-out** — `docs/technical/mc-brief.md` (what it is, what it
      reads, what it writes), row in `docs/project/project_log.md`; the help
      line landed in #417. Done when both files exist.

## What the code taught us

- Recommendations come in two shapes: a `## Rekommendation` heading (night-1
  sessions) and a bold lead `**Recommendation: option 2.**` (docx-editor).
  Both are quoted into *Waiting on Martin*; a question with neither shows a
  dash, which is honest — see the next-to-last note for why neither shape
  may be required.
- One fetch and two `gh pr list` per repository, run one after another,
  took 10.4 s — the whole budget. Concurrently: 7 s. `--offline` skips them.
- The brief session stands in the work root (`~/mc`), not in a repository:
  its writes are `~/mc/*/decisions/*.md`, and a worktree would only put a
  branch under a conversation that must not commit anything.
- `~/mc/bin/runner.sh`'s `queue_names` fallback (`NF==4`) never matches
  `docs/project/<programme>/<project>/PLAN.md` (five fields), so only
  `queue.md` names run today. `mc run` must use depth five.
- The brief was hiding open questions from the only person who can answer
  them. A decision file had to carry an options-or-recommendation section
  written as `## Alternativ`/`## Options` or a bold lead; the runner has no
  such test — it watches every `<area>/decisions/*.md`. Measured against
  `~/mc` on 2026-08-29, the narrower rule dropped five watched files, one of
  them unanswered and never once shown (`swedish-grammar/decisions/language-content-1.md`,
  whose options are `## Half one …` and a bullet), while `## Alternativen` —
  the Swedish definite form — failed the `\b` after `Alternativ`. It also let
  in `pm/decisions/log.md`, 358 kB of append-only log, on one matching line.
  A `# ` heading is now the whole test, and the three bookkeeping names are
  skipped by name. The brief must be at least as wide as the runner.
- Step 3 as written could not be verified from inside the runner. "Observed
  once in `runner.log`" needs a later round, and a step session *is* the
  round: `runner.log` at 05:15Z shows `mc-brief: step starting` as its last
  line and nothing moves until this session ends. The other half needs Martin
  in an interactive brief. So the checkable part — that the shape the overlay
  dictates is the shape all three greps accept, and that it closes the
  question — is a test that reads `canon/roles/brief.md` itself; the live
  round remains for Martin to watch once.
- The runner starts a `waiting-decision` project on the wrong answer. Its
  rule (`runner.sh:205`, `mc run`'s `answeredDecisions`) counts any
  `<programme>-*.md` with a `**Beslut:**` line, so `mc/mc-helper` — whose
  `next:` says it waits on `~/mc/mc-utredning/decisions/mc-2.md`, unanswered —
  will be run this round because `mc-1.md` was answered on 2026-08-26. Not
  mc-brief's code to change (it is `mc run`'s, on `mc-run-step-1`), and the
  plan already names the file it waits on, so the fix is small: match the
  file `next:` names when it names one.

## Documents

- `~/mc/mc-utredning/utredning-2026-08-24.md` §9–13 — why a runner and a brief, not a PM
- `~/mc/decisions/2026-08-25-briefing.md` — the hand-made brief this verb replaces
- `~/mc/bin/runner.sh` — the runner; `waiting-decision` handling is the contract this must match
- `~/memoro/docs/project/README.md` — the plan-directory convention
