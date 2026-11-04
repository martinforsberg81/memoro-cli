section: Changed

- **Run trusted scripts with shared dotenv entries.** `mc keys` now reads the
  shared `.dev.vars` source for each invocation and supplies all eligible
  entries to trusted Node scripts, replacing per-script vault declarations
  and source-closure checks.
