section: Changed

- **`mc merge` queues; one merger lands** (ruling 30). `mc merge <repo> <pr>`
  checks the plan boundary, makes the step `landing`, writes the job into
  `~/mc/runner/merges.json` and returns. One detached process — the merger,
  pid in `~/mc/runner/merger.json`, output in `~/mc/runner/log/merger.log` —
  lands the queue oldest first, one at a time, and writes the register:
  green `done`; red the step `ready` again with the gate's reason and its pull
  request, which the runner's next session for the step is handed and goes on
  with (the third red is `failed`). No `mc merge` waits for the gate any more,
  no exit 3, no "run this again"; the runner queues a session's unasked pull
  request the same way, starts a merger when the queue has jobs and none is
  alive, and fails a `landing` step whose job is in no queue. The page's
  MERGES and `mc status <name>` draw the queue; the step role ends at
  "queued".
- **The next step does not wait for the merger** (ruling 30, A). A step
  `landing` is passed over: the runner starts the next step at once on a branch
  on top of it (`stacked_on` in the register), the merger lands the two in
  order and moves the upper one onto main past the squash below before its
  round. A red below is the project's next session's first; the job on top
  keeps its place and goes once that one has landed.
