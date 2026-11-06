section: Added

- **Show the current deploy step on the mc page.** The detached deployer
  publishes the script's observed step and phase, from preparation and builds
  through publishing and live verification. A small phase bar accompanies
  progress on row two; status and pid stay on row one for merges and deploys.
  Progress is matched to the deployment attempt so an older run cannot supply
  the current step. Missing evidence stays unknown; the bar is not a percentage.
