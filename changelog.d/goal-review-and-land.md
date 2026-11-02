section: Changed

- **A goal is reviewed on another model, and done when it lands.** A build
  session ends a goal in the new `review` status; `mc goal log --status done`
  from a session is refused. The runner starts a review session for it with
  the `goal-review` role, on the model `mc model set review` names, never on the
  model of the goal's last build entry. The review judges and never builds: one
  LOG.md entry, `green <sha>` or `red <sha>`, and the same text on the pull
  request. Red leaves the goal `blocked`, waiting on plan; green queues exactly
  that head for the merger. The merger sets the goal `done` when it lands, and
  `blocked` when it answers red; a head that moved sends it back to review.
  `mc goal list` and the page show `review` and draw what waits on plan.
  Ruling 60 and `autonomy-goals.md` are removed. See `docs/technical/mc-goals.md`.
