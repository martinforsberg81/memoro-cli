section: Changed

- **`mc merge` refuses a pull request that cannot land as asked, before it is
  queued.** A pull request GitHub reports `CONFLICTING` with its base stops at
  the door with a line that says to merge `origin/main` into the branch, resolve,
  `mc publish`, and `mc merge` again. So does one whose branch the caller's
  worktree holds at a head origin does not have: the line names both short
  heads and says `mc publish` first. Either refusal queues nothing and records
  no round. A worktree on another branch, and `UNKNOWN` mergeability, are queued
  as before.
