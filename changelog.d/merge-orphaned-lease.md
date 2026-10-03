section: Fixed

- **`mc merge` no longer waits forever behind an orphaned lease.** `waitTurn`
  counted a repository lease as in the way whenever it was held, and an
  orphaned one — its owner's process gone — is still `held`; only
  `claimLease` reaps it, and no waiter ever got far enough to claim. On
  2026-09-20 three merges polled behind a dead round's lease for a morning.
  An orphaned lease is now free to the wait: the waiter whose turn it is goes
  and its round's claim reaps the lease. While it is not yet a waiter's turn,
  the waiting line names the lease as orphaned rather than naming a holder
  that is gone.
