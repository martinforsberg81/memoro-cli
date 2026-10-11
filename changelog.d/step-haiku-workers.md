section: Added

- **A step can hand reading to Haiku workers.** `runner.subagents: on`, on a
  plan or a single step, launches a claude step with `Agent` and one subagent
  mc defines itself, `step-worker` on `claude-haiku-5-5`, and adds
  `canon/roles/_step-workers.md` to its instructions: workers in the
  foreground, a complete brief, never tests, thresholds, the plan or `mc`, and
  every diff and claim checked by the step. A worker answers once; its own
  events reach the stream marked with `parent_tool_use_id`, and the session's
  standing (context, last words, whether it spoke) is read past them. Off by
  default and off on codex. A trial: two steps with it on, then their
  transcripts and `modelUsage` read against the Opus steps before them
  (Martin, 2026-10-11).
