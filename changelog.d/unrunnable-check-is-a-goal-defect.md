section: Changed

- **A check a headless session cannot run is a goal defect, and no goal is written with one.** A check that passes through a reserved act or needs someone at a terminal is reported once with `mc goal defect` by the first build or review session that meets it. Before, a build session asked about such a check and the goal idled in `build · ready` until the runner stopped it with `no progress:` (`mc/deploy-survives-lost-terminal`), and the plan that wrote it could read "No check waits for Martin" as met.
