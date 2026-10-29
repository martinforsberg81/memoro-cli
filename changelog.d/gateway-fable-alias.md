section: Fixed

- **A Claude session on `fable` reaches the API through the billing gateway.**
  `mc plan` launches Claude with the alias (`--model fable`), and the grant
  carries that alias; Claude Code sends the full id, `claude-fable-5-1`. The
  gateway expanded only `opus`, `sonnet` and `haiku` to their families, so
  every request of a Fable session was answered `403 model unavailable for
  session` — shown in the session as *Please run /login* (2026-10-29,
  `mc plan marketing`).
