section: Added

- **`mc dev admit` — at most two app servers at once, and none while memory is
  short.** `mc dev admit <service> --worktree <path> [--wait <seconds>] [--json]`
  answers `{ "ok": true }` (exit 0) or `{ "ok": false, "reason": "cap" | "memory",
  "holders": […], "free_percent": <n|null>, "cap": <n> }` (exit 75). It counts
  live registered servers that are not `resource_class: light`, leaving out the
  asker's own worktree and service; the cap is `MC_DEV_MAX_SERVERS` (2) and the
  floor `MC_DEV_MIN_FREE_PERCENT` (15) of `kern.memorystatus_level`. `mc test dev`
  asks it before it starts a server, waits up to fifteen minutes naming the
  holders once a minute, and hands the child `MC_DEV_ADMITTED=1`. Nothing running
  is stopped to make room. Measured 12–26 Sep 2026: 141 of 571 local memoro
  dev-server starts died, with seven servers and 8 GB of swap on an 8 GB machine.
