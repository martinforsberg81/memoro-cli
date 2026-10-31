section: Added

- **The runner measures checkpoint and criterion progress itself.** A model's
  `checkpoint` or `criterion` callback only asks for a measurement. The runner
  runs the relevant gate (`mc gate --json`) or the goal contract's own check in
  the background, and only a pass over unchanged worktree content resets the
  no-progress clock, for the goal revision it was measured on. The callback's
  text is never executed. A red, timed-out or interrupted measurement withholds
  progress and records no failure. Before, the default verifier reported no
  progress, so the no-progress clock always ran. The verifier is built; the
  runner does not call it yet.
