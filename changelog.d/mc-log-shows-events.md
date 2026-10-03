section: Fixed

- **`mc log` shows the events a command logged.** `runsFrom` kept a run's
  start, end and narration and folded every other line into `events`, a
  count — so `dev-server-stopped` (run `run_f0b0cce9ef1a`, 2026-09-26) was in
  `mc.log` and in no form of `mc log`, and `dev-server-lifecycle`'s criterion
  asking to paste it could only be met by grepping the file. Each run now
  carries `logged` (`{ at, event, fields }`); `mc log <run>` lists them under
  `logged` with their fields, `--json` has them as `logged`, and the one-line
  view ends a run that logged any with their names (`+ dev-server-stopped`).
