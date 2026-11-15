section: Added

- **A rule area can say that work on it is judged as the user sees it.**
  `"seen": true` on an area in `.mc/areas.json` is shown by `mc goal areas`.
  The goal review of a version 2 goal that stands `touched` on such an area,
  or trips it, is told so and cannot leave review without a `seen <area>` line
  in REVIEW.md: the screenshots it judged, kept under `shots/` in the goal's
  directory, or `none` with the reason. mc checks the line and that each file
  exists, not what it shows. The plan review asks an eighth question of a goal
  that stands `touched` on such an area: the intended result per viewport, the
  `mc shot` check, and what the goal reuses and adds. Before this, neither
  review could tell an interface area from any other.
