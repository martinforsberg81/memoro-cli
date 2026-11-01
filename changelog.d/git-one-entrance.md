section: Changed

- **Every git process mc starts goes through `src/mc/git.js`.** `run(cwd, args,
  options)` and `runAsync` answer in the shape `spawnSync` gives, and the 55
  places that spawned git themselves — `spawnSync('git')`, `execFile`,
  `runTool('git')`, `sh('git')` in run.js, `sessionGit`, `captureWorktree`'s
  isolated-index calls — now call them, keeping their own names, signatures
  and return shapes. One entrance so a test can stand in for all of git at
  once: `useGitRunner(fn)` replaces the process for the current process, and
  `tests/mc/_helpers/fake-git.js` is a repository model that answers every
  command the suite was measured to ask (init, add, commit, clone --bare,
  fetch, push, ls-remote, switch, worktree, rev-parse, ls-files, write-tree,
  merge-base, diff, status, log …) from memory and the files on disk, with
  real content identity and a loud error for anything it does not know.
  `tests/mc/fake-git.test.js` is the first test file whose git-call count is
  0. One deliberate change: git calls that had no time limit now have
  git.js's five minutes. Martin, 2026-11-01: tests make no git call.
