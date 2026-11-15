section: Changed

- **`mc deploy` ships the newest green commit after the live one.** When main's
  tip has no green full run, the newest first-parent commit of `origin/main`
  after the live commit whose full run is green ships instead, and the reading
  says how far behind the tip it is and why the tip was passed over, listing
  every red name. `--accept-red` still ships the tip and names the green commit
  that would have shipped. Production never moves backwards: a pick that is the
  live commit or does not descend from it is refused, also under `--accept-red`.
- **The suites run against exactly that commit.** The shared checkout is placed
  at the pick (detached, only when clean and on main's line), every server start
  pins it and never follows main, and the served commit is checked after each
  start and revive. mc always hands the script
  `MEMORO_DEPLOY_SKIP_REMOTE_PREFLIGHT=1`, and puts its own worktree at the pick
  (fast-forward, or `git reset --keep` when main's tip was passed over).
- **A suite can be declared `gate: false`** with a required `gate_why` in
  `.mc/test.json`: `mc deploy` does not run it and it never refuses; `mc test
  dev` and `mc test prod` are unchanged.
