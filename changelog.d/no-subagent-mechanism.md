section: Removed

- **mc launches no Haiku workers.** `runner.subagents`, on a plan or a step,
  is removed (ruling 62): `mc project send` refuses it by name, `mc project
  amend` drops it from the plan it writes, and a sent plan that still carries
  it reads and runs as before without it. `_step-workers.md`, the
  `step-worker` agent and the register's `subagents`/`workers` fields go. A
  session may use its own tool's subagents where the tool offers them; mc
  neither starts nor counts them.
