section: Fixed

- **A stacked step is no longer turned away for main's plan edits.** The door
  compared a stacked pull request's plan with the tip of the step below as it
  stood when the stack was made; once that step merged main into itself, a
  plan edit main had brought (here #13540) read as the session's trespass.
  The door now passes when either the recorded tip or the merge base with
  main explains the change, and `mc merge` stops reading `stacked_on` once the
  step below is done (one-window-path step 7, #13554).
