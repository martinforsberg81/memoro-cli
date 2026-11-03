section: Changed

- **A goal has a stage and a status.** GOAL.json's one `status` (`open`,
  `review`, `blocked`, …) becomes `stage` — `plan → build → review → finish →
  merging → done`, or `dropped` — and `status`, `ready` or `blocked`. The
  stage only moves forward: a session's backward move is refused naming both
  stages; only a person moves one back, and that is logged. `mc goal convert`,
  and the runner by itself, give every goal its stage from its old status and
  log.
- **Each stage has one owner.** A plan session writes a goal in `plan` (`mc
  goal new --stage plan|build`) and moves it to `build`; a build session moves
  it to `review` or sets `blocked`; a review session decides with `mc goal
  stage merging` — which queues the pull request at the head it judged — or
  `mc goal stage finish`, refused until REVIEW.md is written; a headless plan
  session finishes a goal in `finish`, and takes one red in `merging`; the
  merger sets `done`.
- **No loop.** The runner starts build sessions on `build · ready`, a review on
  `review · ready`, a plan session on `finish · ready` and on `merging · ready`
  after a red — never on `plan`, never on `blocked`. It reads no verdict and
  queues nothing for a review. Three silent builds move a goal to `finish`; a
  review that dies is run once more, then `review · blocked`; a second red in
  `merging` is `merging · blocked`. The `waitsOnPlan` guard is gone.
- **A review's output is three things.** The stage, one proposal in its
  programme's `proposals/`, and one line in LOG.md — no comment on the pull
  request. `mc hook stop`, a new Stop hook `mc hook install` registers,
  refuses a review's end while the goal is in review or no proposal is written.
- **Verbs.** `mc goal stage <stage>`, `mc goal blocked|ready|done|drop`, and
  `mc goal log --stage … --status ready|blocked`; `mc goal open` and `mc goal
  review` are gone. `mc goal list`, `mc goal show`, the page's goal rows and
  `mc --json` say `stage · status`.
