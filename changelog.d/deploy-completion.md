section: Fixed

- **Clear successful deploys from the active frame.** Successful attempts
  disappear, failed attempts stay red, and only a live running attempt shows
  its pid. LIVE uses a deploy's verified production version when the cached
  reading predates the deployment, preventing an older observation from
  reporting a mismatch after a verified deploy. Newer or unordered readings
  remain visible as independent evidence.
