section: Fixed

- **Correct mc-admin source ages.** Measure fetch time and source ages after
  both responses arrive, avoiding false future-timestamp warnings caused by
  request latency.
