section: Changed

- **A deploy holds the heavy lane while it builds.** On 2026-10-18 the merger
  waited behind a deploy as it should, but session `mc gate` runs went on beside
  the bundle, and the deploy took 40 minutes instead of two. The deployer now
  takes the heavy gate lock (`mode: 'deploy'`) once the rounds in flight are
  done and gives it back when the script ends; a `mc gate` started meanwhile
  waits for it in its own log before running its tests.
