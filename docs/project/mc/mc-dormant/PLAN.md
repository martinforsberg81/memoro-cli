---
status: done
next: "Nothing — the plan is finished. `docs/technical/mc-dormant.md` says what `mc --help` now shows and where the PM and the `mc watch` programme went, `docs/project/project_log.md` carries the row, and `docs/mc-command-matrix.md` no longer lists commands this project removed."
budget: 150k
needs: []
---

# mc dormant — pm and pm-helper go quiet, mc watch goes away, worker stays

## Goal

Martin ruled on [`mc-1`](../rulings.md) (2026-08-26, option
A): the runner (`~/mc/bin/runner.sh`, becoming `mc run`) and `mc brief`
replaced the resident PM and the pm-helper. `mc pm` and `mc pm-helper`
leave the help text and `mc status` and answer "dormant" if typed; their
code stays until it is cut. `mc worker <name>` is kept as the surface
Martin uses to drive a project himself, and gets its role from
`canon/roles/` like `brief` and `plan` do. The whole `mc watch` programme
— the PM watcher, the sessions watchman, wake queue, notices — and all
of its sessions is removed, together with `~/.memoro/mc/watch/`
(1197 session records untouched since 2026-08-24, `notices.jsonl`,
`pm.log`: debris from the world this ruling makes dormant).

A new reader of `mc --help` should see one world: projects under
`docs/project/`, a runner that takes their steps, `mc brief` for decisions,
`mc plan` and `mc worker` for the sessions Martin drives himself.

## Success criteria

- [x] `mc pm …` and `mc pm-helper …` print one line — "mc pm is dormant —
      the runner and mc brief replaced it (decision mc-1)" — and exit 2.
      `role-singleton.js`, `pm-helper-intake.js` and the reserved names in
      `roles.js` stay (the impostor guard is still right); the pm and
      pm-helper help blocks go. `wake-queue.js` went with the guard that
      flushed it — see "What the code taught us".
- [x] `mc watch …` is not dispatched; `src/mc/commands/watch.js`, every
      `watch-*.js`, `watchers-state.js`, `wake-queue.js`, `wakeup.js` and
      their tests are deleted, with whatever imports them either deleted
      or rewritten so nothing dead is kept for the import alone. The
      `mc watch` help blocks go. `mc status --sessions` no longer prints
      a watchers column.
- [x] `~/.memoro/mc/watch/` is removed by the step, once, and the step's
      PR body says so with the file list.
- [x] `canon/roles/worker.md` exists; `mc worker <name>` reads it through
      `readCanonRole` (as `mc plan` does) and the user catalogue is no
      longer required for the worker; the overlay tells the worker to
      escalate by writing `../decisions/<project>-<date>.md` and setting
      `status: waiting-decision`, not by sending to a PM.
- [x] `npm test` is green on the surviving suites; the V1 lifecycle failures
      that #410 cuts are not counted here — name them in the PR body.

## Contract

- No behaviour of `mc new`, `mc work`, `mc status` (the page), `mc brief`,
  `mc plan`, `mc merge`, or the runner changes.
- pm/pm-helper are dormant, not deleted: if they return it is in modified
  form. The delete of their code belongs with #410 and the
  test-architecture discussion, not here.
- `mc repo watch` (the repository watcher behind the gate) is a different
  thing and is out of scope; only `mc watch` (pm, sessions) goes.

## Steps

- [x] **1. Dormant, deleted, moved** — the three changes above in one PR,
      because they share `mc-cli.js` dispatch and `help-text.js`.
- [x] **2. Close-out** — `docs/technical/mc-dormant.md`, the `project_log.md`
      row, and the command matrix brought back to what exists. (The
      `mc status --sessions` help line was rewritten in step 1; the board it
      described has since gone entirely with decision mc-3, so nothing
      prints a watchers column because nothing prints that board.)

## What the code taught us

- **The wake queue could not survive its flusher.** The success criterion
  listed `wake-queue.js` for deletion while the Contract froze `mc work`'s
  behaviour, and `mc work send --wake` is what wrote to the queue. The code
  settled it: the only thing that ever *retried* a queued wake was the
  session guard's round (`watch-sessions-loop.js`). With the guard gone, a
  queued wake meant "it will be knocked when the prompt clears" with nothing
  left to knock — a promise the board repeated on every page. So the queue
  went, and the one visible line changed with it: a wake refused on a draft
  is now reported (`a draft is in <name>'s prompt, so nothing was typed`)
  rather than queued. The delivery — the file in the inbox — is untouched,
  and so is the guarantee that nothing types over a draft. D-0186's
  stopped-tool special case went too: it existed to decide *who would
  retry*, and now nobody does, so both cases say the same thing.
- **`watchers-state.js` also spoke for `mc repo watch`.** Its row named
  three watchers, two of which this step removes. Deleting the module takes
  the repository watcher off the `--sessions` board and out of
  `mc doctor`'s not-in-force list; `mc repo watch status` is unchanged and
  is now the only place that answers for it.
- **The worker role needed a home mc ships.** `mc worker` read
  `~/.memoro/mc/roles/worker.md` — a directory mc does not install — so the
  one role mc still launches depended on the user's catalogue existing. It
  now reads `canon/roles/worker.md` like `mc plan` and `mc brief`, and
  `areaRole` falls back to canon so conversations opened later in the area
  get the overlay too. A catalogue that defines `worker` still wins.
- **`mc pm`'s machinery is kept, so its tests are kept.** The singleton
  tests drove `role-singleton.js` through the CLI, which no longer routes
  there. They now go through `tests/mc/_helpers/role-singleton-entry.js` —
  same subprocess shape, one hop closer to the module — so the code that
  stays until #410 does not rot untested.

- **A close-out found two role overlays still naming the runner.**
  `canon/roles/worker.md` — written by step 1 — and `canon/roles/plan.md`
  both said `mc run` deletes an answered decision file. It does not, and has
  not since 2026-08-29: the runner reads no decision file at all, and
  `retireDecisions` runs from `mc brief --collect` once no plan waits on it.
  The same drift was corrected in `canon/roles/brief.md` by mc tidy's
  close-out; these two were the rest of it. Both now say what actually puts a
  project back in front of the runner — the next session writing the answer
  into `PLAN.md` and setting `status: ready`.
- **`docs/mc-command-matrix.md` still ran the old world.** It claims to be
  derived from the routers and that "if a command is not listed here it does
  not exist", and it listed `mc watch sessions` and `mc watch pm` with their
  flags, described `--wake` as queuing a knock, and gave `mc pm` a workspace.
  The plan's Goal is that a reader sees one world; the help was made to say
  so in step 1 and this file was the other half of the same reader's path.
  Only this project's own footprint was corrected — the matrix's other
  staleness (`mc --watch`, `mc work list`, `mc worktrees`) belongs to the
  projects that caused it.
- **The reserved names now point at dormant doors.** `mc worker pm` is still
  refused, correctly, with "created by its own command (`mc pm`)" — and
  `mc pm` then says it is dormant. `helper` is on the same list and points at
  `mc pm-helper`, while the live `mc helper` is a different thing that creates
  no workarea. Two honest hops rather than one, and the name stays protected;
  the wording is for #410's cut to settle, not for a close-out to change.

## Documents

- `docs/technical/mc-dormant.md` — what this project leaves behind
- [`mc-1`](../rulings.md) — the ruling this plan executes
- `docs/project/mc/mc-run/PLAN.md` — the runner that replaced the PM
- `docs/project/mc/mc-plan/PLAN.md` — where `canon/roles/` was established
- PR #410 `cut-old-surface` — the later deletion of the dormant code
