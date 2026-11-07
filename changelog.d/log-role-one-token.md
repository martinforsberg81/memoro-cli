section: Fixed

- **A log entry whose writer role is not one token is still read back.** `MC_ROLE` with whitespace before its `:` (e.g. `my role:x`) used to write a `· by` word that the LOG.md heading pattern did not match, so `parseLog` dropped the whole entry: its stage, status and Done disappeared from the goal, the runner and the page. Such an entry is now written without the `· by` segment, as entries without a role always were. Known roles (build, review, plan, manager) are unchanged.
