section: Fixed

- **`/model` works in an interactive session on the API.** `mc plan` and
  `mc work` gave the billing gateway's grant the launch model, so switching
  with `/model` inside the session — Fable to Opus, 2026-10-29 — was answered
  `403 model unavailable for session`, shown as *Please run /login*. An
  interactive grant now names no model; it still names the provider, expires
  and counts requests. Headless sessions keep their one model.
