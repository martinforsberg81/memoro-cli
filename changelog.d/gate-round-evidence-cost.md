section: Fixed

- Merge timeouts now name the active phase and preserve timings from completed
  batches. A later command or own-test timeout no longer labels the completed
  selection unfinished. PR rounds no longer replay main or walk its history:
  they read only previously measured exact-base standing failures, with matching
  names and diagnostics in unchanged test files. Missing evidence stays red
  without attributing the failure to the PR or spending time investigating main.
