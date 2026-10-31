section: Fixed

- **A large goal builds on the large class.** The autonomous build routed every
  step on `fast` and recorded `class: 'fast'` whatever the goal's `work_class`.
  It now routes on the goal's own class and records that class in the current
  step; fast goals are unchanged.
- **`mc programme show` says when a programme has no state yet.** A programme
  with no state file used to print `invalid mc-programme-state state`. It now
  prints one plain line naming the first `mc programme phase add` or
  `mc programme metadata` that creates the state. A present but invalid state
  file still fails with the existing message.
