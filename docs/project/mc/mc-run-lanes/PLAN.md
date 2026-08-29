---
status: ready
next: "Step 1 — `mc run` drives one lane per repository (memoro, memoro-cli) at the same time inside the one process; each lane has its own `current-<repo>.json`, the page's NOW lists both; a quota answer pauses both lanes; STOP stops both after their current step — done when runner.log shows two steps overlapping in time and the page names both."
budget: 150k
needs: [mc-ui]
---

# mc run lanes — one step per repository at a time, not one per machine

## Goal

One step at a time is too slow (Martin, 2026-08-29: "Runner behöver nog
kunna köra två olika spår samtidigt om vi ska få fart"). The steps of
memoro and memoro-cli never touch: different main branches, different
worktrees, the runner merges without the suite gate. So `mc run` runs one
lane per repository, concurrently, in the same process — nothing new to
type or start.

## Rules

- A lane owns one repository. The queue is split by the repo each plan
  lives in; Martin's order in `queue.md` still holds within a lane.
- `~/mc/runner/current.json` becomes one file per lane
  (`current-memoro.json`, `current-memoro-cli.json`); `runner.json` stays
  one. The NOW block lists every live lane.
- The 5-hour Claude quota is shared: a quota answer in either lane pauses
  both (one sleep, not two). STOP ends both lanes after their current step.
- Each lane writes its own runs.tsv rows and log lines, prefixed by
  project name as today; no interleaving problem because lines are
  appended whole.
- Two lanes, not N: a third repo would be a third lane, but nothing
  makes lanes within one repository — main would race.

## Success criteria

- [ ] runner.log shows a memoro step and a memoro-cli step overlapping.
- [ ] `mc status --json` (`mc --json` once mc-ui lands) shows both under
      `now`.
- [ ] A quota answer in one lane pauses the other; STOP stops both.
- [ ] Tests cover the split queue, two current files, and the shared
      pause.

## Contract

- No new command or flag. Single-repo behaviour is unchanged when only one
  repo has ready plans.

## Steps

- [ ] **1. Lanes** — one PR.
- [ ] **2. Close-out** — `docs/technical/` note, `project_log.md` row.
