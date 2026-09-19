section: Added

- **A session has a scratch directory outside its worktree.** A killed
  session's throwaway measuring script is an untracked file, and an untracked
  file is a dirty worktree that stops the project until a person deletes it:
  `mail-window-overlay-integrity` stood 31 rounds on three `*.tmp.mjs` files,
  `connections-section` 12 rounds on two probes. The check is right and stays;
  what was missing was somewhere else to put such a file. Every session the
  runner starts now gets `MC_SCRATCH=~/mc/runner/scratch/<project>-<stamp>/`, an
  existing directory, `canon/roles/_common.md` tells it to keep probes there,
  and the chore pass removes scratch directories older than seven days.
