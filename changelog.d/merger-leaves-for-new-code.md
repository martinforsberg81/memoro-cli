section: Fixed

- **The merger moves to new code by itself.** It reads its checkout's HEAD
  before each batch, and when the checkout has moved past the commit it
  started on it finishes the rounds in flight, leaves the queue as it is and
  starts its successor on the new code while jobs remain. `mc merge watch`
  says `merger on <commit> · main <commit>` while the two differ.
