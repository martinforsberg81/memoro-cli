section: Fixed

- **`resource-claim.test.js` no longer hangs.** Its claimants called
  `takeGateLock` without the `lane` it has required since lanes went per
  repository, so each child threw and the test waited for an answer until the
  ceiling. It passes the lane now, and a child that dies fails the test at once.
