section: Changed

- **A released repair order is cut by code, like any ready order.** The runner
  makes one goal for each released part that has none and the documentation
  goal, from the snapshot the release bound, and in the same step records the
  release as reconciled (reason `cut by code: one goal per released part`) and
  writes what each part waits for into the record. `mc programs release` now
  says `repair programme <programme> is released — the runner cuts its goals`.
  A goal cut from the order holds no text, so a changed part asks nothing of
  it; one in review or merge whose part changed returns to build with the
  entry `its released part changed — back to build`. A part a later release
  removed no longer stops the reconciliation: its unfinished goal gets no
  session and waits for the desk to drop it. A goal written with a contract
  keeps every rule it had. A reconciliation that refuses is a cut that failed:
  the second failure opens a desk item, which stays open until the release is
  reconciled.
- **`mc programs reconcile` is gone, and so is the planner's way into a repair
  order.** No session reconciles a release, and `mc goal new` is refused in a
  released repair order. A desk that took an order over still sets it ready
  with `mc programs state <programme> ready`.
