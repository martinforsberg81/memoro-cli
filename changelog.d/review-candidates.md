section: Changed

- **Review picks from an ordered list of candidates, as fast and large do.**
  `review` in `~/mc/runner/models.json` is now a list. Review is an ordered list
  of candidates: it takes the first that can run on its plan now, and a later
  one only when an earlier cannot or is the model the goal was built on. The
  order is preference, not headroom. Only when no candidate it may run on has
  plan left does the first of them go to its provider's API reserve, and it
  waits while that API is off, as before. `mc model add|remove review` work as
  they do for fast and large; `mc model set review` replaces the whole list
  with one candidate; `mc model` numbers the review list. A file whose
  `review` is one object reads as a list of it and is written back as a list
  the first time `mc model` changes it. With one review model, three goals
  waited over an hour on a spent codex plan, and a goal built on the review
  model could not be reviewed at all.
