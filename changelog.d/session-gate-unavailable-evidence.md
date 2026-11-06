section: Fixed

- **Local gates retain unavailable command evidence without reporting a complete green.** An exact selector-declared unavailable exit remains nonblocking, but the check identity and exit are recorded; human output says INCOMPLETE and JSON distinguishes process success from complete passing evidence. Incomplete receipts remain ineligible for green reuse.
- Aborts, ceilings and content invalidation override successful progress metadata with a red, nonblocking-false, incomplete result while retaining collected command evidence.
