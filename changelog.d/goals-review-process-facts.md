section: Fixed

- **Autonomous review process facts survive interruption.** Immutable review
  manifests and generation-bound spawn, terminal and report facts preserve
  ownership when processes or tools are live or unknown. Native process closure
  and a complete transport result are required before a clean report; the report
  is persisted before owner release. Execution remains inactive.
