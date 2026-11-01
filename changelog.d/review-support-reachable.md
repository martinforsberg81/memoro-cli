section: Changed

- **Review support needs only the tools that can review.** `mc programme
  capabilities` holds `review` to the observation of the catalog's reviewer,
  plus the reviewer of any goal that has not landed and holds a reservation. A
  codex build tool no longer blocks review support on a claude-reviewed catalog.
  `build`, `control-signals`, `interrupt`, `programme-jobs` and `programme-plan`
  still need every catalog tool, and an unreadable goal state still supports
  nothing.
