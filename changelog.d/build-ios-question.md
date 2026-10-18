section: Added

- **`mc build ios` says whether memoro needs a new iOS binary.** The app loads
  its web code live from production, so only the native layer pairs with a
  commit. The verb compares the last shipped build (`~/mc/runner/log/ios-builds.tsv`)
  with the commit production runs, restricted to the native paths and packages
  memoro declares in `.mc/ios.json`, and says which changed, or that
  `mc deploy` is enough. It builds nothing. `mc build ios --shipped <build> <sha>`
  records a binary built before the verb existed.
