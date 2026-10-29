section: Changed

- **A step names a work class, never a concrete model.** `mc project step add`,
  `step edit` and `send` take `--model fast` or `--model large` only, and
  `amend` refuses a concrete model it would write. A step pinned to one model
  waited whenever that model's usage was spent, where a class takes the next
  candidate, and plan or API is billing's to decide, not the step's
  (2026-10-29: autonomy-operations, pinned to `gpt-6.1-sol`, retried every half
  hour against a Codex limit six days from its reset). A plan sent before this
  keeps its concrete models and runs on them, and an amendment of it judges only
  the model it writes.
