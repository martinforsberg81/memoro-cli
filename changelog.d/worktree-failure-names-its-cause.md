section: Fixed

- **A worktree that git refuses now says what git said, and leaves nothing
  behind.** `mc plan mc` answered `mc: could not add memoro to mc (Preparing
  worktree (new branch 'mc'))` and left an empty `~/mc/mc/` standing. Neither
  half was right. `git worktree add` narrates before it fails — that
  parenthesis is always its first line of stderr — and `addWorktree` reported
  the first non-empty line, so every worktree failure came back wearing the
  progress message that preceded it. The line under it was the answer:
  `fatal: 'refs/heads/mc/github-write-flag' exists; cannot create
  'refs/heads/mc'` — a branch cannot be called `mc` while `mc/` is a directory
  in the ref namespace, which is a real and fixable thing to be told. The
  diagnosis is now asked for by name (git prefixes one with `fatal:` or
  `error:`) and the narration only stands in when there is none.
  The directory was the second half: the area is made before the checkout,
  because `git worktree add` wants its parent to exist, so a failed add left a
  folder that existed only because something went wrong — and the next `mc`
  counted it among the workareas nobody is working on. `addWorktree` and
  `mc plan`'s `ensurePlanArea` now take back an area they made and could not
  fill. Only that one: `rmdirSync` refuses a directory that is not empty, so
  an area that was already there, or that anything at all arrived in, is kept.
