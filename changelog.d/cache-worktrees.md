section: Fixed

- **The prepare cache keys on what changes an install, and keeps four
  entries.** `prepareCacheKey` hashed the whole `package.json` and the full
  node version, so a version bump, a new script or a node patch release
  meant a fresh `npm ci` (15-300 s) for an identical tree. It now hashes the
  lockfile, the install fields (`INSTALL_FIELDS`: the dependency maps,
  `overrides`, `engines`, `workspaces`, `packageManager`,
  `bundleDependencies`), node's major version and ABI, and the platform and
  arch. Scripts are no longer in the key, so a `preinstall` or `install`
  script now keeps the cache out, as `postinstall` and `prepare` already
  did. `PREPARE_CACHE_KEEP` is 4 instead of 2, so main's entry survives a
  lockfile-changing pull request or two.
- **A failed `npm ci` of the shared tree is no longer reported `current`.**
  `work-deps.js` wrote the lockfile and manifest copies before installing,
  so a failed install left them matching and the next caller skipped the
  install. A tree now counts as current only if it carries `.mc-installed`,
  which is written after a successful install. A tree from before this
  change has no mark and is installed once more.
- **The merger no longer flips `~/mc/node_modules` under live sessions.** A
  candidate whose lockfile differs from the shared tree's is now installed
  in the candidate's own `node_modules`, which goes away with the worktree,
  and the shared tree is left alone (`ensureWorkDeps({ ownTree })`). Before,
  the round reinstalled the shared tree at the pull request's lockfile and
  left it there.
