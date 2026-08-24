section: Changed

- **Extra gates run on both sides, and the delta decides (D-0138).** The
  suite has been differential from the start; the extra gates never were —
  they ran on the candidate alone, so the round could not tell "the
  candidate is red" from "the world was already red", and attributed the
  difference to the one party in the room. Measured 2026-08-24 on #10909's
  round: `msr contract` FAILED on the candidate (411 s), a track spent six
  minutes proving its innocence, and untouched origin/main had the same
  five failures the whole time. Now each declared gate runs on the baseline
  too and the verdict is the delta: candidate red + baseline green stops at
  `extra-gate` as loudly as ever; red on both sides stops at
  `extra-gate-baseline` — "already red before this PR … the base itself is
  broken; not this change's doing"; a gate that prints TAP is compared by
  red *names*, so a new failure on a red baseline is still the PR's; and a
  candidate that repairs a red baseline passes, with a sentence. The cost
  is paid once per main SHA, not once per PR: after a green merge the
  candidate's gate results ride into the A1 baseline cache (main *is* the
  tree they ran on), the next round carries them, and only a cache miss —
  new main, changed command, an entry from before — runs the baseline side
  live in the baseline worktree, which is created for the purpose even
  under a carried suite result.
