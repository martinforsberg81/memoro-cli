section: Fixed

- **Codex's small model is `gpt-6-luna`, not `gpt-6.1-luna`.** A step that
  named `gpt-6.1-luna` asked for a model OpenAI does not serve: on the API
  reserve it answered "does not exist or you do not have access to it"
  (2026-10-29). The `fast` class already ran `gpt-6-luna`; the concrete name
  a plan step, `mc project step add` and the role instructions accept now
  matches it.
