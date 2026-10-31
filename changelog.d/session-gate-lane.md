section: Fixed

- **Session gates have their own lane, so they no longer starve the merge
  queue or a deploy.** A session's `mc gate` on a heavy repository now runs in
  the `session` lane, one at a time, beside merge rounds. On 2026-10-31, 74
  session gates in four hours left the merge queue 32 minutes in the heavy
  lane, and a deploy waiting for that lane stopped the queue too. The page now
  says `session gate, not landing` for such a run: it read as a merge starting
  over, with a fresh clock for every gate. A gate still
  does not start while a deploy or an iOS build runs. A gate and a merge round
  can now share the machine.

- **A deploy goes when the merge round in flight is done.** It also waited for
  session gates in both lanes, so it needed both free at one of its polls, and
  sat for over 50 minutes with the merge queue stopped behind it.
