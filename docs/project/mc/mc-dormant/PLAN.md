---
status: ready
next: "Step 1 — `mc pm` and `mc pm-helper` answer one line and exit 2, leave the help text; `mc watch` and every `watch-*`/`wake*`/`watchers-state` module, their tests and `~/.memoro/mc/watch/` go; `mc worker` reads its role from `canon/roles/worker.md` and escalates to `../decisions/` — done when `npm test` is green on the surviving suites, `mc --help` names neither pm nor watch, and `mc worker x` starts a conversation with the canon role."
budget: 150k
needs: []
---

# mc dormant — pm and pm-helper go quiet, mc watch goes away, worker stays

## Goal

Martin ruled on `~/mc/mc-utredning/decisions/mc-1.md` (2026-08-26, option
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

- [ ] `mc pm …` and `mc pm-helper …` print one line — "mc pm is dormant —
      the runner and mc brief replaced it (decision mc-1)" — and exit 2.
      `role-singleton.js`, `pm-helper-intake.js` and the reserved names in
      `roles.js` stay (the impostor guard is still right); the pm and
      pm-helper help blocks go.
- [ ] `mc watch …` is not dispatched; `src/mc/commands/watch.js`, every
      `watch-*.js`, `watchers-state.js`, `wake-queue.js`, `wakeup.js` and
      their tests are deleted, with whatever imports them either deleted
      or rewritten so nothing dead is kept for the import alone. The
      `mc watch` help blocks go. `mc status --sessions` no longer prints
      a watchers column.
- [ ] `~/.memoro/mc/watch/` is removed by the step, once, and the step's
      PR body says so with the file list.
- [ ] `canon/roles/worker.md` exists; `mc worker <name>` reads it through
      `readCanonRole` (as `mc plan` does) and the user catalogue is no
      longer required for the worker; the overlay tells the worker to
      escalate by writing `../decisions/<project>-<date>.md` and setting
      `status: waiting-decision`, not by sending to a PM.
- [ ] `npm test` is green on the surviving suites; the V1 lifecycle failures
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

- [ ] **1. Dormant, deleted, moved** — the three changes above in one PR,
      because they share `mc-cli.js` dispatch and `help-text.js`.
- [ ] **2. Close-out** — `docs/technical/` note on the one-world surface,
      `project_log.md` row; `mc status` help line for `--sessions` says what
      the board still shows.

## What the code taught us

- (empty)

## Documents

- `~/mc/mc-utredning/decisions/mc-1.md` — the ruling this plan executes
- `docs/project/mc/mc-run/PLAN.md` — the runner that replaced the PM
- `docs/project/mc/mc-plan/PLAN.md` — where `canon/roles/` was established
- PR #410 `cut-old-surface` — the later deletion of the dormant code
