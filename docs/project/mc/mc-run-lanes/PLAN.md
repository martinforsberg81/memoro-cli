---
status: done
next: "nothing — the lanes run and are written down; step 2 closed it out."
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

- [x] runner.log shows a memoro step and a memoro-cli step overlapping.
- [x] `mc --json` (mc-ui landed, so this and not `mc status --json`) shows
      both under `now.steps`.
- [x] A quota answer in one lane pauses the other; STOP stops both.
- [x] Tests cover the split queue, two current files, and the shared
      pause.

## Contract

- No new command or flag. Single-repo behaviour is unchanged when only one
  repo has ready plans.

## Steps

- [x] **1. Lanes** — one PR.
- [x] **2. Close-out** — `docs/technical/` note, `project_log.md` row.

## What the code taught us

- **NOW became a list, not a second field.** `nowBlock` used to return one
  `step`; keeping it beside a new `steps` would have been two truths about
  the same fact. It returns `steps` only, and the page draws one line per
  lane. `mc --json`'s `now.step` is gone with it — the only reader was the
  page.
- **The session had to stop being synchronous.** `mc run` spawned the
  headless tool with `spawnSync` and waited. Two lanes in one process cannot
  overlap behind a call that holds the event loop for the whole budget, so
  `deps.session` is a promise now (`spawn`, output collected and capped
  rather than `maxBuffer`). Nothing else about the step changed, and the
  fakes in the tests still return a plain object.
- **A lane re-reads only its own repository.** The mid-round re-read after a
  merged step fetches one repository (`queue({ only })`), so the two lanes
  never run `git fetch` in the same checkout at the same moment.
- **The close-out note is the lanes, not the whole runner.**
  `docs/technical/mc-run.md` did not exist, and the `mc run` project that owns
  that name is still open (its step 2 is a live round on the real queue). So
  the note frames the round/step/lane vocabulary and then says what this
  project changed; the rest of the runner grows into the same file when
  `mc run` closes out. It is pinned by `tests/mc/run-doc.test.js`, the way
  `mc helper`'s note is pinned — every number the prose states is read back
  out of it and compared with the export it describes.
