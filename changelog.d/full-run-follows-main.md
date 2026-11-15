section: Changed

- **The full run follows main.** The runner no longer waits a day between full
  runs: every chore pass asks, for each repository mc knows, whether its
  origin/main moved since the last measured full run (`fullRunDue`), and starts
  one when it did or when the runner itself cut the last one short (`gone`,
  `killed`). A run measures to the end of its list, so its verdict, its history
  row and the main-red repair request cover every red it found, not the first.
  `mc test <repo> --full` typed by hand hands its reds to the same repair. No
  flag, exit code or file format changes; the `cadence` value in the status JSON
  stays `daily` and nothing reads it.
