section: Fixed

- **`mc build ios --testflight` runs the App Store Connect script with
  origin/main's helpers, however far behind memoro's checkout is.** mc used to
  pipe `scripts/asc-list-builds.mjs` from origin/main on stdin and let its
  relative imports resolve in the checkout. With the checkout 57 commits
  behind, the import of `./lib/dev-vars-path.mjs` (memoro #14383) found nothing,
  and the verb said `App Store Connect did not answer
  (node:internal/modules/esm/resolve:274)`. Now `scripts/` is written out from
  origin/main into a temporary directory that uses the checkout's
  `node_modules`. A failure names the error line rather than the first line,
  and says the build numbers could not be read rather than that App Store
  Connect did not answer.
