section: Fixed

- **A merge no longer stops when the PR's branch has no checkout.** PR gates,
  docs gates and branch freshening restore one checkout of the branch under
  mc's home and keep it, instead of failing with "no existing checkout".
