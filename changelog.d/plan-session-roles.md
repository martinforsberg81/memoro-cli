section: Changed

- **Roles are plan, build and review sessions; verbs have files of their own.**
  `canon/roles/` holds `all-sessions.md` (was `_common.md`), `plan-session.md`,
  `build-session.md` (was `build-goal`, `build-project`, `worker`, `_build`,
  `_step-workers`), `review-session.md` (was `review`, `goal-review`) and the
  verb files `project-verb.md`, `step-verb.md` and `goal-verb.md`.
  `_session-work.md` and `_plan-writing.md` are gone into them. A role started
  more than one way keeps each start's words in a `@part`, and a start names
  its part: `build-session:goal`, `review-session:project`. That name is
  `MC_ROLE` and the role record; an area marked `worker` opens as
  `build-session:worker`.
- **A plan session drives the programme toward its aim.** `plan-session.md` is
  written around `~/mc/programs/<programme>/README.md` and full freedom toward
  it, a goal's branch included. Interactive, no restrictions; headless, never
  `mc deploy`, production data, credentials or `--admin`. The headless ban on
  code, commits, publishing and `review`/`done`, and its three allowed ends,
  are gone, and `mc goal` refuses a plan session no status.
