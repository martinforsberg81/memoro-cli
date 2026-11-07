section: Fixed

- **A session's writer role names its log heading only when it is a known word or one token.** `MC_ROLE` set to a name on `Object.prototype` (`constructor`, `toString`) wrote no `· by` segment through an inherited lookup; it now writes `· by constructor` like any other unknown role. Known roles still write `· by build|review|plan|manager`, and a role word that is not one token is still left out, so its entry is kept.
