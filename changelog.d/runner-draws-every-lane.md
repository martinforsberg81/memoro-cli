section: Fixed

- **RUNNER draws every lane, not one per repository.** `mc run lanes 2` puts
  two loops on memoro, and on 2026-09-11 both had a step in flight — the page
  showed one of them, over a memoro-cli row that read like the other half.
  The section built one row per repository and took the first step it found
  there, and the NOW block did not read the `lane` a current file carries, so
  `current-memoro-1.json` was a second reading of memoro rather than a second
  lane. The rows are `per_repo` per repository now (`~/.memoro/mc/lanes.json`,
  the same number NEXT bolds its heads by), numbered `memoro #1`, `memoro #2`
  only when there is more than one, and a step lands on the lane its file
  names. The whole section is redrawn around that: the heading carries the
  answer — `2 in flight` in bold green, `not running` in bold yellow, the lane
  setting and the uptime in grey — a row says `idle` rather than `nothing in
  flight`, the clock is bold because it is the number that moves, the advisor
  model is on the row beside the tool, and the day's line paints `failed` red
  and `timed out` yellow only while the count is not zero. `mc --json` carries
  `lane`, `effort` and `advisor` on each step, `lane` on each lane, and the
  setting as `runner.setting`.
