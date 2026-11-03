section: Fixed

- **`mc shot` and `mc shot next` read action receipts consistently.** A full
  `acted` list acknowledges every action kind, while the legacy `clicked` list
  remains accepted for all-click requests. Missing or partial receipts are no
  longer confused with a failed step or unsupported actions. A thrown `--eval`
  still prints its `eval <n>  threw:` line and now exits 1.
