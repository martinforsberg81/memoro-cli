section: Fixed

- **Merge rounds keep one measurement checkout per repository.** PRs, batches,
  documents, branch freshening and whole-suite measurements heal and reuse mc's
  detached candidate under the work root instead of borrowing session checkouts.
  Freshening holds the repository lane through its push and never moves the
  session's local branch; tidy retains the measurement checkout.
