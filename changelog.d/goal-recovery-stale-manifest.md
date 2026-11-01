section: Fixed

- **A goal no longer spins in recovery on an older attempt's manifest.** A
  closed session with its attempt on record is history, so ownership is released
  and the next build can take over the tree. `review-support-reachable` looped
  2 803 times over 8 hours and held a machine slot on each pass.
