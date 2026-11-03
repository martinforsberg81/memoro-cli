section: Fixed

- **`mc asc status`, `release` and the other script subverbs print their
  answer again.** They exited 0 having printed nothing. `atRev` wrote
  origin/main's scripts out under `tmpdir()`, which on macOS is
  `/var/folders/…`, a symlink to `/private/var/folders/…`; Node resolves a
  module's `import.meta.url` through it, so memoro's scripts, which run
  `main()` only when `import.meta.url` is `pathToFileURL(process.argv[1])`,
  never ran it. The directory is now its real path.
