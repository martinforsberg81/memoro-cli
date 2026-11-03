section: Changed

- **`mc asc` holds everything about App Store Connect; `mc build ios` is gone.**
  Releasing memoro 1.1.1 needed the state of a version and a release, and no
  verb had either, so a session wrote throwaway scripts and had to be told
  where the secrets file lives. `mc asc build` is what `mc build ios` was,
  unchanged, against the same `~/mc/runner/log/ios-builds.tsv`. Next to it:
  `mc asc status [<version>]` reads each iOS version's state, build, phased
  release, latest review and the storefront version in us/se/dk;
  `mc asc metadata | screenshots | review-notes | iap [--dry-run]` run the
  syncs; `mc asc submit <version> <build>` and `mc asc release <version>
  [--phased]` read first (`--dry-run --json`), refuse a version in the wrong
  state, then ask one question at the terminal, and without a terminal refuse
  with exit 2 before anything runs. Each runs the script memoro's
  `.mc/ios.json` declares, as `origin/main` has it together with its
  `script_paths` (`marketing/`). mc still reads no key: the script reads it
  from the file `MEMORO_DEV_VARS` names. `mc build` has no alias.
