section: Changed

- **`mc deploy` asks no question and needs no terminal.** Typing it is the
  decision: once the reading is printed and the gate has passed, the deployer
  starts, from a terminal or from a session's shell. The `deploy <sha> to
  production? [y/N]` prompt, its refused row *"answered no at the question"* and
  the exit 2 for a missing terminal are gone, and no flag replaces them. Every
  refusal that came before the deployer is unchanged — a red, stalled or
  unmeasured pick without `--accept-red`, a failed suite, a deploy or language
  run in progress, a pick that would move production backwards, a dirty or moved
  worktree — and so is the refusal of an unattended session (`MC_HEADLESS=1`).
  The line that says the deployer started now reads `mc: deploying <sha> to
  production in its own process (pid …)` and, under `--accept-red`, carries the
  reason. To only read what would ship, type `mc deploy --dry-run`: it starts
  nothing and writes no row.
