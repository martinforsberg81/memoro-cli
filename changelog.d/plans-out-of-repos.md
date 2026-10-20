section: Removed

- **Plans leave the repositories** (ruling 48). No repository holds a plan file:
  every `PLAN.json` that lived under `docs/project/` in memoro and memoro-cli
  is under `~/mc/programs/`, and its repository copy is removed. The docs route
  refuses a pull request that adds a line to one (`plan`), and the gate refuses
  a candidate that holds one (`plan-in-repo`).
- **The plans-in-git machinery is gone**: `plan-merge.js`, `planBoundary` and
  `plan-trespass`, the runner's archive of repository plans with its closeout
  backfill and link rewriting, and `mc project import`. Every reader of plans
  reads `~/mc/programs/` only.
