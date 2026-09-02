section: Changed

- **A session you have open in a workarea no longer stops the runner stepping
  that project.** `mc run` skipped a project whose `mc-<name>` tmux session was
  live. It read as prudence and worked as a second, undeclared way to stop
  work: whether a step ran depended on which terminals happened to be open,
  which is written down nowhere, is nobody's decision in particular, and is not
  a thing the next round remembers. A project the runner should leave alone
  says so where every other such fact is said — `blocked` in its own
  `PLAN.json` (Martin, 2026-09-02). `mc work` and `mc run` now know nothing
  about each other in either direction.
  The page followed, because it predicted the same skip: `QUEUE` counted a live
  area as a reason of its own beside the plan statuses. A page that predicts a
  skip the runner will not make is worse than one that says nothing, because it
  is read as the runner's own answer. Every reason it counts now comes from the
  plan.
  `mc run`'s close-out still asks. That is a different question — whether it is
  safe to *delete* the directory — and pulling the ground from under a terminal
  somebody is standing in is not the same as declining to run a step in it.
