section: Added

- **Inactive v2 build continuation and crash recovery.** Verified published
  handoffs release a fresh build for remaining premerge criteria, or stop at
  review-ready when all are reported done. Interrupted publication reconciles
  the measured commit, remote and same PR without another implementation
  session. Live/unknown workers retain ownership; incomplete and out-of-scope
  attempts stay durably plan-pending with unsent work preserved. V2 never uses
  legacy failed-to-person or automatic archive. Live execution remains disabled.
