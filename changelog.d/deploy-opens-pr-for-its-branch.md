section: Added

- **`mc deploy` lands a branch the deploy script made.** When the script's
  output ends with `Deploy branch: <branch>`, the deployer opens a pull request
  from that branch to `main`, queues it for the merger the way `mc publish`
  does, and names the pull request in its output and in the note of the deploy's
  row in `deploys.tsv`. The script produces such a branch when it had to change
  a tracked file while deploying, so that its checkout still ends clean on
  `main`. Failing to open or queue the pull request is reported and changes
  neither the exit code nor the recorded outcome; no branch line opens nothing.
