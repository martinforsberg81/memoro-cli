section: Added

- **Inactive autonomous review-to-plan outcomes.** The trusted runner can hand
  a fully admitted clean independent report to the existing merger without a
  new approval session. Durable idempotent report, admission, failure/unknown
  and landing events preserve crash recovery. Autonomous reds return to plan
  without legacy mend/retry jobs; v1 behavior is unchanged. Landing never
  confirms or auto-archives the goal, and post-integration checks stay pending.
