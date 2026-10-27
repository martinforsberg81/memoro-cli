section: Added

- **Amend an authorized plan while it stays blocked.** `mc project amend`
  validates contract, remaining instructions and criteria together, records
  before/after authorization, preserves execution history and refuses active
  work or open PRs. A separate `mc step ready` still releases the project;
  ordinary edit freezes remain unchanged.
