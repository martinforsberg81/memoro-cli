section: Changed

- **Manual Anthropic credits now work with class-routed steps.** `mc run
  --billing credits` selects an Anthropic candidate for every fast and large
  step and for review. An unavailable key or workspace credit leaves the step
  ready to retry without silently using the subscription or Codex. The `auto`
  billing mode is retired; `plan` remains the default.
