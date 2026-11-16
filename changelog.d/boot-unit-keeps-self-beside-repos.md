section: Fixed

- **A runner started at boot finds the shared checkout again.** The Linux boot
  unit wrote `MC_REPOS_HOME=<root>/repos` when the starting environment had
  none, and the runner and every session it launched inherited it. Since
  `MC_REPOS_HOME` moves the primary checkouts, the bare repositories and
  `self/` together, `self/` resolved to `~/mc/repos/self`, which does not
  exist, so `mc shot dev --main` and `--compare main` answered `no memoro
  checkout to serve — ~/mc/self/memoro is missing` while `~/mc/self/memoro`
  stood there. The unit now carries `MC_REPOS_HOME` only when the start set it.
  A runner already running keeps the old variable until its next explicit
  `mc run start`, which also rewrites the unit.
