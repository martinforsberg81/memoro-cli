section: Fixed

- **The improve pulse rides its own clock, not the round's.** #408 stopped
  the PM round feeding itself, but the loop still re-runs the whole round
  the moment a real file lands in PM's inbox — correct, so PM is knocked
  about a new report at once — and the improve pulse rode every one of
  those passes: a session's report landing fired a pulse to a different
  role, 26 times in 36 minutes (measured 2026-08-24). Knocking PM on a new
  file is right; running the rotation on it is not. The pulse is now due at
  most once per interval of wall clock (`last_pulse_at` in the round's
  state, 30 minutes), independent of how often the round runs — a busy
  inbox cannot turn a half-hour rhythm into a flood, and the base loop's
  own irregular wakes cannot either.
