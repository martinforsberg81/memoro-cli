section: Added

- **Durable, inactive programme planner jobs.** Programme events coalesce behind
  one leased planner owner, with restart recovery, explicit holds and atomic
  project-creation receipts for idempotent repeated delivery. Existing execution
  stays unchanged; no live programme is activated or planner process launched.
