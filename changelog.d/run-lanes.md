section: Changed

- **`mc run` drives one lane per repository at the same time.**
  One step at a time made a round as slow as both repositories together,
  though the steps of memoro and memoro-cli never touch: different main
  branches, different worktrees, different pull requests. A round now splits
  the queue by the repository each plan lives in and runs the lanes side by
  side inside the one `mc run` process — nothing new to type or start, and
  one repository with ready plans is still one lane. Martin's order in
  `queue.md` holds within a lane. `~/mc/runner/current.json` became one file
  per lane, `~/mc/runner/current-<repo>.json`, and the page's NOW block lists
  every live one. The Claude quota is one budget for both: the lane that is
  refused sleeps, the other joins that same sleep before its next step rather
  than spending a session to be told the same thing, and `~/mc/runner/STOP`
  ends both lanes after the step each is in. The session is spawned
  asynchronously now — a synchronous wait held the event loop for the whole
  budget, and the second lane would never have started.
