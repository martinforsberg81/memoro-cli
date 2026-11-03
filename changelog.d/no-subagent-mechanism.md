section: Removed

- **mc launches no Haiku workers.** `runner.subagents`, on a plan or a step,
  is removed (ruling 62): `mc project send` refuses it by name, `mc project
  amend` drops it from the plan it writes, and a sent plan that still carries
  it reads and runs as before without it. `_step-workers.md`, the
  `step-worker` agent and the register's `subagents`/`workers` fields go. A
  session may use its own tool's subagents; mc neither starts nor counts
  them. Native delegation is switched on for every session, including plan:
  Claude gets `Agent` in its seven-tool allowlist, without mc-defined agents;
  Codex gets `features.multi_agent=true`, overriding a machine-level disable.
