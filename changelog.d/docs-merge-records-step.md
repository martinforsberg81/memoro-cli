section: Fixed

- **A step that lands its own docs pull request is `done`, not `failed`.**
  `mc merge <repo> <pr> --docs` merged through `gh` and never wrote to the
  register, so the step stayed `running`. The runner then found no open pull
  request on the branch GitHub had deleted, and recorded *"the session ended
  success (rc 0) with no pull request"*. This happened to memoro's
  `msr-core-finish-measure` steps 1 and 3 (#13772, #13784) on 2026-10-18. The
  verb now finds the step as the gate's door does (`stepForMerge`: `MC_STEP`,
  then the branch) and books it as the merger books a green round
  (`landedPatch`, with a body's remainder). A step already `done` or
  `blocked` is left as it is, and a planning session's pull request books
  nothing.
